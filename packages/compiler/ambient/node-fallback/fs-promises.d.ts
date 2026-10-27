/// <reference path="./fs.d.ts" />

/* fs/promises — the SAME synchronous operations behind already-settled
 * promises: success fulfills, failure REJECTS with the would-be thrown
 * error (catchable at the await, like Node). DOCUMENTED DIVERGENCE
 * (SEMANTICS.md): the syscall blocks the event loop, so I/O never
 * interleaves with timers or other fibers — observable only in concurrent
 * code. readFile is utf8-only, like readFileSync. */
declare module "fs/promises" {
  export interface FileReadResult<T extends Uint8Array> {
    bytesRead: number;
    buffer: T;
  }
  export interface FileWriteResult<T> {
    bytesWritten: number;
    buffer: T;
  }
  export interface FileReadvResult<T extends Uint8Array[]> {
    bytesRead: number;
    buffers: T;
  }
  export interface FileWritevResult<T extends Uint8Array[]> {
    bytesWritten: number;
    buffers: T;
  }
  export interface FileReadOptions<T extends Uint8Array = Buffer> {
    buffer?: T;
    offset?: number | null;
    length?: number | null;
    position?: number | null;
  }
  /* The streams over a FileHandle (createReadStream, createWriteStream,
   * readLines): fs streams that hold the handle until they close; closing
   * the stream closes the handle unless autoClose is false. */
  export interface CreateReadStreamOptions {
    encoding?: BufferEncoding | null;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    end?: number;
    highWaterMark?: number;
  }
  export interface CreateWriteStreamOptions {
    encoding?: BufferEncoding | null;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    highWaterMark?: number;
    flush?: boolean;
  }
  export interface FileHandle extends AsyncDisposable {
    readonly fd: number;
    close(): Promise<void>;
    createReadStream(options?: CreateReadStreamOptions): import("node:fs").ReadStream;
    createWriteStream(options?: CreateWriteStreamOptions): import("node:fs").WriteStream;
    readLines(options?: CreateReadStreamOptions): import("node:readline").Interface;
    sync(): Promise<void>;
    datasync(): Promise<void>;
    truncate(len?: number): Promise<void>;
    chmod(mode: number): Promise<void>;
    utimes(atime: number | string | Date, mtime: number | string | Date): Promise<void>;
    readv<T extends Uint8Array[]>(
      buffers: T,
      position?: number | null,
    ): Promise<FileReadvResult<T>>;
    writev<T extends Uint8Array[]>(
      buffers: T,
      position?: number | null,
    ): Promise<FileWritevResult<T>>;
    read<T extends Uint8Array = Buffer>(
      options?: FileReadOptions<T> | null,
    ): Promise<FileReadResult<T>>;
    read<T extends Uint8Array>(
      buffer: T,
      options: Omit<FileReadOptions<T>, "buffer">,
    ): Promise<FileReadResult<T>>;
    read<T extends Uint8Array>(
      buffer: T,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ): Promise<FileReadResult<T>>;
    write<T extends Uint8Array>(
      buffer: T,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ): Promise<FileWriteResult<T>>;
    write<T extends Uint8Array>(
      buffer: T,
      options: Omit<FileReadOptions<T>, "buffer">,
    ): Promise<FileWriteResult<T>>;
    write(
      data: string,
      position?: number | null,
      encoding?: "utf8" | "utf-8" | null,
    ): Promise<FileWriteResult<string>>;
    readFile(options?: null): Promise<Buffer>;
    readFile(encoding: "utf8" | "utf-8"): Promise<string>;
    writeFile(data: string | Uint8Array, encoding?: "utf8" | "utf-8" | null): Promise<void>;
    appendFile(data: string | Uint8Array, encoding?: "utf8" | "utf-8" | null): Promise<void>;
    stat(): Promise<import("node:fs").Stats>;
    [Symbol.asyncDispose](): Promise<void>;
  }
  export function open(path: string | URL, flags?: string, mode?: number): Promise<FileHandle>;
  export function link(
    existingPath: string | Uint8Array | URL,
    newPath: string | Uint8Array | URL,
  ): Promise<void>;
  export function symlink(
    target: string | Uint8Array | URL,
    path: string | Uint8Array | URL,
    type?: string | null,
  ): Promise<void>;
  export function cp(
    source: string | URL,
    destination: string | URL,
    options?: import("node:fs").CopyOptions,
  ): Promise<void>;
  export function readlink(
    path: string | Uint8Array | URL,
    options: "buffer" | { encoding: "buffer" },
  ): Promise<Buffer>;
  export function readlink(
    path: string | Uint8Array | URL,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Promise<string>;
  export function readlink(
    path: string | Uint8Array | URL,
    options: string | { encoding?: string | null } | null,
  ): Promise<string | Buffer>;
  export function utimes(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): Promise<void>;
  export function lutimes(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): Promise<void>;
  export function readFile(path: string | URL, encoding: "utf8" | "utf-8"): Promise<string>;
  export function readFile(
    path: string | URL,
    options: BufferEncoding | { encoding: BufferEncoding },
  ): Promise<string>;
  export function readFile(path: string | URL): Promise<Buffer>;
  export function writeFile(
    path: string | URL,
    data: string,
    options?: {
      mode?: number;
      encoding?: "utf8" | "utf-8";
      flag?: string;
      [option: string]: unknown;
    },
  ): Promise<void>;
  export function writeFile(
    path: string | URL,
    data: string,
    encoding: "utf8" | "utf-8",
  ): Promise<void>;
  export function mkdir(
    path: string | URL,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void>;
  export function readdir(path: string | URL): Promise<string[]>;
  export function readdir(
    path: string | URL,
    options: {
      encoding?: "utf8" | "utf-8";
      withFileTypes: true;
      recursive?: boolean;
      [option: string]: unknown;
    },
  ): Promise<import("node:fs").Dirent[]>;
  /* The async iterator form of fs.globSync: iterate it with for await. */
  export function glob(
    pattern: string | readonly string[],
    options?: import("node:fs").GlobOptions,
  ): AsyncIterableIterator<string>;
  export function glob(
    pattern: string | readonly string[],
    options: import("node:fs").GlobOptionsWithFileTypes,
  ): AsyncIterableIterator<import("node:fs").Dirent>;
  export function rm(path: string | URL): Promise<void>;
  export function rm(
    path: string | URL,
    options: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number },
  ): Promise<void>;
  export function stat(path: string | URL): Promise<import("node:fs").Stats>;
  export function statfs(
    path: string | Uint8Array | URL,
    options?: import("node:fs").StatFsOptions & { bigint?: false },
  ): Promise<import("node:fs").StatsFs>;
  export function statfs(
    path: string | Uint8Array | URL,
    options: import("node:fs").StatFsOptions & { bigint: true },
  ): Promise<import("node:fs").BigIntStatsFs>;
  export function statfs(
    path: string | Uint8Array | URL,
    options?: import("node:fs").StatFsOptions,
  ): Promise<import("node:fs").StatsFs | import("node:fs").BigIntStatsFs>;
  export function realpath(path: string | URL): Promise<string>;
  export function lstat(path: string | URL): Promise<import("node:fs").Stats>;
  export function unlink(path: string | URL): Promise<void>;
  export function chmod(path: string | URL, mode: number): Promise<void>;
  export function chown(path: string | URL, uid: number, gid: number): Promise<void>;
  export function lchown(path: string | URL, uid: number, gid: number): Promise<void>;
  export function access(path: string | URL, mode?: number): Promise<void>;
  export function truncate(path: string | URL, len?: number): Promise<void>;
  export function appendFile(path: string | URL, data: string | Uint8Array): Promise<void>;
  export function copyFile(src: string | URL, dest: string | URL): Promise<void>;
  export function mkdtemp(prefix: string | URL): Promise<string>;
  export function rmdir(path: string | URL): Promise<void>;
  export function rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  export function opendir(
    path: string | URL,
    options?: import("node:fs").OpenDirOptions,
  ): Promise<import("node:fs").Dir>;
}

declare module "node:fs/promises" {
  export * from "fs/promises";
}
