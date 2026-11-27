import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

type Lowered = { ok: true; ir: string } | { ok: false; diagnostics: string[] };

/** The serialized IR of one entry file, or its refusals. */
async function lower(source: string): Promise<Lowered> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-readable-from-lowering-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return { ok: false, diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`) };
    return { ok: true, ir: await readFile(outPath, "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The source text of the first `readable.iterator` call's second argument. */
function iteratorFlag(ir: string): string | null {
  const match = /"fn":"readable\.iterator","args":\[(.*?)\],"type"/.exec(ir);
  return match ? match[1]! : null;
}

test("Readable.from opens the stream's iterator with destroyOnReturn", async () => {
  // from.js calls the source's Symbol.asyncIterator with no options, whose
  // destroyOnReturn default is true: destroying the wrapper destroys the
  // source stream, closing a file stream whose data the wrapper never read
  // to EOF.
  const result = await lower(`
    import { Readable } from "node:stream";
    function wrap(source: Readable): Readable {
      return Readable.from(source);
    }
    console.log(typeof wrap);
  `);
  if (!result.ok) throw new Error(result.diagnostics.join("\n"));
  const args = iteratorFlag(result.ir);
  expect(args).not.toBeNull();
  expect(args).toContain(`"kind":"boolLit","value":true`);
});

test("a base-typed source whose subclasses override Symbol.asyncIterator is refused", async () => {
  // The value may be the subclass, whose iterator guards must run; the
  // native fast path would drive the built-in stream state past it, and the
  // static type does not name the value's class.
  const result = await lower(`
    import { Readable } from "node:stream";
    class Redacting extends Readable {
      override [Symbol.asyncIterator](): any {
        return super[Symbol.asyncIterator]();
      }
    }
    function wrap(source: Readable): Readable {
      return Readable.from(source);
    }
    console.log(Redacting, typeof wrap);
  `);
  if (result.ok) throw new Error("expected the base-typed source to be refused");
  expect(result.diagnostics.join("\n")).toContain(
    "SC2020: 'Readable.from over a stream whose subclasses override Symbol.asyncIterator'",
  );
});

test("a plain stream still takes the native source lowering", async () => {
  const result = await lower(`
    import { Readable } from "node:stream";
    function wrap(source: Readable): Readable {
      return Readable.from(source);
    }
    console.log(typeof wrap);
  `);
  if (!result.ok) throw new Error(result.diagnostics.join("\n"));
  expect(result.ir).toContain(`"fn":"readable.iterator"`);
  expect(result.ir).toContain(`"fn":"readable.fromAsyncIter"`);
});
