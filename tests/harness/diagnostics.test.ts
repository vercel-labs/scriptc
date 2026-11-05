/* Diagnostics quality is a tested artifact: every tests/diagnostics/*.ts
 * program (and JS entries — CommonJS fence diagnostics live on .js files)
 * must FAIL to compile, and the full rendered output (codes, spans, code
 * frames, hints) is snapshotted.
 */
import { globSync } from "node:fs";
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
      const outDir = join(
        tmpdir(),
        `scriptc-diag-${process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain"}`,
      );
      // Deliberately NO backend pin: every program here must fail before
      // any backend runs (that is the suite's contract), so the default
      // lane is irrelevant by construction — and riding it proves the
      // fallback machinery never turns a diagnostic into a build.
      // The checker-panic programs exercise tsgo's own failures (a panic, and a
      // +Infinity it cannot send), so they compile with tsgo.
      const checker = process.env["SCRIPTC_CHECKER"];
      if (name.startsWith("checker-panic-")) process.env["SCRIPTC_CHECKER"] = "tsgo";
      let result: Awaited<ReturnType<typeof compile>>;
      try {
        // --tier=static-only: these programs pin today's refusals, which
        // localized failure otherwise turns into checked dynamic slots
        // (the snapshots double as its proof that static-only keeps them).
        result = await compile(file, {
          outPath: join(outDir, "never"),
          outDir,
          tier: "static-only",
        });
      } finally {
        if (checker === undefined) delete process.env["SCRIPTC_CHECKER"];
        else process.env["SCRIPTC_CHECKER"] = checker;
      }
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
