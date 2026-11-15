/* The Hono starter, as `create-hono` generates it for Node.js, built and
 * run in the project it generates. tests/fixtures/hono-starter is the
 * `nodejs` template of honojs/starter (c59d199): src/index.ts and
 * tsconfig.json byte for byte, and its package.json with a name and the
 * versions its ranges resolved to on 2026-11-06 pinned (hono 4.13.16,
 * @hono/node-server 2.1.6, @types/node 26.6.6; `tsx` and `typescript`,
 * which only its scripts use, left out). It is a workspace package, so the
 * program is checked the way a generated project is: against its own
 * @types/node, under its own tsconfig.
 *
 * The starter calls `serve({ fetch, port: 3000 })` with no hostname and
 * never exits. Each lane (Node, then the compiled executable) is started,
 * asked the same requests over fresh connections, and stopped with
 * SIGTERM. The lanes must match in the server's stdout and stderr, how it
 * ended, and every response byte for byte (the Date header aside).
 *
 * The port is the template's, so the lanes of every run on one host take
 * turns through a lock directory.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const project = join(repoRoot, "tests/fixtures/hono-starter");
const entry = join(project, "src/index.ts");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const PORT = 3000;
const BANNER = `Server is running on http://localhost:${PORT}\n`;

const REQUESTS = [
  "GET / HTTP/1.1",
  "GET /missing HTTP/1.1",
  "HEAD / HTTP/1.1",
  "POST / HTTP/1.1",
] as const;

interface Lane {
  stdout: string;
  stderr: string;
  /** The exit code, or the signal that ended the process. */
  ended: number | string;
  /** The raw response to each of REQUESTS, without its Date header. */
  responses: string[];
}

/** One request on its own connection; the whole response as the server
 * wrote it. */
function exchange(requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.setTimeout(20_000, () => socket.destroy(new Error(`no response to ${requestLine}`)));
    socket.on("connect", () => {
      socket.write(`${requestLine}\r\nHost: localhost:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(
        Buffer.concat(chunks)
          .toString("latin1")
          .replace(/^Date: [^\r\n]*\r\n/im, ""),
      );
    });
  });
}

function runLane(cmd: string, args: string[]): Promise<Lane> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let responses: Promise<string[]> | null = null;
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (responses !== null || !stdout.includes(BANNER)) return;
      responses = (async () => {
        const all: string[] = [];
        for (const line of REQUESTS) all.push(await exchange(line));
        return all;
      })().finally(() => child.kill("SIGTERM"));
      // Reported when the process has closed; never an unhandled rejection.
      responses.catch(() => {});
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ended = signal ?? code ?? -1;
      if (responses === null) {
        reject(new Error(`the server ended (${ended}) before listening\n${stdout}${stderr}`));
        return;
      }
      responses.then((all) => resolve({ stdout, stderr, ended, responses: all }), reject);
    });
  });
}

/** Holds the template's port for this process: a directory in the system
 * temporary directory that only one run creates at a time. A holder that
 * died leaves it behind, so one older than the longest lane is taken over. */
async function withPort<T>(run: () => Promise<T>): Promise<T> {
  const lock = join(tmpdir(), `scriptc-test-port-${PORT}.lock`);
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 180_000) rmSync(lock, { recursive: true });
      } catch {
        // Released between the two calls.
      }
      await sleep(250);
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

describe(`hono starter${sanitize ? " (sanitized)" : ""}`, () => {
  let node: Lane;
  let native: Lane;

  beforeAll(async () => {
    const outDir = join(
      repoRoot,
      "node_modules/.cache/scriptc-tests",
      `hono-starter-${sanitize ? "san" : "plain"}`,
    );
    const result = await compile(entry, { outPath: join(outDir, "server"), outDir, sanitize });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    await withPort(async () => {
      node = await runLane(process.execPath, [entry]);
      native = await runLane(result.binaryPath, []);
    });
  }, 600_000);

  test("Node serves the starter", () => {
    expect(node.stdout).toBe(BANNER);
    expect(node.responses[0]).toMatch(/^HTTP\/1\.1 200 OK\r\n[^]*\r\n\r\nHello Hono!$/);
    expect(node.responses[1]).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
  });

  test("the executable builds in the generated project, listens and answers", () => {
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
    expect(native.ended).toBe(node.ended);
    expect(native.responses.map((r) => /^HTTP\/1\.1 \d{3} /.test(r))).toEqual(
      REQUESTS.map(() => true),
    );
  });

  // Expected to fail until a fence the build knows about no longer ships on
  // a reached path (the build's island policy, branch
  // fix/build-island-policy): hono 4.13.16's RegExpRouter builds its
  // matcher with `path.match(regexp).slice(...)`, which compiles to a
  // deferred SC2020 throw (router/reg-exp-router/router.js:78). Every
  // request reaches it through `app.fetch`, and the adapter answers an
  // error from the handler with an empty 500, as the published adapter
  // does. Node answers 200 and 404. hono 4.13.13 (tests/fixtures/npm) has
  // the earlier router and matches. Make this a plain `test` when the
  // responses match.
  test.fails("every response matches Node byte for byte", () => {
    expect(native.responses).toEqual(node.responses);
  });
});
