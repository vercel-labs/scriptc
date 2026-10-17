import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const finiteSource = `const date = new Date("2024-01-01T12:00:00Z");
console.log(JSON.stringify([date.toJSON(), date.toISOString()]));
`;

const invalidSource = `const invalid = new Date(NaN);
const text = new Date("not-a-date");
let thrown = "none";
try {
  invalid.toISOString();
} catch (error) {
  thrown = error instanceof RangeError ? "RangeError" : "other";
}
console.log(JSON.stringify(invalid.toJSON()));
console.log(JSON.stringify(text.toJSON()));
console.log(JSON.stringify(new Date(Infinity).toJSON()));
console.log(invalid.toJSON() === null);
console.log(thrown);
`;

async function runSource(source: string, prefix: string, expected: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, source);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
    expect(run.stdout).toBe(expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Date.toJSON matches toISOString for a finite time", async () => {
  await runSource(
    finiteSource,
    "scriptc-date-tojson-",
    '["2024-01-01T12:00:00.000Z","2024-01-01T12:00:00.000Z"]\n',
  );
}, 180_000);

test("invalid Date.toJSON returns null and toISOString throws", async () => {
  await runSource(
    invalidSource,
    "scriptc-invalid-date-json-",
    "null\nnull\nnull\ntrue\nRangeError\n",
  );
}, 180_000);
