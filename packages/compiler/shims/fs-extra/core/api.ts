// fs-extra's exports over node:fs.
//
// fs-extra re-exports every fs member and wraps the asynchronous ones with
// universalify: a call whose last argument is a function takes the callback
// form, any other call returns a promise. The wrapped methods below follow
// that rule over fs.promises (callback forms settle through the promise);
// fs's other members are fs's own. The extra methods (copy, remove, mkdirs,
// the JSON helpers, ...) restate fs-extra's behavior and error messages.
// graceful-fs's EMFILE retry queue, which fs-extra loads under Node, has no
// counterpart: on Node 24 it only changes behavior when the process runs
// out of file descriptors.
//
// What is not declared here is a compile-time error: ensureLink,
// ensureSymlink, createLink, createSymlink and their sync forms,
// gracefulify, the descriptor-based methods' promise forms (fstat, read,
// write, ...), the callback forms of the methods that answer stats,
// listings or paths (stat, lstat, readdir, mkdtemp, realpath, readJson),
// Buffer and URL paths, and option shapes fs.promises does not compile
// natively (copyFile mode flags, append options, write flags, string modes,
// numeric utimes times). A readFile callback that fails receives an empty
// value beside the error, where Node passes undefined.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Stats } from "node:fs";

// fs's other members, as fs-extra re-exports them (fs-extra's own versions
// of the wrapped methods below take their place).
export {
  appendFileSync,
  accessSync,
  chownSync,
  chmodSync,
  close,
  closeSync,
  copyFileSync,
  cp,
  cpSync,
  createReadStream,
  createWriteStream,
  exists,
  existsSync,
  fchown,
  fchownSync,
  fchmod,
  fchmodSync,
  fdatasync,
  fdatasyncSync,
  fstat,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncate,
  ftruncateSync,
  futimes,
  futimesSync,
  lchownSync,
  linkSync,
  lstatSync,
  lutimes,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  open,
  openSync,
  readdirSync,
  read,
  readSync,
  readv,
  readvSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statfs,
  statSync,
  statfsSync,
  symlinkSync,
  truncateSync,
  unwatchFile,
  unlinkSync,
  utimesSync,
  watch,
  watchFile,
  writeFileSync,
  write,
  writeSync,
  writev,
  writevSync,
  Dirent,
  Stats,
  ReadStream,
  WriteStream,
  Dir,
  opendir,
  opendirSync,
  constants,
  promises,
} from "node:fs";

/** A Node-style callback with a result. */
export type Callback<T> = (err: NodeJS.ErrnoException | null, value: T) => void;
/** A Node-style callback without a result. */
export type VoidCallback = (err: NodeJS.ErrnoException | null) => void;

export type SymlinkType = "dir" | "file" | "junction";
export type Utf8 = "utf8" | "utf-8";

export interface WriteFileOptions {
  encoding?: Utf8 | undefined;
  mode?: number | undefined;
}

export interface ReadOptions {
  throws?: boolean | undefined;
  encoding?: Utf8 | undefined;
}

export interface WriteOptions {
  encoding?: Utf8 | undefined;
  mode?: number | undefined;
  spaces?: number | undefined;
  EOL?: string | undefined;
  finalEOL?: boolean | undefined;
}

/** A copy filter: fs-extra accepts a boolean or a promise of one. */
export type CopyFilter = (src: string, dest: string) => boolean | Promise<boolean>;

export interface CopyOptions {
  dereference?: boolean | undefined;
  overwrite?: boolean | undefined;
  preserveTimestamps?: boolean | undefined;
  errorOnExist?: boolean | undefined;
  filter?: CopyFilter | undefined;
}

export interface CopyOptionsSync {
  dereference?: boolean | undefined;
  overwrite?: boolean | undefined;
  preserveTimestamps?: boolean | undefined;
  errorOnExist?: boolean | undefined;
  filter?: ((src: string, dest: string) => boolean) | undefined;
}

export interface MoveOptions {
  overwrite?: boolean | undefined;
}

export interface EnsureOptions {
  mode?: number | undefined;
}

export interface MakeDirectoryOptions {
  recursive?: boolean | undefined;
  mode?: number | undefined;
}

export interface RmOptions {
  force?: boolean | undefined;
  recursive?: boolean | undefined;
}

function settleVoid(promise: Promise<void>, callback: VoidCallback | undefined): Promise<void> {
  if (callback === undefined) return promise;
  // The callback form's promise settles only through the callback (it
  // never rejects); fs-extra answers undefined there.
  return promise.then(
    () => callback(null),
    (err: NodeJS.ErrnoException) => callback(err),
  );
}

/** The result of a callback-form call that settles through fs's own
 * callback: callers ignore it (fs-extra answers undefined). */
function idle(): Promise<never> {
  return new Promise<never>(() => undefined);
}

