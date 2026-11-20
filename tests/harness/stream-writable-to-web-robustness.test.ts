/* Writable.toWeb over a writable-like object: two settlement contracts the
 * adapter owns, asserted as the compiled program's own answers. A
 * differential case cannot state the first: Node leaves that write pending,
 * while the adapter settles it so a pipe cannot strand. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const PRELUDE = `import { Writable } from "node:stream";
const encoder = new TextEncoder();
function fake(highWaterMark = 16) {
  const listeners = new Map();
  const emit = (name, arg) => {
    for (const fn of listeners.get(name) ?? []) fn(arg);
  };
  const target = {
    writable: true,
    destroyed: false,
    writableNeedDrain: false,
    writableHighWaterMark: highWaterMark,
    chunks: [],
    write(chunk) {
      target.chunks.push(Buffer.from(chunk).toString());
      return true;
    },
    end() {
      target.writable = false;
      setImmediate(() => emit("finish"));
    },
    destroy(error) {
      target.destroyed = true;
      target.writable = false;
      if (error) emit("error", error);
      setImmediate(() => emit("close"));
    },
    on(name, fn) {
      const list = listeners.get(name);
      if (list) list.push(fn);
      else listeners.set(name, [fn]);
      return target;
    },
    removeListener(name, fn) {
      const list = listeners.get(name);
      if (list) listeners.set(name, list.filter((entry) => entry !== fn));
      return target;
    },
    emitLocal(name, arg) {
      emit(name, arg);
    },
  };
  return target;
}
`;

// Node leaves this write pending: its eos clean-end branch errors the stream
// but never rejects the backpressure promise. The adapter settles the write
// with the same AbortError it errors the stream with, so a write or pipe
// waiting on drain cannot strand.
const FINISH_PENDING = `${PRELUDE}
const target = fake(1);
target.write = function (chunk) {
  target.chunks.push(Buffer.from(chunk).toString());
  target.writableNeedDrain = true;
  return false;
};
const web = Writable.toWeb(target);
const writer = web.getWriter();
const write = writer.write(encoder.encode("xy")).then(
  () => "resolved",
  (error) => "rejected " + error.name + " " + error.code,
);
setTimeout(() => target.end(), 5);
const outcome = await Promise.race([
  write,
  new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
]);
console.log("finish pending " + outcome);
`;

// Node resolves this write too: the error clears needDrain, the sink write
// answers at once, and the stream's error reaches the writer through the
// controller. The adapter must not read writableNeedDrain through a target
// the synchronous error already released.
const SYNC_ERROR_DURING_WRITE = `${PRELUDE}
const target = fake();
target.write = function (chunk) {
  target.chunks.push(Buffer.from(chunk).toString());
  target.writableNeedDrain = false;
  target.emitLocal("error", new Error("sync fail"));
  return false;
};
const web = Writable.toWeb(target);
const writer = web.getWriter();
const outcome = await Promise.race([
  writer.write(encoder.encode("x")).then(
    () => "resolved",
    (error) => "rejected " + error.message,
  ),
  new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
]);
console.log("sync error " + outcome);
`;

async function run(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-writable-to-web-robustness-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", stderr: "", code: -1 };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? -1 };
  }
}

test("a finish without a close rejects a write waiting on drain", async () => {
  const { stdout } = await run(FINISH_PENDING);
  expect(stdout).toContain("finish pending rejected AbortError ABORT_ERR");
});

test("a synchronous error during write settles the write", async () => {
  const { stdout } = await run(SYNC_ERROR_DURING_WRITE);
  expect(stdout).toContain("sync error resolved");
});
