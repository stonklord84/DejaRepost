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
    print?: (msg: string) => void
    printErr?: (msg: string) => void
  }): Promise<FFmpegCoreModule>
}