function codeOf(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

/* ── fs methods in universalify's wrapper ─────────────────────────────── */

export function access(path: string, mode?: number): Promise<void>;
export function access(path: string, callback: VoidCallback): void;
export function access(path: string, mode: number, callback: VoidCallback): void;
export function access(
  path: string,
  mode?: number | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof mode === "function") return settleVoid(fsp.access(path), mode);
  return settleVoid(fsp.access(path, mode ?? fs.constants.F_OK), callback);
}

export function appendFile(path: string, data: string | Uint8Array): Promise<void>;
export function appendFile(path: string, data: string | Uint8Array, callback: VoidCallback): void;
export function appendFile(
  path: string,
  data: string | Uint8Array,
  callback?: VoidCallback,
): Promise<void> {
  return settleVoid(fsp.appendFile(path, data), callback);
}

/** fs.writeFileSync(file, bytes, { mode }) as Node runs it: open with
 * O_WRONLY | O_CREAT | O_TRUNC and the mode, write every byte, close. */
function writeBytesSync(file: string, data: Uint8Array, mode: number): void {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    mode,
  );
  try {
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
  } finally {
    fs.closeSync(fd);
  }
}

async function writeData(
  file: string,
  data: string | Uint8Array,
  options: WriteFileOptions | Utf8 | undefined,
): Promise<void> {
  if (typeof data !== "string") {
    // fs.promises.writeFile compiles string data; bytes take the
    // synchronous write after the same microtask boundary.
    await Promise.resolve();
    if (options === undefined || typeof options === "string") fs.writeFileSync(file, data);
    else writeBytesSync(file, data, options.mode ?? 0o666);
    return;
  }
  if (options === undefined || typeof options === "string")
    return fsp.writeFile(file, data, "utf8");
  return fsp.writeFile(file, data, { encoding: "utf8", mode: options.mode ?? 0o666 });
}

export function writeFile(
  file: string,
  data: string | Uint8Array,
  options?: WriteFileOptions | Utf8,
): Promise<void>;
export function writeFile(file: string, data: string | Uint8Array, callback: VoidCallback): void;
export function writeFile(
  file: string,
  data: string | Uint8Array,
  options: WriteFileOptions | Utf8,
  callback: VoidCallback,
): void;
export function writeFile(
  file: string,
  data: string | Uint8Array,
  options?: WriteFileOptions | Utf8 | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function") return settleVoid(writeData(file, data, undefined), options);
  return settleVoid(writeData(file, data, options), callback);
}

export function chmod(path: string, mode: number): Promise<void>;
export function chmod(path: string, mode: number, callback: VoidCallback): void;
export function chmod(path: string, mode: number, callback?: VoidCallback): Promise<void> {
  return settleVoid(fsp.chmod(path, mode), callback);
}

export function chown(path: string, uid: number, gid: number): Promise<void>;
export function chown(path: string, uid: number, gid: number, callback: VoidCallback): void;
export function chown(
  path: string,
  uid: number,
  gid: number,
  callback?: VoidCallback,
): Promise<void> {
  return settleVoid(fsp.chown(path, uid, gid), callback);
}

export function lchown(path: string, uid: number, gid: number): Promise<void>;
export function lchown(path: string, uid: number, gid: number, callback: VoidCallback): void;
export function lchown(
  path: string,
  uid: number,
  gid: number,
  callback?: VoidCallback,
): Promise<void> {
  return settleVoid(fsp.lchown(path, uid, gid), callback);
}

export function copyFile(src: string, dest: string): Promise<void>;
export function copyFile(src: string, dest: string, callback: VoidCallback): void;
export function copyFile(src: string, dest: string, callback?: VoidCallback): Promise<void> {
  return settleVoid(fsp.copyFile(src, dest), callback);
}

export function link(existingPath: string, newPath: string): Promise<void>;
export function link(existingPath: string, newPath: string, callback: VoidCallback): void;
export function link(
  existingPath: string,
  newPath: string,
  callback?: VoidCallback,
): Promise<void> {
  return settleVoid(fsp.link(existingPath, newPath), callback);
}

export function lstat(path: string): Promise<Stats> {
  return fsp.lstat(path);
}

export function stat(path: string): Promise<Stats> {
  return fsp.stat(path);
}

async function makeDirectory(
  path: string,
  options: number | MakeDirectoryOptions | undefined,
): Promise<void> {
  if (options === undefined) return fsp.mkdir(path);
  if (typeof options === "number") return fsp.mkdir(path, { mode: options });
  const mode = options.mode ?? 0o777;
  if (options.recursive === true) return fsp.mkdir(path, { recursive: true, mode });
  return fsp.mkdir(path, { mode });
}

