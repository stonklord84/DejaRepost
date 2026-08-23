import createFFmpegCore from '@ffmpeg/core'
// Hosted externally (Supabase Storage, public bucket) instead of bundled into
// the server: embedding the ~32MB wasm binary directly in the server bundle
// pushed it past whatever size/startup budget Devvit enforces, which broke
// the entire server, not just video decoding. Fetching it at first use keeps
// the deployed bundle small; the cost moves to a one-time ~32MB download on
// the first video decode per warm server instance.
const WASM_URL =
  'https://qtyvytpodaznfhffdzus.supabase.co/storage/v1/object/public/ffmpeg-core.wasm/ffmpeg-core.wasm'

let modulePromise: ReturnType<typeof createFFmpegCore> | null = null

// Deferred until the first real call, not run at module load, same reasoning
// as before: don't pay this cost on every cold start, only when a video
// actually needs decoding.
function getModule() {
  if (!modulePromise) {
    // ffmpeg-core.wasm is built assuming it always runs inside a browser Web
    // Worker, so it reaches for these globals unconditionally. They don't
    // exist in Node, so stub the minimum it needs to get through init. The
    // href value itself is never read on this code path (we pass wasmBinary
    // directly below, so it never falls back to fetching/locating the wasm
    // file by URL).
    // anyways, only one way to find out
    // lets make 10 fingerprints, on app start
    const g = globalThis as {self?: unknown; location?: unknown}
    g.self ??= globalThis
    g.location ??= {href: 'file:///dejapost-server/'}

    modulePromise = fetch(WASM_URL)
      .then(res => {
        console.log('[decodeFrames] wasm fetch status:', res.status)
        return res.arrayBuffer()
      })
      .then(buf => {
        console.log('[decodeFrames] wasm bytes fetched:', buf.byteLength, '- instantiating module...')
        return createFFmpegCore({
          wasmBinary: new Uint8Array(buf),
          print: (msg: string) => console.log('[ffmpeg]', msg),
          printErr: (msg: string) => console.log('[ffmpeg:err]', msg),
        })
      })
      .then(m => {
        console.log('[decodeFrames] module instantiated OK')
        return m
      })
  }
  return modulePromise
}

export async function extractImage( image: Uint8Array, post_url: string ): Promise<Uint8Array>{
  console.log('[decodeFrames] extractImage called, image bytes: ', image.byteLength)
  const mod = await getModule()
  let url_extension = post_url.split('.').pop()
  const inFile = `input.${url_extension}`
  const outputFile = `output.bin`

  console.log('[decodeFrames] writing input to virtual FS...')
  mod.FS.writeFile(inFile, image)
  try{
    const exitCode = mod.exec(
      '-i', inFile,
      '-vf', 'scale=9:8:flags=lanczos,format=gray',
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      outputFile
    )
    if (exitCode != 0) throw new Error(`ffmpeg image conversion failed with error code ${exitCode}`)

    //mod.FS.readfile() is the thing giving you the Uint8Array object
    let imageFile = mod.FS.readFile(outputFile)
    mod.FS.unlink(outputFile)
    return imageFile
  }
  finally{
    mod.FS.unlink(inFile)
  }
}

/** Decode `video` and return one PNG frame per second (or `fps` per second), in order. */
export async function extractFrames(
  video: Uint8Array,
  fps = 1,
): Promise<Uint8Array[]> {
  console.log('[decodeFrames] extractFrames called, video bytes:', video.byteLength)
  console.time('getFFmpeg')
  const mod = await getModule()
  console.timeEnd('getFFmpeg')
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const inFile = `in_${id}.mp4`
  const outputFile = `out_${id}.bin`

  console.log('[decodeFrames] writing input to virtual fs...')
  mod.FS.writeFile(inFile, video)
  try {
    const exitCode = mod.exec(
      '-i', inFile,
      '-t', '30',
      '-vf', 'fps=1,scale=9:8:flags=lanczos,format=gray',
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      outputFile
    )

    if (exitCode != 0) throw new Error(`FFmpeg exec failed with code ${exitCode}`)
    
    //must read bin file before you can iterate through it
    let framesFile = mod.FS.readFile(outputFile)
    mod.FS.unlink(outputFile)

    const frameSize = 9 * 8
    let chunks: Uint8Array[] = []
    for (let i = 0; i < framesFile.length; i+= frameSize ){
      chunks.push(framesFile.subarray(i, i + frameSize))
    }
    return chunks

  } finally {
    mod.FS.unlink(inFile)
  }
}
