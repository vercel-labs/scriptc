/* Diagnostics quality is a tested artifact: every tests/diagnostics/*.ts
 * program (and JS entries — CommonJS fence diagnostics live on .js files)
 * must FAIL to compile, and the full rendered output (codes, spans, code
 * frames, hints) is snapshotted.
 */
import { globSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile, renderDiagnostics } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const diagDir = join(repoRoot, "tests/diagnostics");
const files = ["ts", "js", "mjs", "cjs"]
  .flatMap((ext) => [
    ...globSync(join(diagDir, `*.${ext}`)),
    ...globSync(join(diagDir, `*/main.${ext}`)),
  ])
  .sort();

describe(`diagnostics corpus (${files.length} programs)`, () => {
  test.for(files.map((f) => [f.slice(diagDir.length + 1), f] as const))(
    "%s",
    async ([name, file]) => {
      // Flavor-split scratch: some entries reach the backend and emit
      // artifacts (.ll etc.) before failing, and the other flavor's
      // concurrent suite writes the same names — never share the dir.
      const outDir = join(tmpdir(), `scriptc-diag-${process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain"}`);
      // `// @dynamic` on the entry's FIRST line: compile with the island
      // engine embedded — for diagnostics only --dynamic builds can reach
      // (dynamic-import resolution failures, island-only fences).
      const dynamic = /^\/\/ @dynamic\s*$/.test(
        readFileSync(file, "utf8").split("\n", 1)[0] ?? "",
      );
      // Deliberately NO backend pin: every program here must fail before
      // any backend runs (that is the suite's contract), so the default
      // lane is irrelevant by construction — and riding it proves the
      // fallback machinery never turns a diagnostic into a build.
      const result = await compile(file, { outPath: join(outDir, "never"), outDir, dynamic });
      if (result.ok) {
        expect.unreachable(`${name} compiled successfully but must produce diagnostics`);
      }
      const rendered = renderDiagnostics(result.diagnostics, result.sourceTexts, { color: false })
        // keep snapshots machine-independent
        .replaceAll(diagDir + "/", "");
      await expect(rendered).toMatchFileSnapshot(`__snapshots__/${name}.txt`);
    },
  );
});