export function mkdir(path: string, options?: number | MakeDirectoryOptions): Promise<void>;
export function mkdir(path: string, callback: VoidCallback): void;
export function mkdir(
  path: string,
  options: number | MakeDirectoryOptions,
  callback: VoidCallback,
): void;
export function mkdir(
  path: string,
  options?: number | MakeDirectoryOptions | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function") return settleVoid(makeDirectory(path, undefined), options);
  return settleVoid(makeDirectory(path, options), callback);
}

export function mkdtemp(prefix: string): Promise<string> {
  return fsp.mkdtemp(prefix);
}

export function readdir(path: string): Promise<string[]> {
  return fsp.readdir(path);
}

export type ReadFileOptions = Utf8 | { encoding: Utf8 };

export function readFile(file: string): Promise<Buffer>;
export function readFile(file: string, options: ReadFileOptions): Promise<string>;
export function readFile(file: string, callback: Callback<Buffer>): void;
export function readFile(file: string, options: ReadFileOptions, callback: Callback<string>): void;
export function readFile(
  file: string,
  options?: ReadFileOptions | Callback<Buffer>,
  callback?: Callback<string>,
): Promise<string | Buffer> {
  if (typeof options === "function") {
    fsp.readFile(file).then(
      (data) => options(null, data),
      (err: NodeJS.ErrnoException) => options(err, Buffer.alloc(0)),
    );
    return idle();
  }
  if (options === undefined) return fsp.readFile(file);
  if (callback !== undefined) {
    fsp.readFile(file, "utf8").then(
      (text) => callback(null, text),
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
    return idle();
  }
  return fsp.readFile(file, "utf8");
}

export function readlink(path: string): Promise<string>;
export function readlink(path: string, callback: Callback<string>): void;
export function readlink(path: string, callback?: Callback<string>): Promise<string> {
  if (callback !== undefined) {
    fs.readlink(path, (err, target) => callback(err, target));
    return idle();
  }
  return fsp.readlink(path);
}

export function realpath(path: string): Promise<string> {
  return fsp.realpath(path);
}

export function rename(oldPath: string, newPath: string): Promise<void>;
export function rename(oldPath: string, newPath: string, callback: VoidCallback): void;
export function rename(oldPath: string, newPath: string, callback?: VoidCallback): Promise<void> {
  return settleVoid(fsp.rename(oldPath, newPath), callback);
}

/** Removes a file or directory tree; a missing path is not an error
 * (fs-extra's rimraf and fs.rm's force). */
async function removeTree(target: string): Promise<void> {
  let entry: Stats;
  try {
    entry = await fsp.lstat(target);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return;
    throw err;
  }
  if (entry.isDirectory()) {
    for (const item of await fsp.readdir(target)) await removeTree(path.join(target, item));
    await fsp.rmdir(target);
    return;
  }
  await fsp.unlink(target);
}

async function rmPath(target: string, options: RmOptions | undefined): Promise<void> {
  const recursive = options === undefined ? false : (options.recursive ?? false);
  const force = options === undefined ? false : (options.force ?? false);
  if (recursive && force) return removeTree(target);
  if (!recursive && !force) return fsp.rm(target);
  // The mixed forms: fs.rm's own checks, then the walk.
  if (force && !fs.existsSync(target)) return;
  const entry = await fsp.lstat(target);
  if (entry.isDirectory() && !recursive) return fsp.rm(target);
  return removeTree(target);
}

export function rm(path: string, options?: RmOptions): Promise<void>;
export function rm(path: string, callback: VoidCallback): void;
export function rm(path: string, options: RmOptions, callback: VoidCallback): void;
export function rm(
  path: string,
  options?: RmOptions | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function") return settleVoid(rmPath(path, undefined), options);
  return settleVoid(rmPath(path, options), callback);
}

export function rmdir(path: string): Promise<void>;
export function rmdir(path: string, callback: VoidCallback): void;
export function rmdir(path: string, callback?: VoidCallback): Promise<void> {
  return settleVoid(fsp.rmdir(path), callback);
}

export function symlink(target: string, path: string, type?: SymlinkType): Promise<void>;
export function symlink(target: string, path: string, callback: VoidCallback): void;
export function symlink(
  target: string,
  path: string,
  type: SymlinkType | undefined,
  callback: VoidCallback,
): void;
export function symlink(
  target: string,
  path: string,
  type?: SymlinkType | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof type === "function") return settleVoid(fsp.symlink(target, path), type);
  return settleVoid(fsp.symlink(target, path, type ?? null), callback);
}

export function truncate(path: string, len?: number): Promise<void>;
export function truncate(path: string, callback: VoidCallback): void;
export function truncate(path: string, len: number, callback: VoidCallback): void;
export function truncate(
  path: string,
  len?: number | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof len === "function") return settleVoid(fsp.truncate(path, 0), len);
  return settleVoid(fsp.truncate(path, len ?? 0), callback);
}

