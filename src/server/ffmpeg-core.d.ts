declare module '@ffmpeg/core' {
  interface FFmpegCoreFS {
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array
    readdir(path: string): string[]
    unlink(path: string): void
  }

  interface FFmpegCoreModule {
    FS: FFmpegCoreFS
    exec(...args: string[]): number
  }

  export default function createFFmpegCore(opts: {
    wasmBinary: Uint8Array
  }): Promise<FFmpegCoreModule>
}

declare module '@ffmpeg/core/wasm' {
  const dataUrl: string
  export default dataUrl
}
