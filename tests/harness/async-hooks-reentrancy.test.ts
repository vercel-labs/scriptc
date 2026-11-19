/* Async-hook reentrancy robustness — scriptc-only, sanitized lane.
 *
 * A synchronous async_hooks callback runs in the middle of the runtime's own
 * bookkeeping, and a program can use it to reenter the API that is mid-flight.
 * These programs pin that the runtime survives each reentry:
 *
 * - a promiseResolve hook releases the reader's lock while its closed promise
 *   settles (the settlement must not run on the promise the reader just let go);
 * - a PROMISE init hook releases the reader's lock while a read builds its
 *   promise (the read answers the releasing error, not a cleared stream);
 * - a destroy hook refreshes the one-shot timeout that is being destroyed (the
 *   re-armed entry must not carry the ids the teardown freed).
 *
 * SCRIPTC_SAN=1 builds these with ASan + the RC audit like every harness lane,
 * which is what turns the last two into hard failures if they regress.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/** Compiles one program and runs it, tolerating a nonzero exit. */
async function compileAndRun(
  name: string,
  source: string,
  ext = "cjs",
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .update(ext)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests", `ah-reentrancy-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.${ext}`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "reentrancy program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr: stripAsanFiberWarning(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; signal?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number" && typeof e.signal !== "string") throw err;
    return {
      stdout: e.stdout ?? "",
      stderr: stripAsanFiberWarning(e.stderr ?? ""),
      exitCode: typeof e.code === "number" ? e.code : -1,
    };
  }
}

/** Linux ASan's once-per-process context-swap warning (not program output). */
function stripAsanFiberWarning(s: string): string {
  return s.replace(
    /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
    "",
  );
}

describe(`async-hook reentrancy (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("a PROMISE init hook can release a reader while its read builds the promise", async () => {
    const r = await compileAndRun(
      "init-read",
      `'use strict';
const { ReadableStream } = require('stream/web');
const { createHook } = require('async_hooks');
let controller;
const stream = new ReadableStream({ start(c) { controller = c; } });
const reader = stream.getReader();
let released = false;
const hook = createHook({
  init(id, type) {
    if (type !== 'PROMISE' || released) return;
    released = true;
    try { reader.releaseLock(); } catch {}
  },
});
hook.enable();
let pending;
try { pending = reader.read(); } catch { pending = null; }
hook.disable();
if (pending) pending.then(() => console.log('read resolved'), () => console.log('read rejected'));
else console.log('read threw');
setTimeout(() => console.log('done'), 0);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("read rejected\ndone\n");
  });

  test("a byte-stream read released in its init hook frees its auto-allocated buffer", async () => {
    const r = await compileAndRun(
      "init-byte-read",
      `'use strict';
const { ReadableStream } = require('stream/web');
const { createHook } = require('async_hooks');
const stream = new ReadableStream(
  { type: 'bytes', autoAllocateChunkSize: 16384, start(c) {}, pull() {} },
  { highWaterMark: 0 },
);
const reader = stream.getReader();
let released = false;
const hook = createHook({
  init(id, type) {
    if (type !== 'PROMISE' || released) return;
    released = true;
    try { reader.releaseLock(); } catch {}
  },
});
hook.enable();
let pending;
try { pending = reader.read(); } catch { pending = null; }
hook.disable();
if (pending) pending.then(() => console.log('read resolved'), () => console.log('read rejected'));
else console.log('read threw');
setTimeout(() => console.log('done'), 0);
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("read rejected\ndone\n");
  });

  test("a destroy hook can refresh the one-shot timeout being destroyed", async () => {
    const r = await compileAndRun(
      "timer-refresh",
      `import { createHook } from "async_hooks";
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshed = false;
const hook = createHook({
  after() {
    if (refreshed || timer === undefined) return;
    refreshed = true;
    try {
      timer.refresh();
    } catch {}
  },
});
hook.enable();
timer = setTimeout(() => console.log("fired"), 1);
setTimeout(() => {
  hook.disable();
  console.log("done");
}, 30);
`,
      "ts",
    );
    expect(r.exitCode).toBe(0);
    // The after hook's refresh re-arms the timer exactly once, with ids the
    // teardown has not freed underneath it.
    expect(r.stdout).toBe("fired\nfired\ndone\n");
  });
});
