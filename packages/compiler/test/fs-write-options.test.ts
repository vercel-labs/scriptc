/* The three-argument writeFileSync forms whose options record is a `const`
 * binding. The lowering inlines the record's literal values at the write
 * site, so it accepts the binding only when the record is readonly: Node
 * reads the record when the call runs, and a mutable record may have
 * changed since its initializer (`OPTS.mode = 0o644` must reach the
 * write). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fs-write-options-"));
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

/** Lower one program and answer its IR module, or the diagnostics. */
async function lowerSource(
  source: string,
): Promise<{ ok: true; module: IrModule } | { ok: false; messages: string[] }> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fs-write-mode-"));
  try {
    const entry = join(directory, "main.ts");
    const outPath = join(directory, "main.ir.json");
    writeFileSync(entry, source);
    const result = await compile(entry, { outDir: directory, outPath, outputKind: "ir" });
    if (!result.ok) return { ok: false, messages: result.diagnostics.map((d) => d.message) };
    return { ok: true, module: deserializeModule(readFileSync(outPath, "utf8")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The libCall fns and the named calls any statement holds. */
function scan(module: IrModule): { libFns: string[]; callees: string[] } {
  const libFns: string[] = [];
  const callees: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as { kind?: unknown; fn?: unknown; callee?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string") libFns.push(node.fn);
    if (node.kind === "call" && typeof node.callee === "string") callees.push(node.callee);
    for (const child of Object.values(value)) visit(child);
  };
  visit(module.functions);
  return { libFns, callees };
}

test.each([
  ["as const", 'const OPTS = { encoding: "utf-8", mode: 0o600 } as const;'],
  [
    "a Readonly<> annotation",
    'const OPTS: Readonly<{ encoding: "utf-8"; mode: number }> = { encoding: "utf-8", mode: 0o600 };',
  ],
])("a readonly const record (%s) keeps lowering", async (_what, declaration) => {
  const result = await compileSource(`import * as fs from "node:fs";
${declaration}
fs.writeFileSync("scratch.json", "{}", OPTS);
`);
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
});

test("a descriptor write of a string|Uint8Array parameter needs no record", async () => {
  const result = await compileSource(`import * as fs from "node:fs";
function write(target: number, data: string | Uint8Array): void {
  fs.writeFileSync(target, data);
}
function append(target: number, data: string | Uint8Array): void {
  fs.appendFileSync(target, data);
}
write(3, "x");
append(3, new Uint8Array([1]));
`);
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
});

test("a mode expression typed as one octal string is evaluated and parsed", async () => {
  const lowered = await lowerSource(`import * as fs from "node:fs";
let calls = 0;
function octalMode(): "600" {
  calls += 1;
  return "600";
}
fs.writeFileSync("scratch.json", "{}", { mode: octalMode() });
console.log(calls);
`);
  if (!lowered.ok) throw new Error(lowered.messages.join("\n"));
  const { libFns, callees } = scan(lowered.module);
  expect(callees).toContain("octalMode");
  expect(libFns).toContain("num.parseInt");
});

test("a MUTABLE const record fences: its mode may change before the call", async () => {
  const result = await compileSource(`import * as fs from "node:fs";
const OPTS: { encoding: "utf-8"; mode: number } = { encoding: "utf-8", mode: 0o600 };
OPTS.mode = 0o644;
fs.writeFileSync("scratch.json", "{}", OPTS);
`);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the write options fence");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("writeFileSync with 3 arguments"),
      }),
    ]),
  );
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
});
