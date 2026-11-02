/* A type assertion erases: it decides what the checker accepts, never which
 * object a write mutates. `(p as View).x = v` writes the field of the value
 * `p` names — through a union's arm dispatch when the value is a union —
 * instead of into the width copy the asserted view would build. The
 * differential case is tests/corpus/8875-asserted-receiver-writes.ts. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-asserted-writes-"));
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
  "a member write through a record assertion mutates the asserted value",
  async () => {
    const out = await run(`
interface Pt { x: number; y: number }
function move(p: Pt): void {
  (p as { x: number }).x = 9;
  (p as unknown as { x: number }).x = 11;
}
const p: Pt = { x: 1, y: 2 };
const alias = p;
move(p);
console.log(JSON.stringify(p), JSON.stringify(alias));
`);
    expect(out).toBe(`${JSON.stringify({ x: 11, y: 2 })} ${JSON.stringify({ x: 11, y: 2 })}\n`);
  },
);

test.skipIf(process.platform === "win32")(
  "a union field write through an assertion dispatches over the stored arms",
  async () => {
    const out = await run(`
type Message = { role: string; content: string } | { role: string; summary: string };
interface Entry { type: string; message?: Message }
function migrate(entry: Entry): void {
  if (entry.message && (entry.message as { role: string }).role === "hookMessage") {
    (entry.message as { role: string }).role = "custom";
  }
}
const entries: Entry[] = [
  { type: "message", message: { role: "hookMessage", content: "x" } },
  { type: "message", message: { role: "hookMessage", summary: "y" } },
];
for (const entry of entries) migrate(entry);
console.log(JSON.stringify(entries));
`);
    expect(out).toBe(
      `${JSON.stringify([
        { type: "message", message: { role: "custom", content: "x" } },
        { type: "message", message: { role: "custom", summary: "y" } },
      ])}\n`,
    );
  },
);