export function unlink(path: string): Promise<void>;
export function unlink(path: string, callback: VoidCallback): void;
export function unlink(path: string, callback?: VoidCallback): Promise<void> {
  return settleVoid(fsp.unlink(path), callback);
}

export function utimes(path: string, atime: Date, mtime: Date): Promise<void>;
export function utimes(path: string, atime: Date, mtime: Date, callback: VoidCallback): void;
export function utimes(
  path: string,
  atime: Date,
  mtime: Date,
  callback?: VoidCallback,
): Promise<void> {
  return settleVoid(fsp.utimes(path, atime, mtime), callback);
}

/* ── mkdirs, ensureDir, mkdirp ────────────────────────────────────────── */

function dirMode(options: EnsureOptions | number | undefined): number {
  if (options === undefined) return 0o777;
  if (typeof options === "number") return options;
  return options.mode ?? 0o777;
}

function makeDir(dir: string, mode: number): Promise<void> {
  return fsp.mkdir(path.resolve(dir), { recursive: true, mode });
}

function makeDirSync(dir: string, mode: number): void {
  fs.mkdirSync(path.resolve(dir), { recursive: true, mode });
}

export function ensureDir(dir: string, options?: EnsureOptions | number): Promise<void>;
export function ensureDir(dir: string, callback: VoidCallback): void;
export function ensureDir(
  dir: string,
  options: EnsureOptions | number,
  callback: VoidCallback,
): void;
export function ensureDir(
  dir: string,
  options?: EnsureOptions | number | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function") return settleVoid(makeDir(dir, 0o777), options);
  return settleVoid(makeDir(dir, dirMode(options)), callback);
}

export function mkdirs(dir: string, options?: EnsureOptions | number): Promise<void>;
export function mkdirs(dir: string, callback: VoidCallback): void;
export function mkdirs(
  dir: string,
  options?: EnsureOptions | number | VoidCallback,
): Promise<void> {
  if (typeof options === "function") return settleVoid(makeDir(dir, 0o777), options);
  return makeDir(dir, dirMode(options));
}

export function mkdirp(dir: string, options?: EnsureOptions | number): Promise<void>;
export function mkdirp(dir: string, callback: VoidCallback): void;
export function mkdirp(
  dir: string,
  options?: EnsureOptions | number | VoidCallback,
): Promise<void> {
  if (typeof options === "function") return settleVoid(makeDir(dir, 0o777), options);
  return makeDir(dir, dirMode(options));
}

export function ensureDirSync(dir: string, options?: EnsureOptions | number): void {
  makeDirSync(dir, dirMode(options));
}

export function mkdirsSync(dir: string, options?: EnsureOptions | number): void {
  makeDirSync(dir, dirMode(options));
}

export function mkdirpSync(dir: string, options?: EnsureOptions | number): void {
  makeDirSync(dir, dirMode(options));
}

/* ── remove, emptyDir ─────────────────────────────────────────────────── */

export function remove(dir: string): Promise<void>;
export function remove(dir: string, callback: VoidCallback): void;
export function remove(dir: string, callback?: VoidCallback): Promise<void> {
  return settleVoid(removeTree(dir), callback);
}

