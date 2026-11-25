/* Readable.toWeb over a type: "bytes" stream: a chunk that is not an
 * ArrayBufferView (a string or an object from an object-mode readable) cannot
 * enter the byte stream. Node's controller throws ERR_INVALID_ARG_TYPE from
 * its data listener, which ends the program; the adapter errors the stream
 * with the same error so the read rejects instead of the chunk being dropped.
 * A differential case cannot state this: the Node side does not survive it. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const NON_VIEW_CHUNK = `import { Readable } from "node:stream";

const stream = Readable.from([{ a: 1 }, new Uint8Array([7, 8])], { objectMode: true });
const web = Readable.toWeb(stream, { type: "bytes" });
const reader = web.getReader({ mode: "byob" });
try {
  const chunk = await reader.read(new Uint8Array(4));
  console.log("read " + chunk.done);
} catch (error) {
  console.log("rejected " + error.code + " " + error.message);
}
try {
  await reader.read(new Uint8Array(4));
  console.log("second accepted");
} catch (error) {
  console.log("second rejected " + error.code);
}
`;

async function run(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-readable-to-web-bytes-"));
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

test("a chunk that is not a view rejects the byte stream's read", async () => {
  const { stdout, code } = await run(NON_VIEW_CHUNK);
  expect(code).toBe(0);
  expect(stdout).toContain(
    'rejected ERR_INVALID_ARG_TYPE The "buffer" argument must be an instance of Buffer, TypedArray, or DataView. Received an instance of Object',
  );
  expect(stdout).toContain("second rejected ERR_INVALID_ARG_TYPE");
});
