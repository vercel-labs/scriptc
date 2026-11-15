import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const compiler = new URL("../src/index.ts", import.meta.url).href;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const prelude = `
  import assert from "node:assert/strict";
  import { createRequire } from "node:module";
  const require = createRequire(${JSON.stringify(compiler)});
  const legacyParser = require.resolve("typescript5");
  assert.equal(require.cache[legacyParser], undefined);
`;

function freshProcess(source: string, args: string[] = []): void {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", prelude + source, ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
}

test("ordinary compilation does not initialize the legacy parser", () => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-startup-"),
  );
  const entry = join(directory, "main.ts");
  writeFileSync(entry, "const answer: number = 42; console.log(answer);\n");
  try {
    freshProcess(
      `
      const { compile } = await import(${JSON.stringify(compiler)});
      assert.equal(require.cache[legacyParser], undefined, "compiler import loaded TypeScript 5");
      const result = await compile(process.argv[1], {
        outputKind: "llvm", outDir: process.argv[2], outPath: process.argv[3],
      });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(require.cache[legacyParser], undefined, "ordinary compilation loaded TypeScript 5");
    `,
      [entry, directory, join(directory, "main.ll")],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  [
    "semantic source comparison",
    "library/semantic-source.ts",
    `
    assert.equal(api.semanticallyEqualSource("entry.ts", "const n = 1;", "// note\\nconst n = 1;"), true);
    assert.equal(api.semanticallyEqualSource("entry.ts", "const n = 1;", "const n = 2;"), false);
  `,
  ],
])("%s loads the legacy parser on first use", (_name, module, operation) => {
  freshProcess(`
    const api = await import(${JSON.stringify(new URL(`../src/${module}`, import.meta.url).href)});
    assert.equal(require.cache[legacyParser], undefined);
    ${operation}
    assert.ok(require.cache[legacyParser], "the deferred parser was not loaded");
  `);
});
