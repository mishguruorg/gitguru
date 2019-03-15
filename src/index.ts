import Octokit from '@octokit/rest'
import dotenv from 'dotenv'
import got from 'got'
import { DateTime } from 'luxon'
import pluralize from 'pluralize'
import memoize from 'memoizee'
import { scheduleJob } from 'node-schedule'

dotenv.config()

const { GITHUB_TOKEN, GITHUB_ORG, SLACK_CHANNEL, CLUBHOUSE_ACCOUNT, SLACK_WEBHOOK, SCHEDULE } = process.env

const CLUBHOUSE_URL = `https://app.clubhouse.io/${CLUBHOUSE_ACCOUNT}/story/`

const COLOR_OPEN = '#aaa'
const COLOR_PAST_DEADLINE = 'warning'
const COLOR_INVALID = 'danger'
const COLOR_APPROVED = 'good'

const PR_DEADLINE = DateTime.local().minus({ days: 2 })

const github = new Octokit({
  auth: `token ${GITHUB_TOKEN}`
})

type Review = {
  approvedBy : string
}

const parseReview = (data : any) : Review => {
  const { user } = data
  return {
    approvedBy: user.login,
  }
}

const getApprovedReview = async (pullRequest : PullRequest) => {
  const res = await github.pulls.listReviews({
    owner: GITHUB_ORG,
    repo: pullRequest.repo,
    number: pullRequest.id
  })

  const review = res.data.find((review) => review.state === 'APPROVED')
  if (review == null) {
    return null
  }

  return parseReview(review)
}

const parsePullRequestExtras = (data : any) : PullRequestExtras => {
  const { changed_files, head } = data
  return {
    filesChanged: changed_files,
    branch: head.ref
  }
}

const getExtendedPullRequest = async (pullRequest : PullRequest) : Promise<ExtendedPullRequest> => {
  const { repo, id } = pullRequest
  const res = await github.pulls.get({ owner: GITHUB_ORG, repo, number: id })
  return {
    ...parsePullRequest(res.data),
    ...parsePullRequestExtras(res.data)
  }
}

type PullRequest = {
  id : number
  url : string
  repo : string
  title : string
  author : string
  commentCount : number
  createdAt : DateTime
  updatedAt : DateTime
  body : string
  summary : string
}

type PullRequestExtras = {
  filesChanged : number
  branch : string
}

type ExtendedPullRequest = PullRequest & PullRequestExtras

const parsePullRequest = (data : any) : PullRequest => {
  const { number, html_url, title, user, comments, created_at, updated_at, body } = data

  const repo = html_url.split('/')[4]

  return {
    id: number,
    url: html_url,
    repo,
    title,
    author: user.login,
    commentCount: comments,
    createdAt: DateTime.fromISO(created_at),
    updatedAt: DateTime.fromISO(updated_at),
    body,
    summary: body.split('\n')[0]
  }
}

const getOpenPullRequests = async () => {
  const res = await github.search.issuesAndPullRequests({
    q: `is:pr state:open user:${GITHUB_ORG}`
  })

  return res.data.items
    .map(parsePullRequest)
    .sort((a : PullRequest, b : PullRequest) => {
      return a.updatedAt.diff(b.updatedAt).valueOf()
    })
}

type Comment = {
  author : string,
  body : string
}

const parseComment = (data : any) : Comment => {
  const { user, body } = data
  return {
    author: user.login,
    body
  }
}

const getComments = async (pullRequest : PullRequest) => {
  const res = await github.issues.listComments({
    owner: GITHUB_ORG,
    repo: pullRequest.repo,
    number: pullRequest.id
  })

  return res.data.map(parseComment)
}

type User = {
  username : string
  name : string
  avatar : string
  url : string
}

const parseUser = (data : any) : User => {
  const { html_url, avatar_url, login, name } = data
  return {
    username: login,
    name,
    avatar: avatar_url,
    url: html_url
  }
}

const forceGetUser = async (username : string) => {
  const res = await github.users.getByUsername({ username })
  return parseUser(res.data)
}

const getUser = memoize(forceGetUser, { promise: true })

const CH_COMMENT_REGEX = /\[ch(\d+)\]/
const CH_BRANCH_REGEX = /ch(\d+)/

const matchClubhouseLink = (text : string, regex : RegExp) => {
  const match = text.match(regex)
  if (match != null) {
    const storyId = match[1]
    return {
      storyId,
      url: `${CLUBHOUSE_URL}${storyId}`
    }
  }
  return null
}

const getClubhouseDetails = async (pullRequest : ExtendedPullRequest) => {
  const { body, branch } = pullRequest

  {
    const match = matchClubhouseLink(branch, CH_BRANCH_REGEX)
    if (match != null) {
      return match
    }
  }

  {
    const match = matchClubhouseLink(body, CH_COMMENT_REGEX)
    if (match != null) {
      return match
    }
  }

  {
    const comments = await getComments(pullRequest)
    for (const comment of comments) {
      const match = matchClubhouseLink(comment.body, CH_COMMENT_REGEX)
      if (match != null) {
        return match
      }
    }
  }

  return null
}

const postToSlack = async (options : object) => {
  await got(SLACK_WEBHOOK, { method: 'POST', body: JSON.stringify(options) })
}

type PostPullRequestToSlackOptions = {
  pullRequest : ExtendedPullRequest
  author : User
}

const postPullRequestToSlack = async (options : PostPullRequestToSlackOptions) => {
  const { pullRequest, author } = options
  const { repo, title, url, summary, updatedAt, commentCount, filesChanged } = pullRequest

  const clubhouse = await getClubhouseDetails(pullRequest)

  let warnings = []
  let messages = []
  let color = COLOR_OPEN

  const review = await getApprovedReview(pullRequest)
  if (review != null) {
    color = COLOR_APPROVED
    const approvedByUser = await getUser(review.approvedBy)
    messages.push(`Approved by ${approvedByUser.name} :+1:`)
  }

  if (updatedAt <= PR_DEADLINE) {
    warnings.push('_No updates in over 2 days!_')
    color = COLOR_PAST_DEADLINE
  }

  if (summary.trim().length === 0) {
    warnings.push('_Please add a description!_')
    color = COLOR_INVALID
  }

  if (clubhouse == null) {
    warnings.push('_Please link to a clubhouse card!_')
    color = COLOR_INVALID
  } else {
    messages.push(`<${clubhouse.url}|Clubhouse card #${clubhouse.storyId}>`)
  }

  const text = [
    ...warnings,
    summary,
    ...messages
  ]
    .filter((line) => line.trim().length > 0)
    .join('\n')

  await postToSlack({
    channel: SLACK_CHANNEL,
    attachments: [{
      ts: updatedAt.toSeconds(),
      fallback: title,
      color,
      author_name: author.name,
      author_link: author.url,
      author_icon: author.avatar,
      title: title,
      title_link: url,
      text,
      footer: `${commentCount} ${pluralize('comment', commentCount)}. ${filesChanged} ${pluralize('file', filesChanged)} changed.`
    }]
  })
}

const start = async () => {
  const pullRequests = await getOpenPullRequests()
  for (const pr of pullRequests) {
    const author = await getUser(pr.author)
    const pullRequest = await getExtendedPullRequest(pr)
    await postPullRequestToSlack({ pullRequest, author })
  }
}

const job = scheduleJob(SCHEDULE, async () => {
  console.log('Running...')
  await start()
  console.log(`Next run at: ${job.nextInvocation().toLocaleString()}`)
})

console.log(`Next run at: ${job.nextInvocation().toLocaleString()}`)
