import createFFmpegCore from '@ffmpeg/core'
import wasmDataUrl from '@ffmpeg/core/wasm'

let modulePromise: ReturnType<typeof createFFmpegCore> | null = null

// Everything here is deliberately deferred until the first real call, not run
// at module load: decoding the ~32MB wasm binary out of its base64 asset is
// heavy synchronous work, and running it unconditionally on every server
// cold start (rather than only when a video actually needs decoding) risked
// blowing Devvit's startup budget for every endpoint, not just this one.
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

    console.log('[decodeFrames] decoding base64 wasm asset...')
    const wasmBinary = Buffer.from(wasmDataUrl.split(',')[1] ?? '', 'base64')
    console.log('[decodeFrames] wasm bytes ready:', wasmBinary.byteLength, '- instantiating module...')
    modulePromise = createFFmpegCore({wasmBinary}).then(m => {
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
