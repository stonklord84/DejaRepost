import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit, redis, scheduler} from '@devvit/web/server'
import { compareVideoHashes, dHash, hammingDistance, normalizeText, shingle, simHash } from './compare.ts'
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

import {extractFrames, extractImage} from './decodeFrames.ts'
import { settings } from '@devvit/web/server'
import { diff } from 'node:util'
import { timingSafeEqual } from 'node:crypto'

const expiry_time = 90

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
    limit: 900,
    subredditName: (req as any).data?.subredditName,
    pageSize: 100
  }).all()
  let reference_sheet: any = {}
  let posts_and_urls: any = {}
  let timeSetting
  timeSetting = await settings.get('timeThreshold') ?? 2
  for (const post of newPosts){
    let postDate = post.createdAt
    let currDate = Date.now()
    let differenceMS = currDate - postDate.getTime()
    let differenceDays = differenceMS / (1000 * 60 * 60 * 24)
    if (differenceDays > Number(timeSetting)) break
    reference_sheet[post.id] = post.title
    let post_url = post.url?.toLowerCase() ?? ''
    let isImage = (post_url.endsWith('.png') || post_url.endsWith('.jpg') || post_url.endsWith('gif') || post_url.includes('i.redd.it')) 
    if (post.secureMedia?.redditVideo){
      console.log('===============')
      console.log('this is a video post', post.title)
      if (!posts_and_urls[post.id]){
        posts_and_urls[post.id] = [post.secureMedia.redditVideo?.fallbackUrl, 'video']
      }
    }
    else if (isImage){
      console.log('image post alert: ', post.title)
      console.log(post.url, '<- url')
      posts_and_urls[post.id] = [post.url, 'img']
    }
    else{
      console.log('text post bro', post.title)
      posts_and_urls[post.id] = [post.title, 'txt']
    }
  }
  console.log(posts_and_urls.length, 'this should not be long!!!!')
  for (const post_id of Object.keys(posts_and_urls)){
    if (posts_and_urls[post_id][1] == 'video'){
      let video: Uint8Array[] = []
      const res = await fetch(posts_and_urls[post_id][0])
      const buf = await res.arrayBuffer()
      video = await extractFrames(new Uint8Array(buf))
      //im thinking maybe ill store the video inside redis
      console.log(post_id, video.length, '<= video length')
      //yeah ill store the video variable, with key postid!
      //nah, lets fingerprint them all... yeah.
      for (const [i, frame] of video.entries()){
        await redis.hSet(`vid${post_id}`, {[String(i)]: dHash(frame).toString()})
      }
      await redis.expire(`vid${post_id}`, expiry_time*24*60*60)
    }
    else if (posts_and_urls[post_id][1] == 'img'){
      let img: Uint8Array
      let res = await fetch(posts_and_urls[post_id][0])
      let buf = await res.arrayBuffer()
      img = await extractImage(new Uint8Array(buf), posts_and_urls[post_id][0])
      await redis.set(`img${post_id}`, dHash(img).toString())
      await redis.expire(`img${post_id}`, expiry_time*24*60*60)
      //await extractImage(buf, posts_and_urls[post_id])
      // im gonna write a new get image function!
    }
    else if (posts_and_urls[post_id][1] == 'txt'){
      let normalizedText = normalizeText(posts_and_urls[post_id][0])
      let shingleList = shingle(normalizedText)
      let similarityHash = simHash(shingleList)
      await redis.set(`txt${post_id}`, similarityHash.toString())
      await redis.expire(`txt${post_id}`, expiry_time*24*60*60)
    }

  }
  console.log(posts_and_urls, 'this is the posts_and_urls dictionary')
  console.log(reference_sheet, 'this is the ref sheet')
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
  const recent_post_ids: string[] = []
  let temp_repost_dict: Record<string, number> = {}
  let post_url = postMetaInfo.url?.toLowerCase()
  let newPosts = await reddit.getNewPosts({
      subredditName: context.subredditName,
      limit: 4000,
      pageSize: 40
    }).all()
  newPosts = newPosts.slice(1)
  let timeSetting
  timeSetting = await settings.get('timeThreshold') ?? 2
  console.log(Number(timeSetting), 'this should be 30....')

  if (postMetaInfo.secureMedia?.redditVideo){
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
    for (const post of newPosts){
      let postDate = post.createdAt
      let currDate = Date.now()
      let differenceMS = currDate - postDate.getTime()
      let differenceDays = differenceMS / (1000 * 60 * 60 * 24)
      if (differenceDays > Number(timeSetting)) break
      console.log(post.title, post.id)
      recent_post_ids.push(post.id)

      let isInDatabase = await redis.get(`vid${post.id.toString()}`)
      if (isInDatabase == undefined){
        let video: Uint8Array[] = []
        let videoUrl = post.secureMedia?.redditVideo?.fallbackUrl
        if (!videoUrl) continue
        const res = await fetch(videoUrl)
        const buf = await res.arrayBuffer()
        video = await extractFrames(new Uint8Array(buf))
        for (const [i, frame] of video.entries()){
          await redis.hSet(`vid${post.id}`, {[String(i)]: dHash(frame).toString()})
        }
        await redis.expire(`vid${post.id}`, expiry_time*24*60*60)
      }
      let redis_past_video_hashes = await redis.hGetAll(`vid${post.id.toString()}`)
      //ok, you have all the past video hashes of a specific post, time to convert them into bigint
      let past_video_hashes: bigint[] = []
      Object.values(redis_past_video_hashes).forEach((h)=> past_video_hashes.push(BigInt(h)))
      //ok, now you have an array of both pastvideo hashes... where is the current video hash again, oh yeah curr_video_hashes
      let result = compareVideoHashes(curr_video_hashes, past_video_hashes)
      let curr_title = (await reddit.getPostById(post.id)).title
      if (!temp_repost_dict[curr_title]) temp_repost_dict[curr_title] = result
    }
    for (const [hash, i] of curr_video_hashes.entries()){
      redis.hSet(`vid${postId}`, {[String(i)]: hash.toString()})
    }
    await redis.expire(`vid${postId}`, expiry_time*24*60*60)
  }


  else if (post_url.endsWith('.png') || post_url.endsWith('.jpg') || post_url.endsWith('.gif') || post_url.includes('i.redd.it')){
    let res = await fetch(postMetaInfo.url)
    let buf = await res.arrayBuffer()
    let img_frame = await extractImage(new Uint8Array(buf), post_url)
    let image_hash = dHash(img_frame)
    for (const post of newPosts){
      recent_post_ids.push(post.id)
      // compare post with image_hash
      // so i have to get the hash of post_id
      // but only if it starts with img
      let postDate = post.createdAt
      let currDate = Date.now()
      let differenceMS = currDate - postDate.getTime()
      let differenceDays = differenceMS / (1000 * 60 * 60 * 24)
      if (differenceDays > Number(timeSetting)) break
      let isInDatabase = await redis.get(`img${post.id}`)
      if (isInDatabase == undefined){
        let img: Uint8Array
        let imgUrl = post.url
        let isImage = (imgUrl.endsWith('.png') || imgUrl.endsWith('.jpg') || imgUrl.endsWith('gif') || imgUrl.includes('i.redd.it')) 
        if (!isImage) continue;
        let res = await fetch(imgUrl)
        let buf = await res.arrayBuffer()
        img = await extractImage(new Uint8Array(buf), imgUrl)
        await redis.set(`img${post.id}`, dHash(img).toString())
        await redis.expire(`img${post.id}`, expiry_time*24*60*60)
      }
      let redis_past_hash: string
      redis_past_hash = await redis.get(`img${post.id.toString()}`) ?? ''
      let hamming = 0
      if (redis_past_hash != ''){
        hamming = Math.round(100 - ((hammingDistance(BigInt(redis_past_hash), image_hash) / 64) * 100))
      }
      let curr_title = post.title
      if (!temp_repost_dict[curr_title]) temp_repost_dict[curr_title] = hamming
    }
    redis.set(`img${postId}`, `${image_hash}`)
    await redis.expire(`img${postId}`, expiry_time*24*60*60)


  } else if (postMetaInfo.body != undefined){
    let curr_normalized = normalizeText(postMetaInfo.title)
    let curr_shingle = shingle(curr_normalized)
    let curr_simhash = simHash(curr_shingle)
    for (const post of newPosts){
      let postDate = post.createdAt
      let currDate = Date.now()
      let differenceMS = currDate - postDate.getTime()
      let differenceDays = differenceMS / (1000 * 60 * 60 * 24)
      if (differenceDays > Number(timeSetting)) break

      let isInDataBase = await redis.get(`txt${post.id}`)
      if (isInDataBase == undefined){
        let curr_normalized = normalizeText(post.title)
        let curr_shingle = shingle(curr_normalized)
        let curr_simhash = simHash(curr_shingle)
        await redis.set(`txt${post.id}`, curr_simhash.toString())
        await redis.expire(`txt${post.id}`, expiry_time*24*60*60)
      }
      let past_simhash = await redis.get(`txt${post.id.toString()}`) ?? ''
      let hamming = 0
      if (past_simhash != ''){
        hamming = Math.round(100 - ((hammingDistance(BigInt(past_simhash), curr_simhash) / 64) * 100))
      }
      if (!temp_repost_dict[post.title]) temp_repost_dict[post.title] = hamming
    }
    await redis.set(`txt${postId.toString()}`, curr_simhash.toString())
    await redis.expire(`txt${postId}`, expiry_time*24*60*60)
  }
  //ok, so we got postMetainfo.secureMedia now
  //now get its hash

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
