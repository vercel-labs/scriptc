/// <reference path="./fs.d.ts" />

/* fs/promises — the SAME synchronous operations behind already-settled
 * promises: success fulfills, failure REJECTS with the would-be thrown
 * error (catchable at the await, like Node). DOCUMENTED DIVERGENCE
 * (SEMANTICS.md): the syscall blocks the event loop, so I/O never
 * interleaves with timers or other fibers — observable only in concurrent
 * code. The whole-file reads and writes encode and decode every
 * BufferEncoding name, and an options record's string data is written in
 * its encoding. */
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
    signal?: AbortSignal;
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
    chown(uid: number, gid: number): Promise<void>;
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
      encoding?: BufferEncoding | null,
    ): Promise<FileWriteResult<string>>;
    readFile(options?: null): Promise<Buffer>;
    readFile(encoding: BufferEncoding): Promise<string>;
    readFile(options: { encoding: BufferEncoding }): Promise<string>;
    writeFile(
      data: string | ScriptcBufferView,
      options?: WriteFileOptions | BufferEncoding | null,
    ): Promise<void>;
    appendFile(
      data: string | ScriptcBufferView,
      options?: WriteFileOptions | BufferEncoding | null,
    ): Promise<void>;
    stat(options?: null | { bigint?: false }): Promise<import("node:fs").Stats>;
    stat(options: { bigint: true }): Promise<import("node:fs").BigIntStats>;
    stat(options: {
      bigint?: boolean;
    }): Promise<import("node:fs").Stats | import("node:fs").BigIntStats>;
    [Symbol.asyncDispose](): Promise<void>;
  }
  /* The options record fs.promises.writeFile/appendFile accept: Node
   * validates encoding, flag, flush, mode and signal in that order, before
   * the first byte is written. */
  export interface WriteFileOptions {
    encoding?: BufferEncoding | null;
    mode?: number;
    flag?: string;
    flush?: boolean;
    signal?: AbortSignal;
    [option: string]: unknown;
  }
  export interface AppendFileOptions {
    encoding?: BufferEncoding | null;
    mode?: number;
    flag?: string;
    flush?: boolean;
    signal?: AbortSignal;
    [option: string]: unknown;
  }
  export interface RmdirOptions {
    recursive?: boolean;
    retryDelay?: number;
    maxRetries?: number;
    [option: string]: unknown;
  }
  export function open(
    path: string | URL,
    flags?: string | number,
    mode?: number | string,
  ): Promise<FileHandle>;
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
    data: string | ScriptcBufferView,
    options?: WriteFileOptions | BufferEncoding | null,
  ): Promise<void>;
  /* Node accepts options as the mode shorthand (a number or an octal
   * string) and answers the first created directory when recursive is
   * true, undefined otherwise. */
  export function mkdir(path: string | URL, options?: number | string | null): Promise<void>;
  export function mkdir(
    path: string | URL,
    options: { recursive?: false; mode?: number | string },
  ): Promise<void>;
  export function mkdir(
    path: string | URL,
    options: { recursive: true; mode?: number | string },
  ): Promise<string | undefined>;
  export function mkdir(
    path: string | URL,
    options: { recursive?: boolean; mode?: number | string },
  ): Promise<string | undefined>;
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
  /* stat's record selects the member table (bigint: true is BigIntStats)
   * and whether a missing entry answers undefined instead of rejecting
   * (throwIfNoEntry: false, Node's v24.15 addition). The runtime still
   * reads any truthy `bigint`, so the catch-all keeps the reachable
   * Stats | undefined answer for a runtime-valued flag. */
  export interface StatOptions {
    bigint?: boolean;
    throwIfNoEntry?: boolean;
  }
  export function stat(path: string | URL, options?: undefined): Promise<import("node:fs").Stats>;
  export function stat(
    path: string | URL,
    options: StatOptions & { bigint?: false; throwIfNoEntry: false },
  ): Promise<import("node:fs").Stats | undefined>;
  export function stat(
    path: string | URL,
    options: StatOptions & { bigint: true; throwIfNoEntry: false },
  ): Promise<import("node:fs").BigIntStats | undefined>;
  export function stat(
    path: string | URL,
    options: StatOptions & { bigint?: false; throwIfNoEntry?: true },
  ): Promise<import("node:fs").Stats>;
  export function stat(
    path: string | URL,
    options: StatOptions & { bigint: true; throwIfNoEntry?: true },
  ): Promise<import("node:fs").BigIntStats>;
  export function stat(
    path: string | URL,
    options: StatOptions,
  ): Promise<import("node:fs").Stats | undefined>;
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
  /* realpath and mkdtemp take an encoding option in Node; "buffer" is the
   * one name that answers a Buffer, so it is the first overload and every
   * other encoding (the empty string included) answers the path text. */
  export function realpath(
    path: string | URL,
    options: "buffer" | { encoding: "buffer" },
  ): Promise<Buffer>;
  export function realpath(
    path: string | URL,
    options?: BufferEncoding | string | { encoding?: BufferEncoding | string | null } | null,
  ): Promise<string>;
  /* lstat's record has the same shape as stat's, but Node's promise
   * binding reads only bigint there: throwIfNoEntry is accepted and
   * ignored, so a missing entry still rejects. */
  export function lstat(path: string | URL, options?: undefined): Promise<import("node:fs").Stats>;
  export function lstat(
    path: string | URL,
    options: StatOptions & { bigint?: false },
  ): Promise<import("node:fs").Stats>;
  export function lstat(
    path: string | URL,
    options: StatOptions & { bigint: true },
  ): Promise<import("node:fs").BigIntStats>;
  export function lstat(
    path: string | URL,
    options: StatOptions,
  ): Promise<import("node:fs").Stats | import("node:fs").BigIntStats>;
  export function unlink(path: string | URL): Promise<void>;
  export function chmod(path: string | URL, mode: number): Promise<void>;
  export function chown(path: string | URL, uid: number, gid: number): Promise<void>;
  export function lchown(path: string | URL, uid: number, gid: number): Promise<void>;
  export function access(path: string | URL, mode?: number): Promise<void>;
  export function truncate(path: string | URL, len?: number): Promise<void>;
  export function appendFile(
    path: string | URL,
    data: string | ScriptcBufferView,
    options?: AppendFileOptions | BufferEncoding | null,
  ): Promise<void>;
  export function copyFile(src: string | URL, dest: string | URL, mode?: number): Promise<void>;
  export function mkdtemp(
    prefix: string | URL,
    options: "buffer" | { encoding: "buffer" },
  ): Promise<Buffer>;
  export function mkdtemp(
    prefix: string | URL,
    options?: BufferEncoding | string | { encoding?: BufferEncoding | string | null } | null,
  ): Promise<string>;
  /* fs.promises.mkdtempDisposable: an async-disposable record whose remove
   * and [Symbol.asyncDispose] delete the tree and answer promises. */
  export interface DisposableTempDir {
    path: string;
    remove(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
  }
  export function mkdtempDisposable(
    prefix: string | URL,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Promise<DisposableTempDir>;
  export function rmdir(path: string | URL): Promise<void>;
  export function rmdir(path: string | URL, options: RmdirOptions): Promise<void>;
  export function lchmod(path: string | URL, mode: number): Promise<void>;
  export function rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  export function opendir(
    path: string | URL,
    options?: import("node:fs").OpenDirOptions,
  ): Promise<import("node:fs").Dir>;
}

declare module "node:fs/promises" {
  export * from "fs/promises";
}
