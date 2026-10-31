import { createHash } from "node:crypto";
import { checkerBackend } from "./checker-backend.js";
import { checkerExecutableIdentity } from "./lib-diagnostics.js";
import { TS7_FILE_SYSTEM_CALLBACKS } from "./rpc-filesystem.js";

/** How long a shared checker server waits for the next build before it
 * exits, in seconds. */
export const CHECKER_SERVER_IDLE_EXIT = 600;

/** The resident memory, in megabytes, above which a shared checker server
 * exits after a build. tsc-ts never frees a program's syntax trees, types and
 * symbols, so its memory grows with each build it serves. */
export const CHECKER_SERVER_MEMORY = 2048;

/** Whether builds use a shared checker server: by default, except in CI
 * (`CI` set to anything but `0` or `false`), where a job usually builds once
 * per directory and would only leave the server behind.
 * `SCRIPTC_CHECKER_SERVER=0` turns it off and `SCRIPTC_CHECKER_SERVER=1` turns
 * it on in CI. */
function checkerServerEnabled(env: NodeJS.ProcessEnv): boolean {
  const setting = env["SCRIPTC_CHECKER_SERVER"];
  if (setting === "1") return true;
  if (setting === "0") return false;
  const ci = env["CI"];
  return ci === undefined || ci === "" || ci === "0" || ci === "false";
}

/**
 * On Linux and macOS, the native compiler checks with a tsc-ts server shared
 * by the builds that follow (`tsc-ts --api --listen`): a build connects to
 * it, starting it when none answers, and the server keeps the files it
 * parsed for the next build (see checkerServerEnabled for when). Returns the
 * server's name, a digest of everything a server's answers depend on
 * besides the files it reads through the build: the tsc-ts executable, the
 * working directory, the file system callbacks, timing, whether it reads its
 * library files from the disk, and the `TSC_TS_*` environment; and of the
 * compiler executable, so that each scriptc build has servers of its own.
 * Returns null when the shared server is not used.
 */
export function checkerServerName(
  executable: string,
  cwd: string,
  timing: boolean,
  env: NodeJS.ProcessEnv = process.env,
  librariesFromDisk = false,
  compiler: string = process.execPath,
): string | null {
  if (!checkerServerEnabled(env)) return null;
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  if (checkerBackend(env) !== "tsc-ts") return null;
  const tscTsEnv = Object.keys(env)
    .filter((name) => name.startsWith("TSC_TS_"))
    .sort()
    .map((name) => [name, env[name] ?? ""]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        checkerExecutableIdentity(executable),
        checkerExecutableIdentity(compiler),
        cwd,
        TS7_FILE_SYSTEM_CALLBACKS,
        timing,
        librariesFromDisk,
        tscTsEnv,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}
