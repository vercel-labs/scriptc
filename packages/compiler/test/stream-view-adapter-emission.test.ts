import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// A capsule of a runtime stream names the runtime's scr_stream_ref_view as
// its snapshot adapter when the stream's view is the runtime's alone: that
// address is how the runtime knows that it can answer a question about one
// member from the stream's tables (ScrStreamRefHooks). A class of the
// program below the stream class has members the tables do not describe, so
// its capsules keep an adapter of their own.
async function emit(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-stream-view-adapter-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ask = `
function hasFlush(h: unknown): boolean {
  return typeof h === "object" && h !== null && typeof (h as Record<string, unknown>).flush === "function";
}
`;

test("a runtime stream seen as unknown names the runtime's view and gets no adapter", async () => {
  const llvm = await emit(`
import { PassThrough, Writable } from "node:stream";
${ask}
const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
console.log(hasFlush(sink), hasFlush(new PassThrough()));
`);
  expect(llvm).toMatch(/^declare ptr @scr_stream_ref_view\(ptr\)/m);
  expect(llvm).toMatch(/ptr @scr_stream_ref_view[,)]/);
  expect(llvm).not.toMatch(/define internal ptr @sc_ldr_\d+_materialize\(/);
});

test("a program subclass of a stream class keeps its own adapter", async () => {
  const llvm = await emit(`
import { Writable } from "node:stream";
${ask}
class Sink extends Writable {
  flush(): void {}
}
console.log(hasFlush(new Sink()));
`);
  expect(llvm).toMatch(/define internal ptr @sc_ldr_\d+_materialize\(/);
  expect(llvm).not.toContain("@scr_stream_ref_view");
});
