/* Every package shim (packages/compiler/shims, registered in
 * src/frontend/package-shims.ts) compiles without a lowering refusal or a
 * runtime fence anywhere in its own files.
 *
 * Shim files suppress TypeScript errors (like library declarations under
 * skipLibCheck), but never lowering diagnostics: a refusal in code the
 * program reaches fails its build, located in the shim, and one in code it
 * does not reach would fail a later program. This test reaches all of it:
 * the analysis lowers the unreached remainder too, so every function body
 * of every shim module is checked, under both type worlds a project can
 * bring (scriptc's bundled Node declarations, and @types/node).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { analyze } from "../src/index.js";
import { packageShimEntries } from "../src/frontend/package-shims.js";
import type { ScrDiagnostic } from "../src/diagnostics/diagnostic.js";

const repoRoot = join(import.meta.dirname, "../../..");
const shimRoot = join(repoRoot, "packages/compiler/shims");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-shim-guard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function shimFindings(entry: string, world: "bundled" | "types-node"): string[] {
  const dir = join(scratch, `${world}-${entry.slice(shimRoot.length + 1).replace(/[/.]/g, "_")}`);
  mkdirSync(dir, { recursive: true });
  if (world === "types-node") {
    mkdirSync(join(dir, "node_modules/@types"), { recursive: true });
    symlinkSync(join(repoRoot, "node_modules/@types/node"), join(dir, "node_modules/@types/node"));
  }
  const main = join(dir, "main.ts");
  writeFileSync(main, `import ${JSON.stringify(entry)};\nconsole.log("loaded");\n`);
  const { coverage } = analyze(main);
  expect(coverage.preflightFailed, "the shim type-checks for the analysis").toBe(false);
  const all: ScrDiagnostic[] = [
    ...coverage.diagnostics,
    ...(coverage.runtimeFences ?? []),
    ...(coverage.unreached?.diagnostics ?? []),
    ...(coverage.unreached?.runtimeFences ?? []),
  ];
  return all
    .filter((d) => d.loc.file.startsWith(shimRoot))
    .map((d) => `${d.loc.file.slice(shimRoot.length + 1)}: ${d.code} ${d.message}`);
}

describe("package shims compile without refusals", () => {
  const entries = packageShimEntries();
  test("the registry lists its shim modules", () => {
    expect(entries.map((e) => e.slice(shimRoot.length + 1))).toEqual([
      "chalk/v5.ts",
      "fs-extra/index.ts",
      "hono-node-server/v2.ts",
      "hot-shots/v8-unix-dgram.ts",
      "hot-shots/v8.ts",
      "undici/v5.ts",
      "undici/v7.ts",
    ]);
  });
  for (const entry of entries) {
    for (const world of ["bundled", "types-node"] as const) {
      test(`${entry.slice(shimRoot.length + 1)} (${world})`, () => {
        expect(shimFindings(entry, world)).toEqual([]);
      }, 300_000);
    }
  }
});
