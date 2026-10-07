import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

test("baseline preflight reports every missing fixture before loading the compiler", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-baseline-preflight-"));
  const put = (path: string, content: string) => {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  };
  try {
    mkdirSync(join(root, "scripts"));
    for (const name of ["test-ts7.mjs", "ts7-order-fixtures.mjs"]) {
      copyFileSync(join(import.meta.dirname, "../../scripts", name), join(root, "scripts", name));
    }
    const fixtures = [
      "tests/corpus/plain.ts",
      "tests/corpus/common.cjs",
      "tests/corpus/modules/main.mjs",
      "tests/diagnostics/refused.ts",
      "tests/fixtures/npm/cases/example/main.js",
      "tests/fixtures/strictness/strict/main.ts",
      "tests/fixtures/node-types/api.ts",
    ];
    for (const path of [...fixtures, "tests/corpus/modules/helper.ts"]) put(path, "");
    const baselinePath = "packages/compiler/test/ts7/baselines/order-parity.json";
    put(baselinePath, JSON.stringify({ entries: {} }));
    const run = () =>
      spawnSync(process.execPath, [join(root, "scripts/test-ts7.mjs"), "--baselines-only"], {
        encoding: "utf8",
      });
    const missing = run();
    expect(missing.status).toBe(1);
    for (const path of fixtures) expect(missing.stderr).toContain(path);
    expect(missing.stderr).not.toContain("helper.ts");
    expect(missing.stderr).toContain("SCRIPTC_UPDATE_BASELINES=1");

    put(
      baselinePath,
      JSON.stringify({
        entries: Object.fromEntries(
          fixtures.map((path) => [`<repo>/${path}`, { order: [], diags: [] }]),
        ),
      }),
    );
    const complete = run();
    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.stdout).toContain("Every TypeScript preflight/order fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
