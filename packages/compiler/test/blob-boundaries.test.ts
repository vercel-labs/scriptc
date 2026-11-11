import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-blob-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Members of the declared Blob and File surface outside the native
// handle fail during compilation instead of reaching a missing runtime
// operation.
test.each([
  ["Blob.constructor", 'console.log(new Blob(["a"]).constructor);'],
  ["File.valueOf", 'console.log(new File([], "f").valueOf());'],
])("%s fails during compilation", async (what, use) => {
  const result = await compileSource(`${use}\n`);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a Blob diagnostic");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "SC2020", message: expect.stringContaining(what) }),
    ]),
  );
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
});

test("the native Blob and File surface compiles", async () => {
  const result = await compileSource(`import { Blob as B, File as F } from "node:buffer";
const blob = new Blob(["a", new Uint8Array([98])], { type: "text/plain", endings: "native" });
const file = new F([blob], "f.txt", { lastModified: 1 });
console.log(blob.size, blob.type, file.name, file.lastModified, String(blob), blob.toString());
console.log(blob instanceof B, file instanceof File, blob.slice(1, 2, "x/y").size);
void blob.text().then((text) => console.log(text));
void file.bytes().then((bytes) => console.log(bytes.length));
void new B([]).arrayBuffer().then((buffer) => console.log(buffer.byteLength));
console.log(blob.stream() instanceof ReadableStream, file.textStream() instanceof ReadableStream);
console.log(structuredClone(file).name, JSON.stringify(blob), Object.keys(blob));
`);
  expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
});
