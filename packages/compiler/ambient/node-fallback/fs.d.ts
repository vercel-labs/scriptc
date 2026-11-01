/// <reference path="./fs-promises.d.ts" />
/// <reference path="./stream.d.ts" />

/* The synchronous node:fs surface — utf8-only, no options objects, no
 * Buffers. Importing "node:fs" resolves here (preflight allowlists exactly
 * the ambient-declared node: modules); every function lowers to a `libCall`
 * with a scr_fs_* runtime implementation. Failures throw CATCHABLE string
 * values formatted like Node's error messages ("ENOENT: no such file or
 * directory, open 'x'"). `rmSync` removes FILES only (like Node without
 * `recursive`); empty directories go through `rmdirSync`. */
declare module "node:fs" {
  import { Readable, Writable } from "stream";
  export function readFileSync(path: string | number | URL, encoding: BufferEncoding): string;
  export function readFileSync(
    path: string | number | URL,
    options: { encoding: BufferEncoding },
  ): string;
  export function readFileSync(path: string | number | URL): Buffer;
  export function readFileSync(path: string | URL, options: unknown): string | Buffer;
  /* Error-first callbacks select string or Buffer data from their encoding.
   * Unknown options retain that union until the caller validates the value. */
  export function readFile(
    path: string,
    options: unknown,
    callback: (error: Error | null, data: string | Buffer) => void,
  ): void;
  /* The options form carries the mode (applied at CREATION only, like
   * Node — an existing file keeps its permissions) and/or the utf8
   * encoding spelling. */
  export function writeFileSync(
    path: string | URL,
    data: string,
    /* The options-record stance (see http.RequestOptions): an unsupported
     * flag fences by name at the call site; undocumented keys drop like
     * Node. The lowered flags are "w" (truncate-or-create) and "wx"
     * (exclusive create). */
    options?: {
      mode?: number;
      encoding?: "utf8" | "utf-8";
      flag?: string;
      [option: string]: unknown;
    },
  ): void;
  /* The bare-encoding spelling — the options record's encoding key alone. */
  export function writeFileSync(path: string | URL, data: string, encoding: "utf8" | "utf-8"): void;
  export function writeFileSync(path: string | URL, data: string | Uint8Array): void;
  /* The file-descriptor form: Node writes the whole data to an already
   * open descriptor and leaves it open (closeSync owns its lifetime, and
   * the write lands at the descriptor's current offset). */
  export function writeFileSync(fd: number, data: string): void;
  export function writeFileSync(fd: number, data: string, encoding: "utf8" | "utf-8"): void;
  export function appendFileSync(path: string | URL, data: string | Uint8Array): void;
  export function existsSync(path: string | Uint8Array | URL): boolean;
  export function mkdirSync(path: string | URL): void;
  export function mkdirSync(
    path: string | URL,
    options: { recursive?: boolean; mode?: number },
  ): void;
  export function unlinkSync(path: string | URL): void;
  export function chmodSync(path: string | URL, mode: number): void;
  export function fchmodSync(fd: number, mode: number): void;
  export function fsyncSync(fd: number): void;
  export function linkSync(
    existingPath: string | Uint8Array | URL,
    newPath: string | Uint8Array | URL,
  ): void;
  export function symlinkSync(
    target: string | Uint8Array | URL,
    path: string | Uint8Array | URL,
    type?: string | null,
  ): void;
  /* fs.cpSync / fs.cp: copies a file, symlink or (with recursive) a
   * directory tree. filter decides per path; the callback and promise
   * forms complete the copy before reporting. */
  export interface CopySyncOptions {
    dereference?: boolean;
    errorOnExist?: boolean;
    filter?: (source: string, destination: string) => boolean;
    force?: boolean;
    mode?: number;
    preserveTimestamps?: boolean;
    recursive?: boolean;
    verbatimSymlinks?: boolean;
  }
  export interface CopyOptions {
    dereference?: boolean;
    errorOnExist?: boolean;
    filter?: (source: string, destination: string) => boolean | Promise<boolean>;
    force?: boolean;
    mode?: number;
    preserveTimestamps?: boolean;
    recursive?: boolean;
    verbatimSymlinks?: boolean;
  }
  export function cpSync(
    source: string | URL,
    destination: string | URL,
    options?: CopySyncOptions,
  ): void;
  export function cp(
    source: string | URL,
    destination: string | URL,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function cp(
    source: string | URL,
    destination: string | URL,
    options: CopyOptions,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function symlink(
    target: string | Uint8Array | URL,
    path: string | Uint8Array | URL,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function symlink(
    target: string | Uint8Array | URL,
    path: string | Uint8Array | URL,
    type: string | null | undefined,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function link(
    existingPath: string | Uint8Array | URL,
    newPath: string | Uint8Array | URL,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function readlink(
    path: string | Uint8Array | URL,
    callback: (err: NodeJS.ErrnoException | null, target: string) => void,
  ): void;
  export function readlink(
    path: string | Uint8Array | URL,
    options: "buffer" | { encoding: "buffer" },
    callback: (err: NodeJS.ErrnoException | null, target: Buffer) => void,
  ): void;
  export function readlink(
    path: string | Uint8Array | URL,
    options: BufferEncoding | { encoding?: BufferEncoding | null } | null,
    callback: (err: NodeJS.ErrnoException | null, target: string) => void,
  ): void;
  export function readlink(
    path: string | Uint8Array | URL,
    options: string | { encoding?: string | null } | null,
    callback: (err: NodeJS.ErrnoException | null, target: string | Buffer) => void,
  ): void;
  export function readlinkSync(
    path: string | Uint8Array | URL,
    options: "buffer" | { encoding: "buffer" },
  ): Buffer;
  export function readlinkSync(
    path: string | Uint8Array | URL,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): string;
  export function readlinkSync(
    path: string | Uint8Array | URL,
    options: string | { encoding?: string | null } | null,
  ): string | Buffer;
  export function chownSync(path: string | URL, uid: number, gid: number): void;
  export function lchownSync(path: string | URL, uid: number, gid: number): void;
  export function fchownSync(fd: number, uid: number, gid: number): void;
  export function truncateSync(path: string | URL, len?: number): void;
  /* The destination is created or truncated carrying the SOURCE's mode.
   * `mode` is libuv's copyfile flag bits: COPYFILE_EXCL (1) fails when the
   * destination exists, COPYFILE_FICLONE (2) requests a reflink and falls
   * back to a copy, COPYFILE_FICLONE_FORCE (4) requires one. */
  export function copyFileSync(src: string | URL, dest: string | URL, mode?: number): void;
  export function rename(
    oldPath: string,
    newPath: string,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function renameSync(oldPath: string | URL, newPath: string | URL): void;
  export function rmSync(path: string | URL): void;
  /* maxRetries/retryDelay are accepted no-ops (Node retries around
   * EBUSY-class races; the synchronous lowering has no re-entrancy that
   * needs them). */
  export function rmSync(
    path: string | URL,
    options: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number },
  ): void;
  export function rmdirSync(path: string | URL): void;
  export function readdirSync(path: string | URL): string[];
  /* The recursive form: every entry below the path, relative to it. */
  export function readdirSync(
    path: string | URL,
    options: {
      recursive?: boolean;
      withFileTypes?: false;
      encoding?: "utf8" | "utf-8";
      [option: string]: unknown;
    },
  ): string[];
  /* The withFileTypes form: Dirent rows (name + parentPath + the type
   * probes — the honest subset of Node's Dirent surface). The type is
   * interned explicitly in type-mapper.ts (the record's hidden %dtype field
   * carries the entry kind; isFile/isDirectory/isSymbolicLink lower as
   * reads of it in builtins/process.ts). */
  export interface Dirent {
    name: string;
    parentPath: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function readdirSync(
    path: string | URL,
    /* The options-record stance (see http.RequestOptions): recursive
     * fences by name at the call site; undocumented keys drop like Node. */
    options: { withFileTypes: true; recursive?: boolean; [option: string]: unknown },
  ): Dirent[];
  /* fs.globSync / fs.glob: Node's glob walk over the file system. Patterns
   * are minimatch globs (case-insensitive on macOS and Windows); results
   * are relative to cwd unless the pattern is absolute. withFileTypes must
   * be a literal so the result type is known. */
  export interface GlobOptions {
    cwd?: string | URL;
    exclude?: readonly string[] | ((fileName: string) => boolean);
    followSymlinks?: boolean;
    withFileTypes?: false;
  }
  export interface GlobOptionsWithFileTypes {
    cwd?: string | URL;
    exclude?: readonly string[];
    followSymlinks?: boolean;
    withFileTypes: true;
  }
  export function globSync(pattern: string | readonly string[], options?: GlobOptions): string[];
  export function globSync(
    pattern: string | readonly string[],
    options: GlobOptionsWithFileTypes,
  ): Dirent[];
  export function glob(
    pattern: string | readonly string[],
    callback: (err: NodeJS.ErrnoException | null, matches?: string[]) => void,
  ): void;
  export function glob(
    pattern: string | readonly string[],
    options: GlobOptions,
    callback: (err: NodeJS.ErrnoException | null, matches?: string[]) => void,
  ): void;
  /* fs.Dir: an open directory stream (opendirSync, fs.promises.opendir)
   * read one Dirent at a time in OS order; utf8 names, no recursive walk. */
  export interface Dir {
    readonly path: string;
    readSync(): Dirent | null;
    read(): Promise<Dirent | null>;
    closeSync(): void;
    close(): Promise<void>;
    [Symbol.asyncIterator](): AsyncIterableIterator<Dirent>;
  }
  export interface OpenDirOptions {
    encoding?: "utf8" | "utf-8";
    bufferSize?: number;
  }
  export function opendirSync(path: string | URL, options?: OpenDirOptions): Dir;
  /* fs.ReadStream / fs.WriteStream: runtime Readable and Writable streams
   * over a file (scr_fs_stream.c). The options are checked at runtime
   * with Node's rules; flags and mode are checked when the file opens, so
   * their errors arrive as 'error' events. Instances also emit 'open'
   * (with the fd) and 'ready'. */
  export interface StreamOptions {
    flags?: string;
    encoding?: BufferEncoding;
    fd?: number;
    mode?: number | string;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    highWaterMark?: number;
  }
  export interface ReadStreamOptions extends StreamOptions {
    end?: number;
  }
  export interface WriteStreamOptions extends StreamOptions {
    flush?: boolean;
  }
  export class ReadStream extends Readable {
    readonly bytesRead: number;
    readonly path: string | Buffer;
    readonly pending: boolean;
    close(callback?: () => void): void;
  }
  export class WriteStream extends Writable {
    readonly bytesWritten: number;
    readonly path: string | Buffer;
    readonly pending: boolean;
    close(callback?: () => void): void;
  }
  export function createReadStream(
    path: string | Buffer | URL,
    options?: BufferEncoding | ReadStreamOptions,
  ): ReadStream;
  export function createWriteStream(
    path: string | Buffer | URL,
    options?: BufferEncoding | WriteStreamOptions,
  ): WriteStream;
  export function accessSync(path: string | URL, mode?: number): void;
  export function mkdtempSync(prefix: string | URL): string;
  export const constants: {
    readonly F_OK: number;
    readonly R_OK: number;
    readonly W_OK: number;
    readonly X_OK: number;
    readonly O_RDONLY: number;
    readonly O_WRONLY: number;
    readonly O_RDWR: number;
    readonly O_CREAT: number;
    readonly O_EXCL: number;
    readonly O_NOFOLLOW: number;
    readonly O_NONBLOCK: number;
    readonly O_TRUNC: number;
    readonly O_APPEND: number;
    readonly COPYFILE_EXCL: number;
    readonly COPYFILE_FICLONE: number;
    readonly COPYFILE_FICLONE_FORCE: number;
    readonly UV_FS_SYMLINK_DIR: number;
    readonly UV_FS_SYMLINK_JUNCTION: number;
    readonly UV_DIRENT_UNKNOWN: number;
    readonly UV_DIRENT_FILE: number;
    readonly UV_DIRENT_DIR: number;
    readonly UV_DIRENT_LINK: number;
    readonly UV_DIRENT_FIFO: number;
    readonly UV_DIRENT_SOCKET: number;
    readonly UV_DIRENT_CHAR: number;
    readonly UV_DIRENT_BLOCK: number;
    readonly UV_FS_O_FILEMAP: number;
    readonly UV_FS_O_TEMPORARY: number;
    readonly UV_FS_O_SHORT_LIVED: number;
    readonly UV_FS_O_SEQUENTIAL: number;
    readonly UV_FS_O_RANDOM: number;
    readonly UV_FS_COPYFILE_EXCL: number;
    readonly UV_FS_COPYFILE_FICLONE: number;
    readonly UV_FS_COPYFILE_FICLONE_FORCE: number;
    readonly S_IFMT: number;
    readonly S_IFREG: number;
    readonly S_IFDIR: number;
    readonly S_IFCHR: number;
    readonly S_IFBLK: number;
    readonly S_IFIFO: number;
    readonly S_IFLNK: number;
    readonly S_IFSOCK: number;
    readonly O_NOCTTY: number;
    readonly O_DIRECTORY: number;
    readonly O_NOATIME: number;
    readonly O_SYNC: number;
    readonly O_DSYNC: number;
    readonly O_SYMLINK: number;
    readonly O_DIRECT: number;
    readonly S_IRWXU: number;
    readonly S_IRUSR: number;
    readonly S_IWUSR: number;
    readonly S_IXUSR: number;
    readonly S_IRWXG: number;
    readonly S_IRGRP: number;
    readonly S_IWGRP: number;
    readonly S_IXGRP: number;
    readonly S_IRWXO: number;
    readonly S_IROTH: number;
    readonly S_IWOTH: number;
    readonly S_IXOTH: number;
  };
  /* A stat(2) snapshot (statSync follows symlinks, lstatSync does not —
   * Node's split) — immutable; the supported surface is exactly these
   * members. dev/ino identify the filesystem entry, blocks is the allocated
   * size in 512-byte units, and the time fields are milliseconds with their
   * sub-second fractions. */
  export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
    readonly dev: number;
    readonly mode: number;
    readonly nlink: number;
    readonly uid: number;
    readonly gid: number;
    readonly rdev: number;
    readonly blksize: number;
    readonly ino: number;
    readonly size: number;
    readonly blocks: number;
    readonly atimeMs: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly birthtimeMs: number;
    readonly atime: Date;
    readonly mtime: Date;
    readonly ctime: Date;
    readonly birthtime: Date;
  }
  /* Node's BigIntStats: the same snapshot under the bigint member table.
   * Every number member of Stats — including the *Ms millisecond members —
   * answers a bigint, and the *Ns nanosecond members sit beside them; the
   * four time members stay Dates. */
  export interface BigIntStats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
    readonly dev: bigint;
    readonly mode: bigint;
    readonly nlink: bigint;
    readonly uid: bigint;
    readonly gid: bigint;
    readonly rdev: bigint;
    readonly blksize: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly blocks: bigint;
    readonly atimeMs: bigint;
    readonly mtimeMs: bigint;
    readonly ctimeMs: bigint;
    readonly birthtimeMs: bigint;
    readonly atimeNs: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
    readonly birthtimeNs: bigint;
    readonly atime: Date;
    readonly mtime: Date;
    readonly ctime: Date;
    readonly birthtime: Date;
  }
  /* throwIfNoEntry: false answers undefined for a missing entry (ENOENT or
   * ENOTDIR) instead of throwing. bigint: true answers BigIntStats. */
  export interface StatSyncOptions {
    bigint?: boolean;
    throwIfNoEntry?: boolean;
  }
  export function statSync(path: string | URL, options?: undefined): Stats;
  export function statSync(
    path: string | URL,
    options: StatSyncOptions & { bigint?: false; throwIfNoEntry: false },
  ): Stats | undefined;
  export function statSync(
    path: string | URL,
    options: StatSyncOptions & { bigint: true; throwIfNoEntry: false },
  ): BigIntStats | undefined;
  export function statSync(
    path: string | URL,
    options: StatSyncOptions & { bigint?: false; throwIfNoEntry?: true },
  ): Stats;
  export function statSync(
    path: string | URL,
    options: StatSyncOptions & { bigint: true; throwIfNoEntry?: true },
  ): BigIntStats;
  /* A runtime-valued `bigint` is refused at lowering, so the catch-all keeps
   * the Stats answer the other reachable forms give. */
  export function statSync(path: string | URL, options: StatSyncOptions): Stats | undefined;
  export function lstatSync(path: string | URL, options?: undefined): Stats;
  export function lstatSync(
    path: string | URL,
    options: StatSyncOptions & { bigint?: false; throwIfNoEntry: false },
  ): Stats | undefined;
  export function lstatSync(
    path: string | URL,
    options: StatSyncOptions & { bigint: true; throwIfNoEntry: false },
  ): BigIntStats | undefined;
  export function lstatSync(
    path: string | URL,
    options: StatSyncOptions & { bigint?: false; throwIfNoEntry?: true },
  ): Stats;
  export function lstatSync(
    path: string | URL,
    options: StatSyncOptions & { bigint: true; throwIfNoEntry?: true },
  ): BigIntStats;
  export function lstatSync(path: string | URL, options: StatSyncOptions): Stats | undefined;
  /* The fd pair behind spawn's fd-stdio form: openSync(path, flags) →
   * the raw fd. Numeric flags use an inline OR of the O_* constants. The
   * mode is open(2)'s creation mode and applies to both flag forms. */
  export function openSync(path: string | URL, flags: string, mode?: number): number;
  export function openSync(path: string | URL, flags: number, mode?: number): number;
  export function closeSync(fd: number): void;
  export function fdatasyncSync(fd: number): void;
  export function ftruncateSync(fd: number, len?: number): void;
  export function utimesSync(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): void;
  export function futimesSync(
    fd: number,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): void;
  export function lutimesSync(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): void;
  export function utimes(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function futimes(
    fd: number,
    atime: number | string | Date,
    mtime: number | string | Date,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function lutimes(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function readvSync(fd: number, buffers: Uint8Array[], position?: number | null): number;
  export function writevSync(fd: number, buffers: Uint8Array[], position?: number | null): number;
  /* Read into a caller buffer from the fd's current position when position
   * is omitted/null, or from a numeric byte position without advancing the
   * fd. Answers the byte count, 0 at EOF. */
  export interface ReadSyncOptions {
    offset?: number;
    length?: number;
    position?: number | null;
  }
  export function readSync(fd: number, buffer: Uint8Array, options?: ReadSyncOptions): number;
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number | null,
  ): number;
  /* Write a caller-buffer window, or a utf8 string, at the fd's current
   * position when position is omitted/null (advancing it), or at a numeric
   * byte position without advancing it. Answers the byte count. */
  export interface WriteSyncOptions {
    offset?: number;
    length?: number;
    position?: number | null;
  }
  export function writeSync(fd: number, buffer: Uint8Array, options: WriteSyncOptions): number;
  export function writeSync(
    fd: number,
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): number;
  export function writeSync(
    fd: number,
    string: string,
    position?: number | null,
    encoding?: "utf8" | "utf-8",
  ): number;
  /* statSync over an open fd — the same snapshot. */
  export function fstatSync(fd: number, options?: StatSyncOptions & { bigint?: false }): Stats;
  export function fstatSync(fd: number, options: StatSyncOptions & { bigint: true }): BigIntStats;
  /* realpath(3) — resolves symlinks, `.`/`..`, throwing Node's fs error
   * shapes for missing paths. */
  export function realpathSync(path: string | URL): string;
  export namespace realpathSync {
    function native(path: string | URL): string;
  }
  /* statfs(2)/statvfs(3) — the filesystem-capacity snapshot (the fields
   * Node's statfsSync reports; bavail × bsize is the free-space probe). */
  export interface StatsFsBase<T> {
    type: T;
    bsize: T;
    blocks: T;
    bfree: T;
    bavail: T;
    files: T;
    ffree: T;
  }
  export interface StatsFs extends StatsFsBase<number> {}
  export interface BigIntStatsFs extends StatsFsBase<bigint> {}
  export interface StatFsOptions {
    bigint?: boolean;
  }
  export function statfsSync(
    path: string | Uint8Array | URL,
    options?: StatFsOptions & { bigint?: false },
  ): StatsFs;
  export function statfsSync(
    path: string | Uint8Array | URL,
    options: StatFsOptions & { bigint: true },
  ): BigIntStatsFs;
  export function statfsSync(
    path: string | Uint8Array | URL,
    options?: StatFsOptions,
  ): StatsFs | BigIntStatsFs;
  export function statfs(
    path: string | Uint8Array | URL,
    callback: (err: NodeJS.ErrnoException | null, stats: StatsFs) => void,
  ): void;
  export function statfs(
    path: string | Uint8Array | URL,
    options: (StatFsOptions & { bigint?: false }) | undefined,
    callback: (err: NodeJS.ErrnoException | null, stats: StatsFs) => void,
  ): void;
  export function statfs(
    path: string | Uint8Array | URL,
    options: StatFsOptions & { bigint: true },
    callback: (err: NodeJS.ErrnoException | null, stats: BigIntStatsFs) => void,
  ): void;
  export function statfs(
    path: string | Uint8Array | URL,
    options: StatFsOptions | undefined,
    callback: (err: NodeJS.ErrnoException | null, stats: StatsFs | BigIntStatsFs) => void,
  ): void;
  /* fs.watch — the file-watching slice (scr_watch.c, kqueue EVFILT_VNODE):
   * "rename"/"change" events on ONE path, watcher.close() to stop. The
   * listener takes (), (eventType) or (eventType, filename); an open
   * watcher keeps the loop alive. A path that cannot be opened THROWS
   * Node's fs error synchronously. */
  export type WatchEventType = "rename" | "change";
  /* (eventType, filename): filename is the changed entry's name (null when
   * the platform does not provide one). */
  export type WatchListener<T> = (event: WatchEventType, filename: T | null) => void;
  export interface FSWatcher {
    close(): void;
    on(event: "change", listener: (eventType: string, filename: string | Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: () => void): this;
    once(event: "change", listener: (eventType: string, filename: string | Buffer) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "close", listener: () => void): this;
    addListener(
      event: "change",
      listener: (eventType: string, filename: string | Buffer) => void,
    ): this;
    addListener(event: "error", listener: (error: Error) => void): this;
    addListener(event: "close", listener: () => void): this;
    off(event: "change" | "error" | "close", listener: (...args: any[]) => void): this;
    removeListener(event: "change" | "error" | "close", listener: (...args: any[]) => void): this;
  }
  /* The options-record stance (see http.RequestOptions): persistent: true,
   * recursive: false, and encoding: "utf8" state the lowered behavior and
   * are accepted; persistent: false, recursive: true, and signal fence by
   * name at the call site; undocumented keys drop like Node. */
  export interface WatchOptions {
    persistent?: boolean;
    recursive?: boolean;
    encoding?: string;
    [option: string]: unknown;
  }
  export function watch(path: string, listener?: WatchListener<string>): FSWatcher;
  export function watch(
    path: string,
    options: WatchOptions,
    listener?: WatchListener<string>,
  ): FSWatcher;
  /* fs.watchFile — stat polling (scr_watch_file.c, libuv's uv_fs_poll
   * shape): the listener runs with (current, previous) Stats when a poll
   * sees a difference, the first poll only records the baseline, and a
   * path that cannot be stat'd polls as all-zero Stats. One poller per
   * resolved path is shared by every listener on it. interval defaults to
   * 5007 ms, persistent defaults to true; bigint: true (BigIntStats) has
   * no lowering. The call is a statement: Node's StatWatcher has no
   * lowering. */
  export interface StatWatcher {}
  export function watchFile(
    filename: string,
    options: { interval?: number; persistent?: boolean; bigint?: false },
    listener: (current: Stats, previous: Stats) => void,
  ): StatWatcher;
  export function watchFile(
    filename: string,
    listener: (current: Stats, previous: Stats) => void,
  ): StatWatcher;
  export function unwatchFile(
    filename: string,
    listener?: (current: Stats, previous: Stats) => void,
  ): void;
  /* fs.promises IS the fs/promises module (Node's rule) — the namespace-
   * import form `fs.promises.readFile(...)` lowers through the same
   * fs/promises table as `import { readFile } from "node:fs/promises"`. */
  export const promises: typeof import("node:fs/promises");
}

/* Every builtin answers to BOTH specifier forms, like in Node: the bare
 * module re-exports its node:-prefixed twin (or holds the declarations
 * itself — one of the pair forwards). The lowerer recognizes members by
 * their import SPECIFIER, so both forms lower identically. */
declare module "fs" {
  export * from "node:fs";
}
