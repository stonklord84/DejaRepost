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
      case Endpoint.OnModAction:
        rsp = await modActionTaken(reqMsg)
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

async function modActionTaken(reqMsg: IncomingMessage){
  let req = await readJson(reqMsg) as any
  //console.log(req, 'this is req from modActionTaken')
  if (req.action == 'removelink'){
    let removedPostId = req.targetPost.id
    await redis.del(`txt${removedPostId}`, `img${removedPostId}`, `vid${removedPostId}`)
  }
  return {"action": "test"}
}

const DAY_MS = 24 * 60 * 60 * 1000
const SEED_BATCH = 20 //videos fingerprinted per job run
const BACKFILL_CAP = 5 //max videos onPostSubmit will fingerprint

function isVideoPost(post: any): boolean{
  return Boolean(post.url.includes('v.redd.it'))
  //return Boolean(post.secureMedia?.redditVideo?.fallbackUrl)
}

function isImagePost(post: any): boolean{
  return Boolean(
    post.url.includes('i.redd.it') ||
    post.url.endsWith('png') ||
    post.url.endsWith('jpg') ||
    post.url.endsWith('gif')
  )
}

function isSelfPost(post: any): boolean{
  return post.url.endsWith(post.permalink)
}

async function getWindowPosts(subredditName: string, days: number, hardCap = 1000): Promise<any[]>{
  const cuttoff = Date.now() - days * DAY_MS
  const out: any[] = []
  for await (const post of reddit.getNewPosts({subredditName, limit: hardCap, pageSize: 100})){
    if (post.createdAt.getTime() < cuttoff) break
    out.push(post)
  }
  return out
}

async function fingerprintVideoPost(post: any, originalpost: any): Promise<bigint[]> {
  const fallbackUrl: string = post.secureMedia.redditVideo?.fallbackUrl
  const lowres = fallbackUrl.replace(/(DASH|CMAF)_\d+/, '$1_480')
  let res = await fetch(lowres)
  if (!res.ok) res = await fetch(fallbackUrl)
  const buf = await res.arrayBuffer()
  const hashes = (await extractFrames(new Uint8Array(buf))).map((f)=>dHash(f))
  const fields: Record<string, string> = {}
  for (const [i, hash] of hashes.entries()){
    fields[i] = hash.toString()
  }
  await redis.hSet(`vid${originalpost.id}`, fields)
  await redis.expire(`vid${originalpost.id}`, expiry_time * DAY_MS / 1000) //expirey time in seconds!

  return hashes
}

async function fingerprintImagePost(post: any, originalpost: any): Promise<bigint>{
  let imgUrl = await fetch(post.url)
  let buf = await imgUrl.arrayBuffer()
  let frame = await extractImage(new Uint8Array(buf), post.url)
  let imgFingerPrint = dHash(frame)
  await redis.set(`img${originalpost.id}`, imgFingerPrint.toString())
  await redis.expire(`img${originalpost.id}`, expiry_time * DAY_MS / 1000)
  return imgFingerPrint
}

async function fingerprintTextPost(post: any, originalpost: any): Promise<bigint> {
  let postTitle = post.title
  let normalized = normalizeText(postTitle)
  let shingles = shingle(normalized)
  let textHash = simHash(shingles)
  await redis.set(`txt${originalpost.id}`, textHash.toString())
  await redis.expire(`txt${originalpost.id}`, expiry_time * DAY_MS / 1000)
  return textHash
}

