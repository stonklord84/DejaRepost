// console.log(req, 'this is req, read it!')
//   const newPosts = await reddit.getNewPosts({
//     limit: 900,
//     subredditName: (req as any).data?.subredditName,
//     pageSize: 100
//   }).all()
//   let reference_sheet: any = {}
//   let posts_and_urls: any = {}
//   let timeSetting
//   timeSetting = await settings.get('timeThreshold') ?? 2
//   for (const post of newPosts){
//     let postDate = post.createdAt
//     let currDate = Date.now()
//     let differenceMS = currDate - postDate.getTime()
//     let differenceDays = differenceMS / (1000 * 60 * 60 * 24)
//     if (differenceDays > Number(timeSetting)) break
//     reference_sheet[post.id] = post.title
//     let post_url = post.url?.toLowerCase() ?? ''
//     let isImage = (post_url.endsWith('.png') || post_url.endsWith('.jpg') || post_url.endsWith('gif') || post_url.includes('i.redd.it')) 
//     if (post.secureMedia?.redditVideo){
//       console.log('===============')
//       console.log('this is a video post', post.title)
//       if (!posts_and_urls[post.id]){
//         posts_and_urls[post.id] = [post.secureMedia.redditVideo?.fallbackUrl, 'video']
//       }
//     }
//     else if (isImage){
//       console.log('image post alert: ', post.title)
//       console.log(post.url, '<- url')
//       posts_and_urls[post.id] = [post.url, 'img']
//     }
//     else{
//       console.log('text post bro', post.title)
//       posts_and_urls[post.id] = [post.title, 'txt']
//     }
//   }
//   console.log(posts_and_urls.length, 'this should not be long!!!!')
//   for (const post_id of Object.keys(posts_and_urls)){
//     if (posts_and_urls[post_id][1] == 'video'){
//       try{
//         let video: Uint8Array[] = []
//         const fallbackUrl = posts_and_urls[post_id][0]
//         const lowres_fallbackUrl = fallbackUrl?.replace(/(DASH|CMAF)_\d+/, '$1_480')
//         let res = await fetch(lowres_fallbackUrl as string)
//         if (!res.ok){
//           res = await fetch(fallbackUrl as string)
//         }
//         const buf = await res.arrayBuffer()
//         video = await extractFrames(new Uint8Array(buf))
//         //im thinking maybe ill store the video inside redis
//         console.log(post_id, video.length, '<= video length')
//         //yeah ill store the video variable, with key postid!
//         //nah, lets fingerprint them all... yeah.
//         for (const [i, frame] of video.entries()){
//           await redis.hSet(`vid${post_id}`, {[String(i)]: dHash(frame).toString()})
//         }
//         await redis.expire(`vid${post_id}`, expiry_time*24*60*60)
//       } catch(err){
//         console.error('seedFingerprints video failed for', post_id, err)
//       }
//     }
//     else if (posts_and_urls[post_id][1] == 'img'){
//       let img: Uint8Array
//       let res = await fetch(posts_and_urls[post_id][0])
//       let buf = await res.arrayBuffer()
//       img = await extractImage(new Uint8Array(buf), posts_and_urls[post_id][0])
//       await redis.set(`img${post_id}`, dHash(img).toString())
//       await redis.expire(`img${post_id}`, expiry_time*24*60*60)
//       //await extractImage(buf, posts_and_urls[post_id])
//       // im gonna write a new get image function!
//     }
//     else if (posts_and_urls[post_id][1] == 'txt'){
//       let normalizedText = normalizeText(posts_and_urls[post_id][0])
//       let shingleList = shingle(normalizedText)
//       let similarityHash = simHash(shingleList)
//       await redis.set(`txt${post_id}`, similarityHash.toString())
//       await redis.expire(`txt${post_id}`, expiry_time*24*60*60)
//     }

//   }
//   console.log(posts_and_urls, 'this is the posts_and_urls dictionary')
//   console.log(reference_sheet, 'this is the ref sheet')