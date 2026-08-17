import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit, redis, scheduler} from '@devvit/web/server'
import { compareVideoHashes, dHash } from './compare.ts'
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
import { compareVideo } from './compare.ts'
import { getDefaultHighWaterMark } from 'node:stream'

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
      case Endpoint.OnAppInstall:
        rsp = await appInstalled(reqMsg)
        break
      case Endpoint.SeedFingerprints:
        rsp = await seedFingerprints(reqMsg)
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

async function seedFingerprints(reqMsg: IncomingMessage){
  console.log('hi, did we even get to this point?')
  const req = await readJson(reqMsg)
  console.log(req, 'this is req, read it!')
  const newPosts = await reddit.getNewPosts({
    limit: 10,
    subredditName: (req as any).data?.subredditName,
    pageSize: 100
  }).all()
  let posts_and_urls: any = {}
  for (const post of newPosts){
    if (post.secureMedia){
      if (!posts_and_urls[post.title]){
        posts_and_urls[post.title] = [post.secureMedia.redditVideo?.fallbackUrl, post.id]
      }
    }
  }
  for (const title of Object.keys(posts_and_urls)){
    let video: Uint8Array[] = []
    const res = await fetch(posts_and_urls[title][0])
    const buf = await res.arrayBuffer()
    video = await extractFrames(new Uint8Array(buf))
    //im thinking maybe ill store the video inside redis
    console.log(title, video.length, '<= video length')
    //yeah ill store the video variable, with key postid!
    //nah, lets fingerprint them all... yeah.
    for (const [i, frame] of video.entries()){
      await redis.hSet(posts_and_urls[title][1], {[String(i)]: dHash(frame).toString()})
    }
  }
  console.log(posts_and_urls, 'this is the posts_and_urls dictionary')
  return {'seed': 'seed'}
}

async function appInstalled(reqMsg: IncomingMessage){
  const req = await readJson(reqMsg)
  console.log('app installed bozo')
  await scheduler.runJob({
    name: 'seed-fingerprints',
    data: {subredditName: (req as any).subreddit?.name},
    runAt: new Date(),
  })
  return {'test': 'test'}
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
  console.log()
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
  //ok, so we got postMetainfo.secureMedia now
  //now get its hash
  const fallbackUrl = postMetaInfo.secureMedia?.redditVideo?.fallbackUrl
  const res = await fetch(fallbackUrl as string)
  const buffer = await res.arrayBuffer()
  let video: Uint8Array[] = []
  video = await extractFrames(new Uint8Array(buffer))
  // multiple hashes. ok, video is a list of Uint8Array, a list of frames basically
  // you can loop through video to get a list of hashes, ig. since that's what you have stored in uh... redis. 
  // redis.... should be in order! hopefully. well lets see, you did for ([i, frame] in video.entries()) and yeah that should be in order
  // so do the compare function, except instead of taking in 2 Uint8Array[] objects, ur taking in 2 bigint[] objects. or rather, 2 string[]
  // objects if you decide to not convert redis. lets decide this now. I will simply convert redis into bigint first cuz why do it back and forth
  // so next step is to get an array of video hashes
  let curr_video_hashes: bigint[] = []
  for (const frame of video){
    curr_video_hashes.push(dHash(frame))
  }
  //now, compare. before that, we must figure out yk getting out the hashes from our redis
  //now... i think you should still run a quick yk get 10 most recent posts, we could start with 5 tho
  //we know in redis, our hasehs are stored with keys
  const recent_post_ids: string[] = []
  let new_posts = await reddit.getNewPosts({
    subredditName: sub,
    limit: 5,
    pageSize: 20
  }).all()
  let temp_repost_dict: Record<string, number> = {}
  for (const post of new_posts){
    console.log(post.title, post.id)
    recent_post_ids.push(post.id)
    let redis_past_video_hashes = await redis.hGetAll(post.id.toString())
    //ok, you have all the past video hashes of a specific post, time to convert them into bigint
    let past_video_hashes: bigint[] = []
    Object.values(redis_past_video_hashes).forEach((h)=> past_video_hashes.push(BigInt(h)))
    //ok, now you have an array of both pastvideo hashes... where is the current video hash again, oh yeah curr_video_hashes
    let result = compareVideoHashes(curr_video_hashes, past_video_hashes)
    let curr_title = (await reddit.getPostById(post.id)).title
    if (!temp_repost_dict[curr_title]) temp_repost_dict[curr_title] = result
  }

  console.log('hopefull this thing fucking works, but the app probably wont even start lmao...')
  console.log('anyways, here is the 5 most recent posts along with their similarity indicies: ', temp_repost_dict)
  
  await reddit.submitComment({
    id: postId,
    text: `feature pending...`, 
    runAs: 'APP'
  })
  
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
