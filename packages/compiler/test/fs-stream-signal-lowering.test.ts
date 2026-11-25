import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** How often the module calls each fs stream constructor. A call whose
 * options can hold a `signal` names the `...Signal` entry, which selects the
 * fs stream unit's SCR_FS_STREAM_SIGNAL build. */
async function streamCalls(source: string, name = "main.ts"): Promise<Record<string, number>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-fs-stream-signal-"));
  try {
    const entry = join(dir, name);
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const calls: Record<string, number> = {};
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: unknown; fn?: unknown };
      if (
        node.kind === "libCall" &&
        typeof node.fn === "string" &&
        /^(fs|fileHandle)\.create(Read|Write)Stream/.test(node.fn)
      )
        calls[node.fn] = (calls[node.fn] ?? 0) + 1;
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    return calls;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HEAD = `import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
interface Options {
  encoding?: "utf8";
  signal?: AbortSignal;
}
`;

test("options that cannot hold a signal keep the default fs stream entries", async () => {
  const calls = await streamCalls(`${HEAD}
const narrow = { encoding: "utf8" as const, highWaterMark: 16 };
const base = { start: 1 };
createReadStream("a");
createReadStream("a", "utf8");
createReadStream("a", { encoding: "utf8", highWaterMark: 1 << 20 });
createReadStream("a", narrow);
createReadStream("a", { ...base, end: 4 });
createReadStream("a", undefined);
createWriteStream("b", { flags: "a" });
async function handles(): Promise<void> {
  const handle = await open("a");
  handle.createReadStream();
  handle.createReadStream({ start: 2 });
  handle.createWriteStream({ flush: true });
}
handles();
`);
  expect(calls).toEqual({
    "fs.createReadStream": 6,
    "fs.createWriteStream": 1,
    "fileHandle.createReadStream": 2,
    "fileHandle.createWriteStream": 1,
  });
});

test("options that can hold a signal name the signal entries", async () => {
  const calls = await streamCalls(`${HEAD}
const controller = new AbortController();
const signal: AbortSignal | undefined = controller.signal;
const built = { encoding: "utf8" as const, signal };
const base = { signal: controller.signal };
function declared(options: Options): void {
  createReadStream("a", options);
}
function untyped(options: any): void {
  createReadStream("a", options);
}
function open1<T>(options: T): void {
  createReadStream("a", options as never);
}
createReadStream("a", { signal: controller.signal });
createReadStream("a", { encoding: "utf8", signal });
createReadStream("a", built);
createReadStream("a", { ...base, start: 1 });
createReadStream("a", { ["signal"]: controller.signal });
createReadStream("a", ({ signal: undefined }) as Options);
createWriteStream("b", { signal });
async function handles(): Promise<void> {
  const handle = await open("a");
  handle.createReadStream({ signal });
  handle.readLines({ signal });
  handle.createWriteStream(built as { highWaterMark?: number });
}
declared({});
untyped({});
open1({});
handles();
`);
  expect(calls).toEqual({
    "fs.createReadStreamSignal": 9,
    "fs.createWriteStreamSignal": 1,
    "fileHandle.createReadStreamSignal": 2,
    "fileHandle.createWriteStreamSignal": 1,
  });
});

test("untyped options in a JavaScript source name the signal entries, literals without one do not", async () => {
  const calls = await streamCalls(
    `const fs = require("node:fs");
function open(options) {
  return fs.createReadStream("a", options);
}
open({});
fs.createReadStream("a", { highWaterMark: 4 });
new fs.WriteStream("b", { flags: "w" });
new fs.ReadStream("a", { signal: AbortSignal.abort() });
`,
    "main.cjs",
  );
  expect(calls).toEqual({
    "fs.createReadStreamSignal": 2,
    "fs.createReadStream": 1,
    "fs.createWriteStream": 1,
  });
});