export function removeSync(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function emptyDirAsync(dir: string): Promise<void> {
  let items: string[];
  try {
    items = await fsp.readdir(dir);
  } catch {
    await makeDir(dir, 0o777);
    return;
  }
  while (items.length > 0) {
    const item = items.pop();
    if (item !== undefined) await removeTree(path.join(dir, item));
  }
}

export function emptyDir(dir: string): Promise<void>;
export function emptyDir(dir: string, callback: VoidCallback): void;
export function emptyDir(dir: string, callback?: VoidCallback): Promise<void> {
  return settleVoid(emptyDirAsync(dir), callback);
}

export function emptyDirSync(dir: string): void {
  let items: string[];
  try {
    items = fs.readdirSync(dir);
  } catch {
    makeDirSync(dir, 0o777);
    return;
  }
  for (const item of items) fs.rmSync(path.join(dir, item), { recursive: true, force: true });
}

/* ── pathExists, ensureFile, outputFile ───────────────────────────────── */

async function pathExistsAsync(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

export function pathExists(file: string): Promise<boolean>;
export function pathExists(file: string, callback: Callback<boolean>): void;
export function pathExists(file: string, callback?: Callback<boolean>): Promise<boolean> {
  const found = pathExistsAsync(file);
  if (callback === undefined) return found;
  return found.then((exists) => {
    callback(null, exists);
    return exists;
  });
}

export function pathExistsSync(file: string): boolean {
  return fs.existsSync(file);
}

async function createFileAsync(file: string): Promise<void> {
  try {
    if ((await fsp.stat(file)).isFile()) return;
  } catch {
    // Missing: created below.
  }
  const dir = path.dirname(file);
  let dirIsDirectory = true;
  try {
    dirIsDirectory = (await fsp.stat(dir)).isDirectory();
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
    await makeDir(dir, 0o777);
  }
  // A parent that is not a directory fails with readdir's ENOTDIR.
  if (!dirIsDirectory) await fsp.readdir(dir);
  await fsp.writeFile(file, "", "utf8");
}

export function ensureFile(file: string): Promise<void>;
export function ensureFile(file: string, callback: VoidCallback): void;
export function ensureFile(file: string, callback?: VoidCallback): Promise<void> {
  return settleVoid(createFileAsync(file), callback);
}

export function ensureFileSync(file: string): void {
  try {
    if (fs.statSync(file).isFile()) return;
  } catch {
    // Missing: created below.
  }
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) makeDirSync(dir, 0o777);
  fs.writeFileSync(file, "");
}

async function outputFileAsync(
  file: string,
  data: string | Uint8Array,
  options: WriteFileOptions | Utf8 | undefined,
): Promise<void> {
  const dir = path.dirname(file);
  if (!(await pathExistsAsync(dir))) await makeDir(dir, 0o777);
  await writeData(file, data, options);
}

export function outputFile(
  file: string,
  data: string | Uint8Array,
  options?: WriteFileOptions | Utf8,
): Promise<void>;
export function outputFile(file: string, data: string | Uint8Array, callback: VoidCallback): void;
export function outputFile(
  file: string,
  data: string | Uint8Array,
  options: WriteFileOptions | Utf8,
  callback: VoidCallback,
): void;
export function outputFile(
  file: string,
  data: string | Uint8Array,
  options?: WriteFileOptions | Utf8 | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function")
    return settleVoid(outputFileAsync(file, data, undefined), options);
  return settleVoid(outputFileAsync(file, data, options), callback);
}

export function outputFileSync(file: string, data: string | Uint8Array): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) makeDirSync(dir, 0o777);
  fs.writeFileSync(file, data);
}

/* ── JSON (jsonfile) ──────────────────────────────────────────────────── */

function jsonText(value: unknown, options: WriteOptions | Utf8 | undefined): string {
  const opts = options === undefined || typeof options === "string" ? undefined : options;
  const eol = opts === undefined ? "\n" : (opts.EOL ?? "\n");
  const finalEol = opts === undefined ? true : (opts.finalEOL ?? true);
  const spaces = opts === undefined ? 0 : (opts.spaces ?? 0);
  const text = JSON.stringify(value, null, spaces) ?? "undefined";
  return text.replace(/\n/g, eol) + (finalEol ? eol : "");
}

function jsonWriteOptions(options: WriteOptions | Utf8 | undefined): WriteFileOptions | undefined {
  if (options === undefined || typeof options === "string") return undefined;
  return { mode: options.mode };
}

function jsonThrows(options: ReadOptions | Utf8 | undefined): boolean {
  if (options === undefined || typeof options === "string") return true;
  return options.throws ?? true;
}

function prefixed(file: string, err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  error.message = `${file}: ${error.message}`;
  return error;
}

function parseJson(file: string, text: string, throws: boolean): any {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    if (!throws) return null;
    throw prefixed(file, err);
  }
}

async function readJsonAsync(file: string, options: ReadOptions | Utf8 | undefined): Promise<any> {
  const text = await fsp.readFile(file, "utf8");
  return parseJson(file, text, jsonThrows(options));
}

// readJson's callback form is not declared.
export function readJson(file: string, options?: ReadOptions | Utf8): Promise<any> {
  return readJsonAsync(file, options);
}

export function readJsonSync(file: string, options?: ReadOptions | Utf8): any {
  const throws = jsonThrows(options);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    // jsonfile reads inside the same try as the parse.
    if (!throws) return null;
    throw prefixed(file, err);
  }
  return parseJson(file, text, throws);
}

async function writeJsonAsync(
  file: string,
  value: unknown,
  options: WriteOptions | Utf8 | undefined,
): Promise<void> {
  await writeData(file, jsonText(value, options), jsonWriteOptions(options));
}

export function writeJson(file: string, value: any, options?: WriteOptions | Utf8): Promise<void>;
export function writeJson(file: string, value: any, callback: VoidCallback): void;
export function writeJson(
  file: string,
  value: any,
  options: WriteOptions | Utf8,
  callback: VoidCallback,
): void;
export function writeJson(
  file: string,
  value: any,
  options?: WriteOptions | Utf8 | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function")
    return settleVoid(writeJsonAsync(file, value, undefined), options);
  return settleVoid(writeJsonAsync(file, value, options), callback);
}

export function writeJsonSync(file: string, value: any, options?: WriteOptions | Utf8): void {
  const text = jsonText(value, options);
  if (options === undefined || typeof options === "string") fs.writeFileSync(file, text, "utf8");
  else fs.writeFileSync(file, text, { encoding: "utf8", mode: options.mode ?? 0o666 });
}

