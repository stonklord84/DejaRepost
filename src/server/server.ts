import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit} from '@devvit/web/server'
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type GetCounterRsp,
  type IncCounterReq,
  type IncCounterRsp,
} from '../shared/api.ts'
import {dbGetCounter, dbIncCounter} from './db.ts'

import {extractFrames} from './decodeFrames.ts'

import { read } from 'node:fs'
//import { count } from 'node:console'
//import { postMessageToThread } from 'node:worker_threads'

type AnyRsp =
  | GetCounterRsp
  | IncCounterRsp
  | UiResponse
  | TriggerResponse
  | ErrorRsp

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpoint = reqMsg.url?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.GetCounter:
        rsp = await routeGetCounter()
        break
      case Endpoint.IncCounter:
        rsp = await routeInc(reqMsg)
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      case Endpoint.OnPostSubmit:
        rsp = await newPostSubmitted(reqMsg)
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}
async function newPostSubmitted(reqMsg: IncomingMessage){
  console.log('New Post Submitted')
  async function delayTime(ms: number){
    return new Promise((resolve)=>{
      setTimeout(resolve, ms)
    })
  }
  const sub = context.subredditName
  const req = await readJson(reqMsg)
  console.log('this is req: ', req)
  console.log('--------------------------------')
  const postId = (req as any).post?.id
  let postMetaInfo = await reddit.getPostById(postId)
  let tries = 3
  let countDown = 3
  if (!postMetaInfo){
    console.log('secureMedia is not loaded, waiting for 3 seconds...')
  }
  while (!postMetaInfo.secureMedia && tries > 0){
    console.log(String(countDown) + '...')
    await delayTime(1000)
    countDown -= 1;
    if (countDown == 0){
      tries -= 1
      countDown = 3
      postMetaInfo = await reddit.getPostById(postId)
      console.log('SecureMedia still not loaded! restarting timer...')
    }
  }
  console.log(postMetaInfo.secureMedia ?? 'unfortunately, secureMedia did not load!')
  // const fallBackUrl = postMetaInfo.secureMedia?.redditVideo?.fallbackUrl
  // console.log(fallBackUrl, 'this is the fallbackurl')

  const posts = await reddit.getNewPosts({
    subredditName: sub,
    limit: 2,
    pageSize: 100
  }).all();
  let fallBackUrls: string[] = []
  console.log('this should be 2: ', posts.length)
  for (const post of posts){
    console.log(post.title)
    let currPostId = post.id
    let currPostMetaInfo = await reddit.getPostById(currPostId)
    let currFallBackUrl = currPostMetaInfo.secureMedia?.redditVideo?.fallbackUrl
    if (typeof currFallBackUrl === 'string'){
      fallBackUrls.push(currFallBackUrl)
    }
  }
  console.log('this is the fallbackurls: ', fallBackUrls, ' <- right here')
  for (const url of fallBackUrls) {
    try {
      const res = await fetch(url)
      const buf = new Uint8Array(await res.arrayBuffer())
      console.log(`fetched ${url} -> status ${res.status}, ${buf.byteLength} bytes`)

      // const frames = await extractFrames(buf, 1)
      // console.log(
      //   `decoded ${frames.length} frame(s) from ${url}:`,
      //   frames.map(f => f.byteLength),
      // )
    } catch (err) {
      console.log(`pipeline FAILED for ${url}:`, err instanceof Error ? err.stack : err)
    }
  }
  // for (const post of posts){
  //   const thumbnail = await post.thumbnail?.url
  //   if(thumbnail){
  //     console.log('hey, this post has a thumbnail!(forgot to print this damn thing last time)', thumbnail)
  //     console.log('also, this is the post title: ', post.title)
  //   }
  // }
  return {res: 'this is a new post'}
}
async function routeGetCounter(): Promise<GetCounterRsp> {
  const t3 = context.postId
  if (!t3) throw Error('no t3')
  return {count: await dbGetCounter(t3)}
}

async function routeInc(reqMsg: IncomingMessage): Promise<IncCounterRsp> {
  const t3 = context.postId
  if (!t3) throw Error('no t3')
  const req = await readJson<IncCounterReq>(reqMsg)
  return {count: await dbIncCounter(t3, req.amount)}
}

async function routeMenuNewPost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({title: context.appSlug})
  return {
    showToast: {text: `Post ${post.id} created.`, appearance: 'success'},
    navigateTo: post.url,
  }
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  reqMsg.on('data', chunk => chunks.push(chunk))
  await once(reqMsg, 'end')
  return JSON.parse(`${Buffer.concat(chunks)}`)
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
