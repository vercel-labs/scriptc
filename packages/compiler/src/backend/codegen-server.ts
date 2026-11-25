import { createHash } from "node:crypto";
import { nativeFileIdentity } from "../native/file-identity.js";

/** How long a shared code generation server waits for the next build before
 * it exits, in seconds. */
export const CODEGEN_SERVER_IDLE_EXIT = 600;

/** One run of a command line on a resident code generation server. */
export interface CodegenServerResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** A connection to a resident code generation server, carrying one request at
 * a time and each request's captured output. */
export interface CodegenServerConnection {
  run(cwd: string, args: readonly string[]): CodegenServerResult;
  close(): void;
}

/** Opens a connection to the server of `name`, starting it when none answers,
 * or returns null when the server cannot be used. Registered by the native
 * compiler, whose builds have no socket API of their own; the Node host runs
 * its helper processes directly (runOnCodegenServer returns null there). */
let connectServer: ((name: string, executable: string) => CodegenServerConnection | null) | null =
  null;

export function useNativeCodegenServer(
  connect: (name: string, executable: string) => CodegenServerConnection | null,
): void {
  connectServer = connect;
}

/** Whether builds send code generation to a shared server: by default, except
 * in CI (`CI` set to anything but `0` or `false`), where a job usually builds
 * once per directory and would only leave the server behind.
 * `SCRIPTC_CODEGEN_SERVER=0` turns it off and `SCRIPTC_CODEGEN_SERVER=1` turns
 * it on in CI. */
function codegenServerEnabled(env: NodeJS.ProcessEnv): boolean {
  const setting = env["SCRIPTC_CODEGEN_SERVER"];
  if (setting === "1") return true;
  if (setting === "0") return false;
  const ci = env["CI"];
  return ci === undefined || ci === "" || ci === "0" || ci === "false";
}

/**
 * The shared server's name, a digest of everything its answers depend on
 * besides the request itself: the helper executable and the package version
 * it was installed as, the target it emits for, and the compiler executable,
 * so that each scriptc build has servers of its own. Returns null when
 * shared servers are not used or the platform has no sockets for them.
 */
export function codegenServerName(
  helperExecutable: string,
  packageVersion: string,
  targetTriple: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!codegenServerEnabled(env)) return null;
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  let identity: string;
  let compiler: string;
  try {
    identity = nativeFileIdentity(helperExecutable);
    compiler = nativeFileIdentity(process.execPath);
  } catch {
    // An unreadable tool leaves the build to its one-shot path.
    return null;
  }
  return createHash("sha256")
    .update(JSON.stringify([identity, compiler, packageVersion, targetTriple]))
    .digest("hex")
    .slice(0, 32);
}

/** One connection per server name, opened when the build first needs it. A
 * server that fails stops being used for the rest of the build. */
const connections = new Map<string, CodegenServerConnection | null>();

/** Runs `args` on the server named `name`, or returns null when there is no
 * server for this build and the caller should run the helper itself. */
export function runOnCodegenServer(
  name: string,
  executable: string,
  cwd: string,
  args: readonly string[],
): CodegenServerResult | null {
  if (connectServer === null) return null;
  let connection = connections.get(name);
  if (connection === undefined) {
    try {
      connection = connectServer(name, executable);
    } catch {
      connection = null;
    }
    connections.set(name, connection);
  }
  if (connection === null) return null;
  try {
    return connection.run(cwd, args);
  } catch {
    // A server that closed or failed answers nothing more; this build runs
    // the helper itself from here on.
    connection.close();
    connections.set(name, null);
    return null;
  }
}