async function outputJsonAsync(
  file: string,
  value: unknown,
  options: WriteOptions | Utf8 | undefined,
): Promise<void> {
  const dir = path.dirname(file);
  if (!(await pathExistsAsync(dir))) await makeDir(dir, 0o777);
  await writeJsonAsync(file, value, options);
}

export function outputJson(file: string, value: any, options?: WriteOptions | Utf8): Promise<void>;
export function outputJson(file: string, value: any, callback: VoidCallback): void;
export function outputJson(
  file: string,
  value: any,
  options: WriteOptions | Utf8,
  callback: VoidCallback,
): void;
export function outputJson(
  file: string,
  value: any,
  options?: WriteOptions | Utf8 | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function")
    return settleVoid(outputJsonAsync(file, value, undefined), options);
  return settleVoid(outputJsonAsync(file, value, options), callback);
}

export function outputJsonSync(file: string, value: any, options?: WriteOptions | Utf8): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) makeDirSync(dir, 0o777);
  writeJsonSync(file, value, options);
}

/* ── copy, move ───────────────────────────────────────────────────────── */

function isSrcSubdir(src: string, dest: string): boolean {
  const srcParts = path
    .resolve(src)
    .split(path.sep)
    .filter((part) => part !== "");
  const destParts = path
    .resolve(dest)
    .split(path.sep)
    .filter((part) => part !== "");
  for (let i = 0; i < srcParts.length; i++) if (destParts[i] !== srcParts[i]) return false;
  return true;
}

function subdirMessage(src: string, dest: string, verb: string): string {
  return `Cannot ${verb} '${src}' to a subdirectory of itself, '${dest}'.`;
}

function sameNode(a: Stats, b: Stats): boolean {
  return b.ino !== 0 && b.dev !== 0 && a.ino === b.ino && a.dev === b.dev;
}

async function statOrNull(file: string): Promise<Stats | null> {
  try {
    return await fsp.stat(file);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return null;
    throw err;
  }
}

/** fs-extra's checkPaths and checkParentPaths: the source exists, is not
 * the destination, and a directory never copies or moves into itself.
 * Answers whether the destination exists. */
async function checkPaths(src: string, dest: string, verb: string): Promise<boolean> {
  const srcStat = await fsp.stat(src);
  const destStat = await statOrNull(dest);
  if (destStat !== null && sameNode(srcStat, destStat))
    throw new Error("Source and destination must not be the same.");
  if (srcStat.isDirectory() && isSrcSubdir(src, dest))
    throw new Error(subdirMessage(src, dest, verb));
  const srcParent = path.resolve(path.dirname(src));
  let destParent = path.resolve(path.dirname(dest));
  while (destParent !== srcParent && destParent !== path.parse(destParent).root) {
    const parentStat = await statOrNull(destParent);
    if (parentStat === null) break;
    if (sameNode(srcStat, parentStat)) throw new Error(subdirMessage(src, dest, verb));
    destParent = path.resolve(path.dirname(destParent));
  }
  return destStat !== null;
}

function statOrNullSync(file: string): Stats | null {
  try {
    return fs.statSync(file);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return null;
    throw err;
  }
}

/** checkPaths for copySync and moveSync. Answers the destination's stats,
 * or null when it does not exist. */
function checkPathsSync(src: string, dest: string, verb: string): Stats | null {
  const srcStat = fs.statSync(src);
  const destStat = statOrNullSync(dest);
  if (destStat !== null && sameNode(srcStat, destStat))
    throw new Error("Source and destination must not be the same.");
  if (srcStat.isDirectory() && isSrcSubdir(src, dest))
    throw new Error(subdirMessage(src, dest, verb));
  const srcParent = path.resolve(path.dirname(src));
  let destParent = path.resolve(path.dirname(dest));
  while (destParent !== srcParent && destParent !== path.parse(destParent).root) {
    const parentStat = statOrNullSync(destParent);
    if (parentStat === null) break;
    if (sameNode(srcStat, parentStat)) throw new Error(subdirMessage(src, dest, verb));
    destParent = path.resolve(path.dirname(destParent));
  }
  return destStat;
}

interface CopyState {
  overwrite: boolean;
  errorOnExist: boolean;
  dereference: boolean;
  preserveTimestamps: boolean;
  filter: CopyFilter | undefined;
}

async function included(state: CopyState, src: string, dest: string): Promise<boolean> {
  const filter = state.filter;
  if (filter === undefined) return true;
  return await filter(src, dest);
}

/** fs-extra's onLink: a symlink source creates a symlink at `dest`. Only
 * a destination that is itself a symlink is replaced; over a regular file
 * or a directory, symlink fails with EEXIST, whatever `overwrite` says. */
