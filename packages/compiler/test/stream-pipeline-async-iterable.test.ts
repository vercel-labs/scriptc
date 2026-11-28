/* `stream/promises.pipeline` over a class that declares
 * [Symbol.asyncIterator]: Node pumps any async iterable source, so a
 * program class with that protocol method (the undici shim's BodyReadable
 * is one) is a valid first stage. The source is boxed as a
 * checked-dynamic iterable and pumped by the same runtime helper untyped
 * iterable sources use, so IR emission is the check that needs no
 * toolchain. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function compileToIr(source: string): Promise<{ ok: boolean; codes: string[]; ir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-pipeline-iterable-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts");
  const outDir = join(dir, ".scriptc");
  const outPath = join(outDir, "main.ir.json");
  await writeFile(entry, source);
  const result = await compile(entry, { outDir, outPath, outputKind: "ir" });
  const ir = result.ok ? await readFile(outPath, "utf8") : "";
  return {
    ok: result.ok,
    codes: result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code),
    ir,
  };
}

test("pipeline pumps a class with an async iterator as its source", async () => {
  const result = await compileToIr(
    [
      'import { pipeline } from "node:stream/promises";',
      'import { createWriteStream } from "node:fs";',
      "class Source {",
      "  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {",
      '    yield "a";',
      '    yield "b";',
      "  }",
      "}",
      'await pipeline(new Source(), createWriteStream("/tmp/scriptc-pipeline-out"));',
      'console.log("done");',
      "",
    ].join("\n"),
  );
  expect(result.codes).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.ir).toContain("sp.pipeline");
});

test("pipeline still refuses a class that is not a stream or an iterable", async () => {
  const result = await compileToIr(
    [
      'import { pipeline } from "node:stream/promises";',
      'import { createWriteStream } from "node:fs";',
      "class NotASource {",
      "  value = 1;",
      "}",
      'await pipeline(new NotASource(), createWriteStream("/tmp/scriptc-pipeline-out"));',
      "",
    ].join("\n"),
  );
  expect(result.codes).toContain("SC2020");
});
