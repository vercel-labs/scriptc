import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/* A `.filter` type predicate whose target is a SUPERSET of the receiver
 * element's declared fields is narrowed to what the value really carries: a
 * checked-dynamic source's own properties are read and verified field by
 * field at the narrowed element, so a predicate that keeps a value the
 * checks do not describe throws the catchable TypeError instead of handing
 * out a record with invented fields. Node yields `undefined` reads for the
 * same program (the record-layout divergence).
 *
 * The truthful predicate below narrows exactly the element that carries all
 * three fields; the lying one keeps an element without `content`. */
test("a superset `.filter` guard is verified field by field", async () => {
  const dir = mkdtempSync("/tmp/scriptc-filter-superset-");
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
interface SystemMessage { role: "system"; content: string; timestamp: number }
const raw: unknown[] = [
  { role: "system", content: "json", timestamp: 20 },
  { role: "user", content: "hi" },
  { role: "system", timestamp: 21 },
];
const isText = (v: unknown): boolean => typeof v === "string";
function honest(r: unknown): r is SystemMessage {
  const row = r as { role?: unknown; content?: unknown; timestamp?: unknown };
  return typeof row.role === "string" && row.role === "system" &&
    isText(row.content) && typeof row.timestamp === "number";
}
const kept = raw.filter(honest);
console.log("kept", kept.length, kept.map((m) => m.content + ":" + m.timestamp).join(","));
// A guard that returns true for an element the checks do not describe.
const lying = (r: unknown): r is SystemMessage => (r as { role: string }).role === "system";
try {
  for (const message of raw.filter(lying)) console.log("read", message.content);
} catch (error) {
  console.log("rejected", error instanceof TypeError);
}
`,
    );
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    expect(child.error).toBeUndefined();
    expect({
      status: child.status,
      signal: child.signal,
      stdout: child.stdout,
      stderr: child.stderr,
    }).toEqual({
      status: 0,
      signal: null,
      stderr: "",
      stdout: "kept 1 json:20\nrejected true\n",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