async function copyLink(
  target: string,
  dest: string,
  destExists: boolean,
  dereference: boolean,
): Promise<void> {
  if (!destExists) return fsp.symlink(target, dest);
  let destLinked: string;
  try {
    destLinked = await fsp.readlink(dest);
  } catch (err) {
    const code = codeOf(err);
    if (code === "EINVAL" || code === "UNKNOWN") return fsp.symlink(target, dest);
    throw err;
  }
  const destTarget = dereference ? path.resolve(process.cwd(), destLinked) : destLinked;
  checkLinkTargets(target, destTarget, (await fsp.stat(dest)).isDirectory());
  await fsp.unlink(dest);
  await fsp.symlink(target, dest);
}

function copyLinkSync(
  target: string,
  dest: string,
  destExists: boolean,
  dereference: boolean,
): void {
  if (!destExists) {
    fs.symlinkSync(target, dest);
    return;
  }
  let destLinked: string;
  try {
    destLinked = fs.readlinkSync(dest);
  } catch (err) {
    const code = codeOf(err);
    if (code !== "EINVAL" && code !== "UNKNOWN") throw err;
    fs.symlinkSync(target, dest);
    return;
  }
  const destTarget = dereference ? path.resolve(process.cwd(), destLinked) : destLinked;
  checkLinkTargets(target, destTarget, fs.statSync(dest).isDirectory());
  fs.unlinkSync(dest);
  fs.symlinkSync(target, dest);
}

/** Replacing a destination symlink never points it into its own target,
 * nor removes a directory link the source lives under. */
function checkLinkTargets(target: string, destTarget: string, destIsDirectory: boolean): void {
  if (isSrcSubdir(target, destTarget))
    throw new Error(`Cannot copy '${target}' to a subdirectory of itself, '${destTarget}'.`);
  if (destIsDirectory && isSrcSubdir(destTarget, target))
    throw new Error(`Cannot overwrite '${destTarget}' with '${target}'.`);
}

async function copyEntry(
  state: CopyState,
  src: string,
  dest: string,
  destExists: boolean,
  filtered: boolean,
): Promise<void> {
  if (!filtered && !(await included(state, src, dest))) return;
  const srcStat = state.dereference ? await fsp.stat(src) : await fsp.lstat(src);
  if (srcStat.isDirectory()) {
    if (destExists && !(await fsp.stat(dest)).isDirectory())
      throw new Error(`Cannot overwrite non-directory '${dest}' with directory '${src}'.`);
    if (!destExists) await fsp.mkdir(dest);
    const items = await fsp.readdir(src);
    while (items.length > 0) {
      const item = items.pop();
      if (item === undefined) break;
      const srcItem = path.join(src, item);
      const destItem = path.join(dest, item);
      const destItemStat = await statOrNull(destItem);
      if (destItemStat !== null && sameNode(await fsp.stat(srcItem), destItemStat))
        throw new Error("Source and destination must not be the same.");
      await copyEntry(state, srcItem, destItem, destItemStat !== null, false);
    }
    if (!destExists) await fsp.chmod(dest, srcStat.mode);
    return;
  }
  if (srcStat.isSymbolicLink()) {
    const linked = await fsp.readlink(src);
    await copyLink(
      state.dereference ? path.resolve(process.cwd(), linked) : linked,
      dest,
      destExists,
      state.dereference,
    );
    return;
  }
  if (destExists) {
    if (state.overwrite) await fsp.unlink(dest);
    else if (state.errorOnExist) throw new Error(`'${dest}' already exists`);
    else return;
  }
  await fsp.copyFile(src, dest);
  if (state.preserveTimestamps) {
    const updated = await fsp.stat(src);
    if ((srcStat.mode & 0o200) === 0) await fsp.chmod(dest, srcStat.mode | 0o200);
    await fsp.utimes(dest, updated.atime, updated.mtime);
  }
  await fsp.chmod(dest, srcStat.mode);
}

async function copyAsync(
  src: string,
  dest: string,
  options: CopyOptions | undefined,
): Promise<void> {
  const state: CopyState = {
    overwrite: options === undefined ? true : (options.overwrite ?? true),
    errorOnExist: options === undefined ? false : (options.errorOnExist ?? false),
    dereference: options === undefined ? false : (options.dereference ?? false),
    preserveTimestamps: options === undefined ? false : (options.preserveTimestamps ?? false),
    filter: options === undefined ? undefined : options.filter,
  };
  const destExists = await checkPaths(src, dest, "copy");
  if (!(await included(state, src, dest))) return;
  const parent = path.dirname(dest);
  if (!(await pathExistsAsync(parent))) await makeDir(parent, 0o777);
  await copyEntry(state, src, dest, destExists, true);
}

export function copy(src: string, dest: string, options?: CopyOptions): Promise<void>;
export function copy(src: string, dest: string, callback: VoidCallback): void;
export function copy(src: string, dest: string, options: CopyOptions, callback: VoidCallback): void;
export function copy(
  src: string,
  dest: string,
  options?: CopyOptions | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function") return settleVoid(copyAsync(src, dest, undefined), options);
  return settleVoid(copyAsync(src, dest, options), callback);
}

