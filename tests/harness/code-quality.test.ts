import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "scriptc-code-quality-"));
  temporary.push(path);
  for (const config of [".oxlintrc.jsonc", ".oxfmtrc.jsonc"]) {
    copyFileSync(join(root, config), join(path, config));
  }
  return path;
}

function source(work: string, name: string, text: string): void {
  const path = join(work, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function run(tool: "oxlint" | "oxfmt", work: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules", tool, "bin", tool), ...args],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

test("compiler import fences reject cross-layer and cross-parser imports", () => {
  const work = workspace();
  const cases = [
    ["packages/compiler/src/backend/probe.ts", "../frontend/program.js"],
    ["packages/compiler/src/backend/native/driver.ts", "../native-toolchain.js"],
    ["packages/compiler/src/backend/native/contracts.ts", "../../frontend/program.js"],
    ["packages/compiler/src/backend/native/tool-identity.ts", "typescript5"],
    ["packages/compiler/src/frontend/probe.ts", "../backend/llvm/emitter.js"],
    ["packages/compiler/src/frontend/lowering/probe.ts", "../../ir/validate.js"],
    ["packages/compiler/src/frontend/cjs-lexer.ts", "../ir/validate.js"],
    ["packages/compiler/src/ir/probe.ts", "typescript5"],
    ["packages/compiler/src/frontend/ts7/probe.ts", "typescript5/lib/typescript.js"],
    ["packages/compiler/src/frontend/npm.ts", "../backend/llvm/emitter.js"],
    ["packages/compiler/src/frontend/lowering/call-arguments.ts", "./lower-calls.js"],
    ["packages/compiler/src/frontend/lowering/call-signatures.ts", "../../ir/validate.js"],
    ["packages/compiler/src/frontend/lowering/generic-functions.ts", "../../backend/targets.js"],
    ["packages/compiler/src/frontend/lowering/native-ffi.ts", "typescript5"],
    ["packages/compiler/src/frontend/lowering/containers/array-callbacks.ts", "./array-methods.js"],
    [
      "packages/compiler/src/frontend/lowering/containers/callback-arguments.ts",
      "../../../ir/validate.js",
    ],
    [
      "packages/compiler/src/frontend/lowering/containers/indexed-objects.ts",
      "../../../backend/targets.js",
    ],
    ["packages/compiler/src/frontend/lowering/containers/for-of.ts", "typescript5"],
    ["packages/compiler/src/frontend/lowering/builtins/filesystem.ts", "./module-calls.js"],
    ["packages/compiler/src/frontend/lowering/builtins/arguments.ts", "../../../ir/validate.js"],
    ["packages/compiler/src/frontend/lowering/builtins/crypto.ts", "../../../backend/targets.js"],
    ["packages/compiler/src/frontend/lowering/builtins/module-bindings.ts", "typescript5"],
  ] as const;
  for (const [name, specifier] of cases)
    source(work, name, `export { value } from "${specifier}";\n`);
  const result = run("oxlint", work, ["--format=json", "packages"]);
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout) as { diagnostics: { code: string; filename: string }[] };
  expect(report.diagnostics).toHaveLength(cases.length);
  expect(report.diagnostics.every((d) => d.code === "eslint(no-restricted-imports)")).toBe(true);
  expect(report.diagnostics.map((d) => d.filename.replaceAll("\\", "/")).sort()).toEqual(
    cases.map(([name]) => name).sort(),
  );
});

test("IR imports and the explicit parser islands remain usable", () => {
  const work = workspace();
  source(work, "packages/compiler/src/backend/probe.ts", 'export { value } from "../ir/ir.js";\n');
  source(work, "packages/compiler/src/frontend/probe.ts", 'export { value } from "../ir/ir.js";\n');
  source(
    work,
    "packages/compiler/src/frontend/lowering/probe.ts",
    'export { libFnSignatures } from "../../ir/builtin-signatures.js";\nexport { STR_INTRINSIC_SIGS } from "../../ir/intrinsic-signatures.js";\n',
  );
  source(
    work,
    "packages/compiler/src/frontend/lowering/call-arguments.ts",
    'export { funcTypeFromParamShapes } from "./call-signatures.js";\n',
  );
  source(
    work,
    "packages/compiler/src/frontend/lowering/containers/array-construction.ts",
    'export { lowerArrayCallback } from "./callback-arguments.js";\n',
  );
  source(
    work,
    "packages/compiler/src/frontend/lowering/builtins/crypto.ts",
    'export { lowerBuiltinByteInput } from "./arguments.js";\n',
  );
  for (const name of [
    "frontend/npm.ts",
    "frontend/cjs-lexer.ts",
    "frontend/comptime-node.ts",
    "frontend/ts7/world-check.ts",
    "frontend/ts7/source-parser.test.ts",
    "frontend/npm-static-rewrite.ts",
    "frontend/npm-static-bundled-cjs.ts",
    "library/semantic-source.ts",
  ])
    source(work, `packages/compiler/src/${name}`, 'export { value } from "typescript5";\n');
  const result = run("oxlint", work, ["--deny-warnings", "packages"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("fixture and generated exclusions protect invalid input while normal code is checked", () => {
  const work = workspace();
  const excluded = [
    "tests/corpus/bad.ts",
    "tests/diagnostics/bad.ts",
    "tests/fixtures/bad.ts",
    "packages/compiler/test/fixtures/bad.ts",
    "packages/compiler/src/frontend/ts7/probe.generated.ts",
    "packages/runtime/vendor/bad.js",
    "packages/compiler/dist/bad.js",
    "docs/src/probe.ts",
  ];
  const invalid = "export const = deliberately invalid\n";
  for (const name of excluded) source(work, name, invalid);
  source(work, "scripts/probe.mjs", "const unused = 1;\n");
  const lint = run("oxlint", work, ["--format=json", "."]);
  expect(lint.status).toBe(1);
  const diagnostics = JSON.parse(lint.stdout).diagnostics as { code: string; filename: string }[];
  expect(
    diagnostics.map((d) => ({ ...d, filename: d.filename.replaceAll("\\", "/") })),
  ).toMatchObject([{ code: "eslint(no-unused-vars)", filename: "scripts/probe.mjs" }]);
  const format = run("oxfmt", work, ["--write", "**/*.{ts,js,mjs}"]);
  expect(format.status, format.stdout + format.stderr).toBe(0);
  for (const name of excluded) expect(readFileSync(join(work, name), "utf8")).toBe(invalid);
});

test("formatting keeps source payloads and import order and reaches a stable result", () => {
  const work = workspace();
  const name = "tests/harness/probe.ts";
  const payload = "function  bad( {\n";
  source(
    work,
    name,
    'import "./z.js";\nimport "./a.js";\nexport const code=String.raw`' + payload + "`;\n",
  );
  expect(run("oxfmt", work, ["--check", name]).status).toBe(1);
  const formatted = run("oxfmt", work, ["--write", name]);
  expect(formatted.status, formatted.stdout + formatted.stderr).toBe(0);
  const result = readFileSync(join(work, name), "utf8");
  expect(result).toContain("String.raw`" + payload + "`");
  expect(result.indexOf('import "./z.js"')).toBeLessThan(result.indexOf('import "./a.js"'));
  expect(run("oxfmt", work, ["--check", name]).status).toBe(0);
});
