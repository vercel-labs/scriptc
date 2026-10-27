import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { tsgoExecutable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";
import { TS7_FILE_SYSTEM_CALLBACKS } from "../../packages/compiler/src/frontend/ts7/rpc-filesystem.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

function result(
  child: ChildProcess,
): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`TypeScript client timed out: ${stderr}`));
    }, 45_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

export async function runClient(
  command: string,
  args: string[],
  directory: string,
  report: string,
): Promise<string> {
  // The protocol cases echo bytes that are not UTF-8 text, which tsc-ts 0.0.3
  // returns decoded, so the transport is checked against tsgo.
  const server = spawn(
    tsgoExecutable(),
    ["--api", "--timing", "--cwd", directory, `--callbacks=${TS7_FILE_SYSTEM_CALLBACKS}`],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let serverStderr = "";
  server.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    serverStderr += chunk;
  });
  const serverDone = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });
  let serverError: Error | undefined;
  server.on("error", (error) => {
    serverError = error;
  });
  try {
    // Node creates POSIX pipes nonblocking. Both consumers below use sync
    // reads; change that property before inheriting the underlying handles.
    if (process.platform !== "win32") {
      for (const stream of [server.stdin, server.stdout]) {
        (
          stream as unknown as { _handle: { setBlocking: (value: boolean) => void } }
        )._handle.setBlocking(true);
      }
    }
    const child = spawn(command, [...args, directory, report], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", server.stdout, server.stdin],
    });
    const actual = await result(child);
    expect(serverError).toBeUndefined();
    expect(actual.signal, actual.stderr + serverStderr).toBeNull();
    expect(actual.status, actual.stderr + serverStderr).toBe(0);
    expect(actual.stdout).toBe("");
    expect(actual.stderr).toBe("");
    expect(serverStderr).toBe("");
    return readFileSync(report, "utf8");
  } finally {
    server.stdin.destroy();
    server.stdout.destroy();
    server.kill();
    await serverDone;
  }
}