function copyEntrySync(
  state: CopyOptionsSync,
  src: string,
  dest: string,
  destExists: boolean,
  filtered: boolean,
): void {
  const filter = state.filter;
  if (!filtered && filter !== undefined && !filter(src, dest)) return;
  const srcStat = state.dereference === true ? fs.statSync(src) : fs.lstatSync(src);
  if (srcStat.isDirectory()) {
    if (destExists && !fs.statSync(dest).isDirectory())
      throw new Error(`Cannot overwrite non-directory '${dest}' with directory '${src}'.`);
    if (!destExists) fs.mkdirSync(dest);
    for (const item of fs.readdirSync(src)) {
      const srcItem = path.join(src, item);
      const destItem = path.join(dest, item);
      // fs-extra's copyDirItem checks every entry against its destination:
      // a destination symlink back into the source tree must not let the
      // overwrite below unlink the source's own file.
      const destItemStat = statOrNullSync(destItem);
      if (destItemStat !== null && sameNode(fs.statSync(srcItem), destItemStat))
        throw new Error("Source and destination must not be the same.");
      copyEntrySync(state, srcItem, destItem, destItemStat !== null, false);
    }
    if (!destExists) fs.chmodSync(dest, srcStat.mode);
    return;
  }
  if (srcStat.isSymbolicLink()) {
    const dereference = state.dereference === true;
    const linked = fs.readlinkSync(src);
    copyLinkSync(
      dereference ? path.resolve(process.cwd(), linked) : linked,
      dest,
      destExists,
      dereference,
    );
    return;
  }
  if (destExists) {
    if (state.overwrite ?? true) fs.unlinkSync(dest);
    else if (state.errorOnExist === true) throw new Error(`'${dest}' already exists`);
    else return;
  }
  fs.copyFileSync(src, dest);
  if (state.preserveTimestamps === true) {
    const updated = fs.statSync(src);
    if ((srcStat.mode & 0o200) === 0) fs.chmodSync(dest, srcStat.mode | 0o200);
    fs.utimesSync(dest, updated.atime, updated.mtime);
  }
  fs.chmodSync(dest, srcStat.mode);
}

export function copySync(src: string, dest: string, options?: CopyOptionsSync): void {
  const opts: CopyOptionsSync = options ?? {};
  const destStat = checkPathsSync(src, dest, "copy");
  const filter = opts.filter;
  if (filter !== undefined && !filter(src, dest)) return;
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) makeDirSync(parent, 0o777);
  copyEntrySync(opts, src, dest, destStat !== null, true);
}

async function moveAsync(
  src: string,
  dest: string,
  options: MoveOptions | undefined,
): Promise<void> {
  const overwrite = options === undefined ? false : (options.overwrite ?? false);
  await checkPaths(src, dest, "move");
  await makeDir(path.dirname(dest), 0o777);
  if (overwrite) await removeTree(dest);
  else if (await pathExistsAsync(dest)) throw new Error("dest already exists.");
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (codeOf(err) !== "EXDEV") throw err;
    await copyAsync(src, dest, { overwrite, errorOnExist: true });
    await removeTree(src);
  }
}

export function move(src: string, dest: string, options?: MoveOptions): Promise<void>;
export function move(src: string, dest: string, callback: VoidCallback): void;
export function move(src: string, dest: string, options: MoveOptions, callback: VoidCallback): void;
export function move(
  src: string,
  dest: string,
  options?: MoveOptions | VoidCallback,
  callback?: VoidCallback,
): Promise<void> {
  if (typeof options === "function") return settleVoid(moveAsync(src, dest, undefined), options);
  return settleVoid(moveAsync(src, dest, options), callback);
}

export function moveSync(src: string, dest: string, options?: MoveOptions): void {
  const overwrite = options === undefined ? false : (options.overwrite ?? false);
  checkPathsSync(src, dest, "move");
  makeDirSync(path.dirname(dest), 0o777);
  if (overwrite) fs.rmSync(dest, { recursive: true, force: true });
  else if (fs.existsSync(dest)) throw new Error("dest already exists.");
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (codeOf(err) !== "EXDEV") throw err;
    copySync(src, dest, { overwrite, errorOnExist: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/* ── fs-extra's aliases ───────────────────────────────────────────────── */

export {
  emptyDir as emptydir,
  emptyDirSync as emptydirSync,
  ensureFile as createFile,
  ensureFileSync as createFileSync,
  readJson as readJSON,
  readJsonSync as readJSONSync,
  writeJson as writeJSON,
  writeJsonSync as writeJSONSync,
  outputJson as outputJSON,
  outputJsonSync as outputJSONSync,
};
