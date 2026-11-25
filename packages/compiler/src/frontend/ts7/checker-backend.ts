import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The TypeScript 7 API servers a compile can check with: tsc-ts, the default,
 * and tsgo from the `typescript` package, selected with `SCRIPTC_CHECKER=tsgo`.
 * Both serve the same API and give the same results. On Windows the Node host
 * connects to either over a named pipe the server creates (rpc-process.ts). */
export type CheckerBackend = "tsgo" | "tsc-ts";

export function checkerBackend(env: NodeJS.ProcessEnv = process.env): CheckerBackend {
  const value = env["SCRIPTC_CHECKER"];
  if (value === undefined || value === "") return "tsc-ts";
  if (value === "tsc-ts") return "tsc-ts";
  if (value === "tsgo") return "tsgo";
  throw new Error(`SCRIPTC_CHECKER must be tsgo or tsc-ts, not ${JSON.stringify(value)}`);
}

/** tsc-ts's platform package for a host: `@tsc-ts/linux-x64-gnu`,
 * `@tsc-ts/darwin-arm64`, `@tsc-ts/win32-x64-msvc`, and so on. */
export function tscTsPlatformPackage(
  platform: string,
  architecture: string,
  musl: boolean,
): string {
  const abi =
    platform === "linux" ? (musl ? "-musl" : "-gnu") : platform === "win32" ? "-msvc" : "";
  return `@tsc-ts/${platform}-${architecture}${abi}`;
}

let hostMusl: boolean | undefined;

/** Whether this process runs on musl, the libc of tsc-ts's `-musl` Linux packages: Node reports no glibc
 * runtime version there. The libc cannot change within a process, and a report is costly to generate. */
export function hostIsMusl(): boolean {
  if (process.platform !== "linux") return false;
  if (hostMusl === undefined) {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    hostMusl = typeof report?.header?.glibcVersionRuntime !== "string";
  }
  return hostMusl;
}

/** The checker's part of an executable cache key: the identity of the tsc-ts
 * executable, or undefined for tsgo, whose keys predate the choice. */
export function checkerCacheIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (checkerBackend(env) === "tsgo") return undefined;
  const path = hostTscTsExecutable();
  const info = statSync(path);
  return JSON.stringify({
    path,
    canonical: realpathSync(path),
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtime: info.mtimeMs,
    ctime: info.ctimeMs,
  });
}

/** The Node host's tsc-ts executable: that of the `tsc-ts` package installed
 * with this compiler, or else for the working directory. */
export function hostTscTsExecutable(): string {
  return tscTsExecutable(
    [dirname(fileURLToPath(import.meta.url)), process.cwd()],
    tscTsPlatformPackage(process.platform, process.arch, hostIsMusl()),
    process.platform,
  );
}

/** The tsc-ts executable of the `tsc-ts` package in the nearest
 * `node_modules` above each of `starts`, in order. The platform package is
 * installed next to `tsc-ts` (npm) or in the directory that holds it (pnpm). */
export function tscTsExecutable(
  starts: readonly string[],
  platformPackage: string,
  platform: string,
): string {
  const name = platform === "win32" ? "tsc-ts.exe" : "tsc-ts";
  for (const start of starts) {
    const packageRoot = installedPackage(start, "tsc-ts");
    if (packageRoot === undefined) continue;
    const root = realpathSync(packageRoot);
    for (const candidate of [
      join(root, "node_modules", platformPackage),
      join(dirname(root), platformPackage),
    ]) {
      const executable = join(candidate, "lib", name);
      if (existsSync(executable)) {
        if (platform === "linux") writeCheckerOnce(executable);
        return executable;
      }
    }
    throw new Error(`tsc-ts checker: ${root} has no ${platformPackage} executable`);
  }
  throw new Error("tsc-ts checker: the tsc-ts package is not installed");
}

/** The checker executables writeCheckerOnce looked at in this process: each is
 * checked once, whatever the outcome. */
const checkersSeen = new Set<string>();

/**
 * Writes the tsc-ts executable again with one write, once per installed
 * copy. Its code maps with 2 MiB pages when the page cache holds the file in
 * 2 MiB folios, which a file written with one write gets on file systems with
 * large folios (XFS, ext4 from Linux 6.16); package managers write it in
 * chunks, which leaves 4 KiB folios until the file is read from disk again.
 * The copy is renamed into place, and `.tsc-ts-written` beside it holds its
 * size, as tsc-ts's own launcher (bin/tsc-ts.js) writes it, so whichever runs
 * first makes the copy. When the directory is not writable, the executable
 * stays as installed, and it is not read. Each executable is checked once per
 * process. Linux only; the callers check the platform.
 */
export function writeCheckerOnce(executable: string): void {
  if (checkersSeen.has(executable)) return;
  checkersSeen.add(executable);
  const marker = join(dirname(executable), ".tsc-ts-written");
  let size: number;
  try {
    size = statSync(executable).size;
  } catch {
    return;
  }
  try {
    if (readFileSync(marker, "utf8") === String(size)) return;
  } catch {
    // No copy has been written.
  }
  // The copy goes beside the executable: in a directory this process cannot
  // write, the executable is not read at all.
  try {
    accessSync(dirname(executable), constants.W_OK);
  } catch {
    return;
  }
  try {
    const bytes = readFileSync(executable);
    replaceFile(executable, bytes, statSync(executable).mode & 0o7777);
    replaceFile(marker, Buffer.from(String(bytes.length)), 0o644);
  } catch {
    // The executable stays as installed.
  }
}

/** Replaces `file` with `bytes` and `mode` through a new file beside it. The
 * copy has an unpredictable name and is created exclusively (an existing
 * path, a symbolic link included, is never opened) with mode 0600, so no
 * other user can open it while it is written; it gets `mode` from its own
 * descriptor before it is renamed into place. Only a copy this call created
 * is removed. */
function replaceFile(file: string, bytes: Uint8Array, mode: number): void {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (let offset = 0; offset < bytes.length;)
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, mode);
    closeSync(fd);
    renameSync(temporary, file);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Closed before the failure.
    }
    unlinkSync(temporary);
    throw error;
  }
}

function installedPackage(start: string, name: string): string | undefined {
  let directory = resolve(start);
  for (;;) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