async function seedFingerprints(reqMsg: IncomingMessage){
  console.log('hi, did we even get to this point?')
  const req = await readJson(reqMsg)
  const subredditName = (req as any).data?.subredditName ?? context.subredditName
  const days = Number(await settings.get('timeThreshold') ?? 30)
  const posts = await getWindowPosts(subredditName ,90)
  let done = 0
  let remaining = 0

  for (let post of posts){
    console.log(post.title, post.url, 'this is post title and post url recieved during seeding, observe how they look.')
    let isCrossPost = post.crosspostParentId
    let originalpost = post
    if (isCrossPost){
      post = await reddit.getPostById(isCrossPost)
    }
    if (isVideoPost(post)){
      if ((await redis.hLen(`vid${originalpost.id}`)) > 0) continue
      if (done > SEED_BATCH){
        remaining++
        continue
      }
      try{
        await fingerprintVideoPost(post, originalpost)
        done++
      } catch (err){
        console.log(err, 'fingerprint failed')
      }
    }

    else if(isImagePost(post)){
      if (await redis.get(`img${originalpost.id}`) != undefined) continue
      if (done > SEED_BATCH){
        remaining++
        continue
      }
      try{
        await fingerprintImagePost(post, originalpost)
        done ++
      } catch (err){
        console.log(err, 'fingerprint image post failed')
      }
    }
    else if (isSelfPost(post)){
      if (await redis.get(`txt${originalpost.id}`) != undefined) continue
      if (done > SEED_BATCH){
        remaining++
        continue
      }
      if (await redis.get(`txt${originalpost.id}`) == undefined){
        try{
          await fingerprintTextPost(post, originalpost)
          done++
        } catch (err){
          console.log('fingerprint text post failed')
        }
      }
    }
    
  }
  if (remaining > 0){
      await scheduler.runJob({
        name: 'seed-fingerprints',
        data: {subredditName},
        runAt: new Date(Date.now() + 20_000)
      })
      console.log(`succesfully seeded ${done}, ${remaining} posts schedueled for the future`)
    } else{
      console.log(`finished seeding ${done}, fully fingerprinted window`)
    }
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
  let imageTolerance = await settings.get('imageTolerance') ?? 80
  let videoTolerance = await settings.get('videoTolerance') ?? 90
  let textTolerance = await settings.get('textTolerance') ?? 70
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
  let actualPostMetaInfo = postMetaInfo
  const isCrossPost = postMetaInfo.crosspostParentId
  if (isCrossPost) {
    postMetaInfo = await reddit.getPostById(isCrossPost)
  }

  console.log(postMetaInfo.url, 'this is the post url, check how it looks for videos, images and text')
  let tries = 3
  let countDown = 6
  console.log(postMetaInfo.url.includes('v.redd.it'), 'this should be false for non videos!')
  if (!postMetaInfo){
    console.log('secureMedia is not loaded, waiting for 6 seconds...')
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
  console.log(isVideoPost(postMetaInfo), 'this should be true!!!')
  console.log(postMetaInfo.secureMedia?.redditVideo?.dashUrl, 'this should not be undefined!')
  console.time("performance")
  const recent_post_ids: string[] = []
  let temp_repost_dict: Record<string, [number, string]> = {}
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
  
  let currPostisVideo = postMetaInfo.secureMedia?.redditVideo?.fallbackUrl
  let currPostisImg = (postMetaInfo.url.includes('i.redd.it') || 
  postMetaInfo.url.endsWith('png') || postMetaInfo.url.endsWith('jpg')
  || postMetaInfo.url.endsWith('gif'))

  if (postMetaInfo.secureMedia?.redditVideo){
    try{
      // 1. fingerprint the newly submitted post (this also stores vid<postId>)
      const curr_video_hashes = await fingerprintVideoPost(postMetaInfo, actualPostMetaInfo)

      // 2. walk the window and compare against stored fingerprints.
      //    fingerprint at most BACKFILL_CAP gaps here; the seed job handles the rest.
      let backfilled = 0
      for (let post of newPosts){
        let differenceDays = (Date.now() - post.createdAt.getTime()) / (1000 * 60 * 60 * 24)
        if (differenceDays > Number(timeSetting)) break
        console.log(post.title, post.id)
        recent_post_ids.push(post.id)
        let stored = await redis.hGetAll(`vid${post.id}`)
        let isCrossPost = post.crosspostParentId
        let originalPost = post
        if(isCrossPost){
          post = await reddit.getPostById(isCrossPost)
        }
        if (Object.keys(stored).length === 0){
          if (!isVideoPost(post)) continue
          if (backfilled >= BACKFILL_CAP) continue
          try{
            await fingerprintVideoPost(post, originalPost)
            backfilled++
            stored = await redis.hGetAll(`vid${originalPost.id}`)
          } catch(err){
            console.error('backfill failed for', originalPost.id, err)
            continue
          }
        }

        let past_video_hashes: bigint[] = Object.values(stored).map(h => BigInt(h))
        let result = compareVideoHashes(curr_video_hashes, past_video_hashes)
        if (!temp_repost_dict[`${originalPost.id}`]) temp_repost_dict[`${originalPost.id}`] = [result, `https://www.reddit.com${originalPost.permalink}`]
        if (result > Number(videoTolerance)) break
      }
    } catch(err){
      console.error('video repost check failed:', err)
    }
  }


  else if (post_url.endsWith('.png') || post_url.endsWith('.jpg') || post_url.endsWith('.gif') || post_url.includes('i.redd.it')){
    let res = await fetch(postMetaInfo.url)
    let buf = await res.arrayBuffer()
    let img_frame = await extractImage(new Uint8Array(buf), post_url)
    let image_hash = dHash(img_frame)
    let backFill = 0
    for (let post of newPosts){
      recent_post_ids.push(post.id)
      // compare post with image_hash
      // so i have to get the hash of post_id
      // but only if it starts with img
      let postDate = post.createdAt
      let currDate = Date.now()
      let differenceMS = currDate - postDate.getTime()
      let differenceDays = differenceMS / (1000 * 60 * 60 * 24)
      if (differenceDays > Number(timeSetting)) break
      let isCrossPost = post.crosspostParentId
      let originalPost = post
      if(isCrossPost){
        post = await reddit.getPostById(isCrossPost)
      }
      let isInDatabase = await redis.get(`img${originalPost.id}`)
      if (isInDatabase == undefined){
        let img: Uint8Array
        let imgUrl = post.url
        let isImage = (imgUrl.endsWith('.png') || imgUrl.endsWith('.jpg') || imgUrl.endsWith('gif') || imgUrl.includes('i.redd.it')) 
        if (!isImage) continue;
        if (backFill > BACKFILL_CAP) continue;
        try{
          let res = await fetch(imgUrl)
          let buf = await res.arrayBuffer()
          img = await extractImage(new Uint8Array(buf), imgUrl)
          await redis.set(`img${originalPost.id}`, dHash(img).toString())
          await redis.expire(`img${originalPost.id}`, expiry_time*24*60*60)
          backFill++
        } catch (err){
          console.log(err, 'backfill image failed')
        }
      }
      let redis_past_hash: string
      redis_past_hash = await redis.get(`img${originalPost.id.toString()}`) ?? ''
      let hamming = 0
      if (redis_past_hash != ''){
        hamming = Math.round(100 - ((hammingDistance(BigInt(redis_past_hash), image_hash) / 64) * 100))
      }
      let curr_title = post.title
      if (!temp_repost_dict[`${originalPost.id}`]) temp_repost_dict[`${originalPost.id}`] = [hamming, `https://www.reddit.com${originalPost.permalink}`]
      if (hamming > Number(imageTolerance)) break
    }
    redis.set(`img${postId}`, `${image_hash}`)
    await redis.expire(`img${postId}`, expiry_time*24*60*60)


  } else if (isSelfPost(postMetaInfo)){
    let curr_normalized = normalizeText(postMetaInfo.title)
    let curr_shingle = shingle(curr_normalized)
    let curr_simhash = simHash(curr_shingle)
    let backfill = 0
    
    for (let post of newPosts){
      let postDate = post.createdAt
      let currDate = Date.now()
      let differenceMS = currDate - postDate.getTime()
      let differenceDays = differenceMS / (1000 * 60 * 60 * 24)
      if (differenceDays > Number(timeSetting)) break
      let isInDataBase = await redis.get(`txt${post.id}`)
      if (isInDataBase == undefined){
        let postUrl = post.url
        // let isImage = (postUrl.endsWith('png') || postUrl.endsWith('jpg') || postUrl.endsWith('gif') || postUrl.includes('i.redd.it'))
        // let isVideo = post.secureMedia?.redditVideo?.fallbackUrl
        let isTextPost = isSelfPost(post)
        if (!isTextPost) continue
        if (backfill > BACKFILL_CAP) continue;
        let curr_normalized = normalizeText(post.title)
        let curr_shingle = shingle(curr_normalized)
        let curr_simhash = simHash(curr_shingle)
        await redis.set(`txt${post.id}`, curr_simhash.toString())
        await redis.expire(`txt${post.id}`, expiry_time*24*60*60)
        backfill++
      }
      let past_simhash = await redis.get(`txt${post.id.toString()}`) ?? ''
      let hamming = 0
      if (past_simhash != ''){
        hamming = Math.round(100 - ((hammingDistance(BigInt(past_simhash), curr_simhash) / 64) * 100))
      }
      if (post.authorName == '[deleted]'){
        await redis.del(`vid${post.id}`, `img${post.id}`, `txt${post.id}`)
      }
      if (!temp_repost_dict[`${post.id}`]) temp_repost_dict[`${post.id}`] = [hamming, `https://www.reddit.com${post.permalink}`]
      if (hamming > Number(textTolerance)) break
    }
    await redis.set(`txt${postId.toString()}`, curr_simhash.toString())
    await redis.expire(`txt${postId}`, expiry_time*24*60*60)
  }
  //ok, so we got postMetainfo.secureMedia now
  //now get its hash
  let username = postMetaInfo.authorName
  let enforcementAction: string
  enforcementAction = await settings.get("enforcementAction") ?? "report"
  if (isCrossPost) postMetaInfo = actualPostMetaInfo
  for (const value of Object.values(temp_repost_dict)){
    if (currPostisVideo){
      if (value[0] >= Number(videoTolerance)){
        await reddit.modMail.createConversation(
          {
            subredditName: sub,
            subject: 'DejaRepost has detected a possible repost',
            body: `The post https://reddit.com${postMetaInfo.permalink} is a possible repost of: \n${value[1]}\n
            confidence level: ${value[0]}`,
            to: null
          }
        )
        if (enforcementAction == "report"){
          try{
            await reddit.report(postMetaInfo, {reason: `Possible repost identified by DejaRepost`})
          } catch (err){
            console.log(err, 'report error')
          }
        } else if (enforcementAction == "remove"){
          try{
            await reddit.remove(postMetaInfo.id, false)
            const comment = await reddit.submitComment({
            id: postId,
            text: 
            `Hi ${username}, \n\n
your post was removed because it was previously posted here: ${value[1]} \n\n
if you believe this was a mistake, please reach out to us via https://www.reddit.com/message/compose?to=/r/${sub}
            `,
            runAs: 'APP'
          })
          await comment.distinguish(true)
          } catch (err){
            console.log(err, 'remove error')
          }
        }
        break
      }
    } else if (currPostisImg){
      if (value[0] >= Number(imageTolerance)){
        await reddit.modMail.createConversation(
          {
            subredditName: sub,
            subject: 'DejaRepost has detected a possible repost',
            body: `The post https://reddit.com${postMetaInfo.permalink} is a possible repost of: \n${value[1]}\n
            confidence level: ${value[0]}
            `,
            to: null
          }
        )
        if (enforcementAction == "report"){
          try{
            await reddit.report(postMetaInfo, {reason: `Possible repost identified by DejaRepost`})
          } catch(err){
            console.log(err, 'report error')
          }
        } else if (enforcementAction == "remove"){
          try{
            await reddit.remove(postMetaInfo.id, false)
            const comment = await reddit.submitComment({
            id: postId,
            text: `Hi ${username}, \n\n
your post was removed because it was previously posted here: ${value[1]} \n\n
if you believe this was a mistake, please reach out to us via https://www.reddit.com/message/compose?to=/r/${sub}`, 
            runAs: 'APP'
          })
          await comment.distinguish(true)
          } catch(err){
            console.log(err, 'remove error')
          }
        }
        break
      }
    } else{
      if (value[0] >= Number(textTolerance)){
        await reddit.modMail.createConversation(
          {
            subredditName: sub,
            subject: 'DejaRepost has detected a possible repost',
            body: `The post https://reddit.com${postMetaInfo.permalink} is a possible repost of: \n${value[1]}\n
            confidence level: ${value[0]}`,
            to: null
          }
        )
        if (enforcementAction == "report"){
          try{
            await reddit.report(postMetaInfo, {reason: `Possible repost identified by DejaRepost`})
          } catch(err){
            console.log(err, 'report error')
          }
        } else if (enforcementAction == "remove"){
          try{
            await reddit.remove(postMetaInfo.id, false)
            const comment = await reddit.submitComment({
            id: postId,
            text: `Hi ${username}, \n\n
your post was removed because it was previously posted here: ${value[1]} \n\n
if you believe this was a mistake, please reach out to us via https://www.reddit.com/message/compose?to=/r/${sub}`, 
            runAs: 'APP'
          })
          await comment.distinguish(true)
          } catch(err){
            console.log(err, 'remove error')
          }
        }
        break
      }
    }
  }
  console.timeEnd('performance')

  console.log('hopefull this thing works, but the app probably wont even start lmao...')
  console.log('anyways, here is the 5 most recent posts along with their similarity indicies: ', temp_repost_dict)
  
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
