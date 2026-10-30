import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { fallbackModuleSpecifiers } from "../src/frontend/dts-paths.js";
import { checkPreflightTs7 } from "../src/frontend/program-node.js";
import type { Node } from "../src/frontend/ts7/ast-types.js";
import { walkPreorder } from "../src/frontend/ts7/ast.js";
import { SyntaxKind } from "../src/frontend/ts7/enums.js";
import {
  OPTIONS_WITHOUT_SUPPLIED_DIAGNOSTICS,
  setLibDiagnosticsStore,
} from "../src/frontend/ts7/lib-diagnostics.js";
import { closeSourceParser, parseSourceFile } from "../src/frontend/ts7/source-parser-node.js";

// The supplied declaration files' answers leave out the options of
// OPTIONS_WITHOUT_SUPPLIED_DIAGNOSTICS. A program supplied with every one of
// those files (the TypeScript libs, scriptc's declarations and every Node
// module's fallback declarations) shows why each cannot change what checking
// them reports, and that it does not.

const root = mkdtempSync(join(tmpdir(), "scriptc-lib-diagnostics-options-"));
afterAll(() => {
  setLibDiagnosticsStore(null);
  closeSourceParser();
  rmSync(root, { recursive: true, force: true });
});

const everyModule =
  fallbackModuleSpecifiers()
    .map((specifier) => `import ${JSON.stringify(specifier)};\n`)
    .join("") + "export {};\n";

function project(options: Record<string, unknown>, files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, "project-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: options }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return join(dir, "main.ts");
}

/** The supplied files' diagnostics of the full check of a program importing
 * every Node module, with `options` in its tsconfig, by file name. */
function suppliedDiagnostics(options: Record<string, unknown>): Record<string, unknown> {
  const entries = new Map<string, string>();
  setLibDiagnosticsStore(
    { read: (key) => entries.get(key) ?? null, write: (key, text) => void entries.set(key, text) },
    "test checker",
  );
  try {
    checkPreflightTs7(project(options, { "main.ts": everyModule }));
  } finally {
    setLibDiagnosticsStore(null);
  }
  // Each full check stores the supplied files' diagnostics (a program the
  // preflight builds twice stores two answers for the same files).
  expect(entries.size).toBeGreaterThan(0);
  const files: Record<string, unknown> = {};
  for (const text of entries.values())
    Object.assign(files, (JSON.parse(text) as { files: Record<string, unknown> }).files);
  return files;
}

const base = { strict: true };
let unset: Record<string, unknown> | undefined;
function baseline(): Record<string, unknown> {
  return (unset ??= suppliedDiagnostics(base));
}

test("the program is supplied with the libs and every Node module's fallback declarations", () => {
  const names = Object.keys(baseline());
  expect(names.some((name) => name.endsWith("/lib.es5.d.ts"))).toBe(true);
  expect(names.filter((name) => name.includes("/node-fallback/")).length).toBe(
    new Set(fallbackModuleSpecifiers().map((specifier) => specifier.replace(/^node:/, ""))).size,
  );
});

test.each(OPTIONS_WITHOUT_SUPPLIED_DIAGNOSTICS.map((option) => [option]))(
  "%s, set either way, does not change the supplied files' diagnostics",
  (option) => {
    for (const value of [true, false])
      expect(suppliedDiagnostics({ ...base, [option]: value })).toEqual(baseline());
  },
  60_000,
);

test("noUnusedLocals and noUnusedParameters report nothing in declaration files", () => {
  const options = { ...base, noUnusedLocals: true, noUnusedParameters: true };
  const codes = (extension: string, text: string): string[] =>
    checkPreflightTs7(
      project(options, {
        "main.ts": 'export type {} from "./extra.js";\n',
        [`extra.${extension}`]: text,
      }),
    ).diags.map((d) => d.message);
  // The same unused names: reported in a source file, not in a declaration file.
  expect(
    codes("ts", "type Unused = number;\nexport function f(unused: number): void {}\n"),
  ).toEqual([
    "'Unused' is declared but never used.",
    "'unused' is declared but its value is never read.",
  ]);
  expect(
    codes("d.ts", "type Unused = number;\nexport declare function f(unused: number): void;\n"),
  ).toEqual([]);
});

test("the supplied files have no statements, no index accesses and no default imports", () => {
  // The constructs the other options apply to: statements (noImplicitReturns,
  // noFallthroughCasesInSwitch, allowUnusedLabels, allowUnreachableCode),
  // element and property access expressions (noUncheckedIndexedAccess,
  // noPropertyAccessFromIndexSignature; a property access in a computed
  // property name, such as `[Symbol.iterator]`, reads a property of
  // SymbolConstructor, which has no index signature, and one in a heritage
  // clause, such as `extends NodeJS.WritableStream`, names a type) and default imports
  // (allowSyntheticDefaultImports).
  const found: string[] = [];
  for (const name of Object.keys(baseline())) {
    const file = parseSourceFile(name, readFileSync(name, "utf8"), "ts");
    expect(file.isDeclarationFile).toBe(true);
    walkPreorder(file as unknown as Node, (node) => {
      switch (node.kind) {
        case SyntaxKind.Block:
        case SyntaxKind.ExpressionStatement:
        case SyntaxKind.ReturnStatement:
        case SyntaxKind.SwitchStatement:
        case SyntaxKind.LabeledStatement:
        case SyntaxKind.ElementAccessExpression:
          found.push(`${name}: ${SyntaxKind[node.kind]}`);
          break;
        case SyntaxKind.PropertyAccessExpression:
          if (
            node.parent?.kind !== SyntaxKind.ComputedPropertyName &&
            node.parent?.kind !== SyntaxKind.ExpressionWithTypeArguments &&
            node.parent?.kind !== SyntaxKind.PropertyAccessExpression
          )
            found.push(`${name}: PropertyAccessExpression`);
          break;
        case SyntaxKind.ImportClause:
          if ((node as unknown as { name?: unknown }).name !== undefined)
            found.push(`${name}: default import`);
          break;
      }
    });
  }
  expect(found).toEqual([]);
});
