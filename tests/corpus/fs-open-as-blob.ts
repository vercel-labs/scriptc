// fs.openAsBlob(path[, options]): Node's SYNCHRONOUS ladder — the options
// object, `options.type || ''` and its string check, the path's type and
// null-byte check, then the stat — and the promise it answers, which is
// already resolved. The Blob is file-backed and read lazily: its size is the
// stat's, its type the given string verbatim, slices and structured clones
// share the file, and every read re-checks the file, answering a
// NotReadableError once its size or mtime changed (or it went away).
import { mkdirSync, mkdtempSync, openAsBlob, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scr-open-as-blob-"));
const clean = (text: string): string => text.split(dir).join("<dir>");
const errorShape = (error: unknown): string => {
  const e = error as { code?: string; message: string };
  return `${e.code} | ${clean(e.message)}`;
};
const report = (label: string, run: () => unknown): void => {
  try {
    console.log(label, "ok", run() instanceof Promise);
  } catch (error) {
    console.log(label, "throw", errorShape(error));
  }
};

async function main(): Promise<void> {
  const file = join(dir, "a.txt");
  writeFileSync(file, "hello world");

  // The options object is validated before the path, and its value must be
  // an object: null, arrays, functions and the primitives all throw. The
  // invalid values cross as untyped dynamic values (`dynamic`): a cast to
  // the typed options shape would build a checked record — and its own
  // $.type error — before the call.
  const dynamic = (value: unknown): any => value;
  report("options null", () => openAsBlob(file, dynamic(null)));
  report("options array", () => openAsBlob(file, dynamic([])));
  report("options string", () => openAsBlob(file, dynamic("s")));
  report("options number", () => openAsBlob(file, dynamic(5)));
  report("options boolean", () => openAsBlob(file, dynamic(true)));
  report("options function", () => openAsBlob(file, dynamic(() => {})));
  report("options symbol", () => openAsBlob(file, dynamic(Symbol("x"))));
  report("options bigint", () => openAsBlob(file, dynamic(5n)));
  report("type number", () => openAsBlob(file, dynamic({ type: 5 })));
  report("type boolean", () => openAsBlob(file, dynamic({ type: true })));
  report("type object", () => openAsBlob(file, dynamic({ type: {} })));

  // The path's type error comes second — the options' error wins.
  report("order", () => openAsBlob(5 as unknown as string, dynamic({ type: 5 })));
  report("path undefined", () => openAsBlob(undefined as unknown as string));
  report("path number", () => openAsBlob(5 as unknown as string));
  report("path null", () => openAsBlob(null as unknown as string));
  report("path nul", () => openAsBlob("a\0b"));
  report("path nul bytes", () => openAsBlob(Buffer.from("a\0b")));
  report("missing", () => openAsBlob(join(dir, "nope.txt")));
  report("scheme", () => openAsBlob(new URL("https://example.invalid/x")));

  // A successful call answers an already-settled promise for a Blob (not a
  // File) whose type is the given string, verbatim.
  const blob = await openAsBlob(file);
  console.log(
    "blob",
    blob.size,
    JSON.stringify(blob.type),
    blob instanceof Blob,
    blob instanceof File,
  );
  console.log("text", await blob.text(), await blob.text());
  console.log(
    "bytes",
    (await blob.bytes()).length,
    new Uint8Array(await blob.arrayBuffer()).length,
  );

  const typed = await openAsBlob(file, { type: " Text/Plain " });
  console.log("verbatim", JSON.stringify(typed.type));
  console.log("accent", JSON.stringify((await openAsBlob(file, { type: "é" })).type));
  console.log("empty type", JSON.stringify((await openAsBlob(file, { type: "" })).type));
  console.log("no type", JSON.stringify((await openAsBlob(file, {})).type));
  // A falsy `type` is the empty string (`options.type || ''`), whatever it is.
  console.log("falsy type", JSON.stringify((await openAsBlob(file, dynamic({ type: 0 }))).type));
  console.log("nan type", JSON.stringify((await openAsBlob(file, dynamic({ type: NaN }))).type));

  const byUrl = await openAsBlob(new URL(`file://${file}`));
  console.log("url", byUrl.size, await byUrl.text());
  const byBytes = await openAsBlob(Buffer.from(file));
  console.log("buffer", byBytes.size, await byBytes.text());

  // Slices, wrapping and structured clones share the file-backed parts.
  const slice = blob.slice(1, 4);
  console.log("slice", slice.size, await slice.text(), slice instanceof Blob);
  console.log("slice neg", blob.slice(-5).size, await blob.slice(-5).text());
  console.log("slice empty", blob.slice(2, 2).size, JSON.stringify(await blob.slice(2, 2).text()));
  console.log("slice past", blob.slice(20, 30).size);
  console.log("slice of slice", await blob.slice(2).slice(2, 5).text());
  const wrapped = new Blob([blob]);
  console.log("wrapped", wrapped.size, await wrapped.text());
  const named = new File([blob], "n.txt");
  console.log("file", named.name, named.size, await named.text());

  try {
    structuredClone(blob);
  } catch (error) {
    const e = error as { code?: string; message: string };
    console.log("clone direct", errorShape(e));
  }
  const clone = structuredClone(blob.slice(0, 5));
  console.log("clone slice", clone.size, await clone.text());
  const cloneWrapped = structuredClone(new Blob([blob]));
  console.log("clone wrapped", cloneWrapped.size, await cloneWrapped.text());

  // Every read re-checks the file: a changed size, a changed mtime, a
  // replacement and a deletion all answer a NotReadableError (and the first
  // two keep the change visible to slices and clones).
  const resized = await openAsBlob(file);
  writeFileSync(file, "hello world!");
  try {
    await resized.text();
  } catch (error) {
    const e = error as { name: string; message: string };
    console.log("resized", e.name, e.message, error instanceof Error);
  }
  writeFileSync(file, "hello world");

  const retimed = await openAsBlob(file);
  const old = new Date(2020, 1, 2, 3, 4, 5);
  utimesSync(file, old, old);
  try {
    await retimed.bytes();
  } catch (error) {
    console.log("retimed", (error as { name: string }).name);
  }

  const removed = await openAsBlob(file);
  rmSync(file);
  try {
    await removed.arrayBuffer();
  } catch (error) {
    console.log("removed", (error as { name: string }).name);
  }

  writeFileSync(file, "hello world");
  const replaced = await openAsBlob(file);
  const shared = new Blob([replaced]);
  writeFileSync(file, "HELLO WORLD");
  try {
    await shared.text();
  } catch (error) {
    console.log("shared", (error as { name: string }).name);
  }

  // An empty file reads as nothing; a directory stats and fails on the read.
  writeFileSync(file, "");
  const empty = await openAsBlob(file);
  console.log("empty", empty.size, JSON.stringify(await empty.text()));
  const folder = join(dir, "d");
  mkdirSync(folder);
  const directory = await openAsBlob(folder);
  console.log("directory", directory.size > 0);
  try {
    await directory.text();
  } catch (error) {
    console.log("directory read", (error as { name: string }).name);
  }

  rmSync(dir, { recursive: true, force: true });
}

void main();
