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
        return createFFmpegCore({wasmBinary: new Uint8Array(buf)})
      })
      .then(m => {
        console.log('[decodeFrames] module instantiated OK')
        return m
      })
  }
  return modulePromise
}

/** Decode `video` and return one PNG frame per second (or `fps` per second), in order. */
export async function extractFrames(
  video: Uint8Array,
  fps = 1,
): Promise<Uint8Array[]> {
  console.log('[decodeFrames] extractFrames called, video bytes:', video.byteLength)
  const mod = await getModule()
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const inFile = `in_${id}.mp4`
  const outPrefix = `out_${id}_`

  console.log('[decodeFrames] writing input to virtual fs...')
  mod.FS.writeFile(inFile, video)
  try {
    console.log('[decodeFrames] running exec...')
    const ret = mod.exec('-i', inFile, '-vf', `fps=${fps}`, `${outPrefix}%d.png`)
    console.log('[decodeFrames] exec returned:', ret)
    if (ret !== 0) throw Error(`ffmpeg exec failed with code ${ret}`)

    const frameFiles = mod.FS.readdir('.')
      .filter(f => f.startsWith(outPrefix))
      .sort((a, b) => {
        const na = Number(a.slice(outPrefix.length))
        const nb = Number(b.slice(outPrefix.length))
        return na - nb
      })

    return frameFiles.map(f => {
      const data = mod.FS.readFile(f)
      mod.FS.unlink(f)
      return data
    })
  } finally {
    mod.FS.unlink(inFile)
  }
}
