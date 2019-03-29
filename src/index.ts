import Octokit from '@octokit/rest'
import dotenv from 'dotenv'
import got from 'got'
import { DateTime } from 'luxon'
import pluralize from 'pluralize'
import memoize from 'memoizee'
import { scheduleJob } from 'node-schedule'

dotenv.config()

const {
  GITHUB_TOKEN,
  GITHUB_ORG,
  SLACK_CHANNEL,
  CLUBHOUSE_ACCOUNT,
  SLACK_WEBHOOK,
  SCHEDULE,
} = process.env

const CLUBHOUSE_URL = `https://app.clubhouse.io/${CLUBHOUSE_ACCOUNT}/story/`

const COLOR_OPEN = '#aaa'
const COLOR_PAST_DEADLINE = 'warning'
const COLOR_INVALID = 'danger'
const COLOR_APPROVED = 'good'

const PR_DEADLINE = DateTime.local().minus({ days: 2 })

const github = new Octokit({
  auth: `token ${GITHUB_TOKEN}`,
})

interface Review {
  approvedBy: string,
}

const parseReview = (data: any): Review => {
  const { user } = data
  return {
    approvedBy: user.login,
  }
}

const getApprovedReview = async (pullRequest: PullRequest) => {
  const res = await github.pulls.listReviews({
    owner: GITHUB_ORG,
    repo: pullRequest.repo,
    number: pullRequest.id,
  })

  const review = res.data.find((review) => review.state === 'APPROVED')
  if (review == null) {
    return null
  }

  return parseReview(review)
}

interface PullRequest {
  id: number,
  url: string,
  repo: string,
  title: string,
  author: string,
  commentCount: number,
  createdAt: DateTime,
  updatedAt: DateTime,
  body: string,
  summary: string,
}

interface PullRequestExtras {
  filesChanged: number,
  branch: string,
  isDraft: boolean,
}

type ExtendedPullRequest = PullRequest & PullRequestExtras

const parsePullRequest = (data: any): PullRequest => {
  const {
    number,
    html_url: url,
    title,
    user,
    comments,
    created_at: createdAt,
    updated_at: updatedAt,
    body: rawBody,
  } = data

  const body = rawBody != null ? rawBody : ''
  const summary = body.trim().split('\n')[0]

  const repo = url.split('/')[4]

  return {
    id: number,
    url,
    repo,
    title,
    author: user.login,
    commentCount: comments,
    createdAt: DateTime.fromISO(createdAt),
    updatedAt: DateTime.fromISO(updatedAt),
    body,
    summary,
  }
}

const parsePullRequestExtras = (data: any): PullRequestExtras => {
  const { changed_files: filesChanged, head, mergeable_state: state } = data
  return {
    filesChanged,
    branch: head.ref,
    isDraft: state === 'draft',
  }
}

const getExtendedPullRequest = async (
  pullRequest: PullRequest,
): Promise<ExtendedPullRequest> => {
  const { repo, id } = pullRequest
  const res = await github.pulls.get({ owner: GITHUB_ORG, repo, number: id })
  return {
    ...parsePullRequest(res.data),
    ...parsePullRequestExtras(res.data),
  }
}

const getOpenPullRequests = async () => {
  const res = await github.search.issuesAndPullRequests({
    q: `is:pr state:open user:${GITHUB_ORG}`,
  })

  return res.data.items
    .map(parsePullRequest)
    .sort((a: PullRequest, b: PullRequest) => {
      return a.updatedAt.diff(b.updatedAt).valueOf()
    })
}

interface Comment {
  author: string,
  body: string,
}

const parseComment = (data: any): Comment => {
  const { user, body } = data
  return {
    author: user.login,
    body,
  }
}

const getComments = async (pullRequest: PullRequest) => {
  const res = await github.issues.listComments({
    owner: GITHUB_ORG,
    repo: pullRequest.repo,
    number: pullRequest.id,
  })

  return res.data.map(parseComment)
}

interface User {
  username: string,
  name: string,
  avatar: string,
  url: string,
}

const parseUser = (data: any): User => {
  const { html_url: url, avatar_url: avatar, login, name } = data
  return {
    username: login,
    name: name || login,
    avatar,
    url,
  }
}

const forceGetUser = async (username: string) => {
  const res = await github.users.getByUsername({ username })
  return parseUser(res.data)
}

const getUser = memoize(forceGetUser, { promise: true })

const CH_COMMENT_REGEX = /\[ch(\d+)\]/
const CH_BRANCH_REGEX = /ch(\d+)/

const matchClubhouseLink = (text: string, regex: RegExp) => {
  const match = text.match(regex)
  if (match != null) {
    const storyId = match[1]
    return {
      storyId,
      url: `${CLUBHOUSE_URL}${storyId}`,
    }
  }
  return null
}

const getClubhouseDetails = async (pullRequest: ExtendedPullRequest) => {
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

const postToSlack = async (options: object) => {
  await got(SLACK_WEBHOOK, { method: 'POST', body: JSON.stringify(options) })
}

interface PostPullRequestToSlackOptions {
  pullRequest: ExtendedPullRequest,
  author: User,
}

const postPullRequestToSlack = async (
  options: PostPullRequestToSlackOptions,
) => {
  const { pullRequest, author } = options
  const {
    title,
    url,
    summary,
    updatedAt,
    commentCount,
    filesChanged,
  } = pullRequest

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

  const text = [...warnings, summary, ...messages]
    .filter((line) => line.trim().length > 0)
    .join('\n')

  await postToSlack({
    channel: SLACK_CHANNEL,
    attachments: [
      {
        ts: updatedAt.toSeconds(),
        fallback: title,
        color,
        author_name: author.name,
        author_link: author.url,
        author_icon: author.avatar,
        title: title,
        title_link: url,
        text,
        footer: `${commentCount} ${pluralize(
          'comment',
          commentCount,
        )}. ${filesChanged} ${pluralize('file', filesChanged)} changed.`,
      },
    ],
  })
}

const start = async () => {
  const pullRequests = await getOpenPullRequests()
  for (const pr of pullRequests) {
    const author = await getUser(pr.author)
    const pullRequest = await getExtendedPullRequest(pr)
    if (pullRequest.isDraft === false) {
      await postPullRequestToSlack({ pullRequest, author })
    }
  }
}

if (SCHEDULE) {
  const job = scheduleJob(SCHEDULE, async () => {
    console.log('Running...')
    await start()
    console.log(`Next run at: ${job.nextInvocation().toLocaleString()}`)
  })

  console.log(`Next run at: ${job.nextInvocation().toLocaleString()}`)
} else {
  start().catch(console.error)
}
