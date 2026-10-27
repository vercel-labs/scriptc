import { existsSync, realpathSync, statSync } from "node:fs";
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
      if (existsSync(executable)) return executable;
    }
    throw new Error(`tsc-ts checker: ${root} has no ${platformPackage} executable`);
  }
  throw new Error("tsc-ts checker: the tsc-ts package is not installed");
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
