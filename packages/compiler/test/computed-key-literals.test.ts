/* A property name decided at runtime has no static home in a record layout:
 * Node evaluates the key where it stands, in source order. The literal
 * therefore builds the checked-dynamic object its own keys describe, and the
 * destination's conversion checks the values afterwards. The differential
 * case is tests/corpus/8873-computed-key-literals.ts. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-computed-keys-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const built = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
    const result = spawnSync(built.binaryPath, [], { timeout: 30_000, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "a runtime-keyed literal keeps the key where the source writes it",
  async () => {
    const out = await run(`
type Rec = Record<string, unknown>;
function page<T>(items: T[], key: "red" | "blue"): Rec {
  const server = "srv";
  return { server, [key]: items, ...(items.length > 1 ? { next: 7 } : {}) };
}
console.log(JSON.stringify(page([{ id: "a" }], "red")));
console.log(JSON.stringify(page([{ id: "a" }, { id: "b" }], "blue")));
`);
    expect(out).toBe(
      `${JSON.stringify({ server: "srv", red: [{ id: "a" }] })}\n` +
        `${JSON.stringify({ server: "srv", blue: [{ id: "a" }, { id: "b" }], next: 7 })}\n`,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "a runtime-keyed literal evaluates each key before its value, in source order",
  async () => {
    const out = await run(`
const trace: string[] = [];
function note(tag: string): string {
  trace.push("k:" + tag);
  return tag;
}
function value(tag: string): number {
  trace.push("v:" + tag);
  return tag.length;
}
const ordered: Record<string, number> = {
  [note("a")]: value("a"),
  fixed: 1,
  [note("b")]: value("b"),
};
console.log(JSON.stringify(ordered));
console.log(trace.join(","));
`);
    expect(out).toBe(`${JSON.stringify({ a: 1, fixed: 1, b: 1 })}\nk:a,v:a,k:b,v:b\n`);
  },
);

test.skipIf(process.platform === "win32")(
  "a literal keeping declared fields beside an index signature still refuses a runtime key",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-computed-keys-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(
        entry,
        `
function key(): string { return "k"; }
const c = { [key()]: 2, fixed: 1 };
console.log(JSON.stringify(c));
`,
      );
      const built = await compile(entry, { outDir: dir, outPath: join(dir, "program") });
      expect(built.ok).toBe(false);
      expect(built.ok ? [] : built.diagnostics.map((d) => d.code)).toContain("SC1090");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
