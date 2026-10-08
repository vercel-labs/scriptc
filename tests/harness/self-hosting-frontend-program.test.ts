import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeInChild, compileInChild } from "./self-hosting-compiler-process.js";
import { expect, test } from "vitest";
import { ts7Executable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";
import type { FrontendProgramRequest } from "../fixtures/self-hosting/frontend-program-cases.js";

const root = join(import.meta.dirname, "../..");
const entry = join(root, "tests/fixtures/self-hosting/frontend-program.ts");
const oracle = join(root, "tests/fixtures/self-hosting/frontend-program-node.ts");
const nativeSources = join(root, "packages/compiler/native");
const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const execFileAsync = promisify(execFile);

function inputs(directory: string): FrontendProgramRequest {
  const cases: FrontendProgramRequest["cases"] = [];
  function add(
    name: string,
    files: Record<string, string>,
    options: {
      entry?: string;
      npmStatic?: string[];
      externalTypes?: [string, string][];
    } = {},
  ): void {
    for (const [path, source] of Object.entries({
      "package.json": '{"type":"module"}',
      ...files,
    })) {
      const file = join(directory, name, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    cases.push({
      name,
      entry: `${name}/${options.entry ?? "main.ts"}`,
      npmStatic: options.npmStatic ?? [],
      externalTypes: (options.externalTypes ?? []).map(([specifier, path]) => [
        specifier,
        `${name}/${path}`,
      ]),
      edits: [],
    });
  }
  add("diamond", {
    "main.ts":
      'import { left } from "./left.js"; import { right } from "./right.js"; console.log(left + right);',
    "left.ts": 'import { value } from "./leaf.js"; export const left = value + 1;',
    "right.ts": 'export { value as right } from "./leaf.js";',
    "leaf.ts": "export const value = 20;",
  });
  add("type-edges", {
    "main.ts":
      'import type { Value } from "./types.js"; import "./side.js"; const item: Value = { value: 3 }; console.log(item.value);',
    "types.ts": "export interface Value { value: number }",
    "side.ts": 'console.log("side effect");',
  });
  add("safe-cycle", {
    "main.ts": 'import { first } from "./first.js"; console.log(first(2));',
    "first.ts":
      'import { second } from "./second.js"; export function first(n: number): number { return n ? second(n - 1) : 0; }',
    "second.ts":
      'import { first } from "./first.js"; export function second(n: number): number { return first(n); }',
  });
  add("unsafe-cycle", {
    "main.ts": 'import { first } from "./first.js"; console.log(first);',
    "first.ts":
      'import * as peer from "./second.js"; export const first: number = peer.second + 1;',
    "second.ts": 'import { first } from "./first.js"; export const second: number = first + 1;',
  });
  add(
    "commonjs",
    {
      "main.cjs":
        'const left = require("./left.cjs"); const right = require("./right.cjs"); console.log(left.value + right.value);',
      "left.cjs": 'const leaf = require("./leaf.cjs"); exports.value = leaf.value + 1;',
      "right.cjs": 'module.exports = require("./leaf.cjs");',
      "leaf.cjs": "exports.value = 5;",
    },
    { entry: "main.cjs" },
  );
  add("create-require", {
    "main.ts":
      'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const answer = require("./answer.cjs"); console.log(answer.value);',
    "answer.cjs": "exports.value = 42;",
  });
  add("package-imports", {
    "package.json": JSON.stringify({
      name: "own-package",
      type: "module",
      imports: { "#value": "./value.ts" },
      exports: { "./other": "./other.ts" },
    }),
    "main.ts":
      'import { value } from "#value"; import { other } from "own-package/other"; console.log(value + other);',
    "value.ts": "export const value = 2;",
    "other.ts": "export const other = 3;",
  });
  add("config-alias", {
    "tsconfig.json":
      '{ // adopted paths, with a trailing comma\n "compilerOptions": { "strict": true, "paths": { "@value": ["./lib/value.ts"] }, }, }',
    "main.ts": 'import { value } from "@value"; console.log(value);',
    "lib/value.ts": "export const value = 7;",
  });
  add("config-extends", {
    "base.json": '{"compilerOptions":{"strict":true,"paths":{"@value":["./lib/value.ts"]}}}',
    "tsconfig.json":
      '{"extends":"./base.json","compilerOptions":{"noUncheckedIndexedAccess":true}}',
    "main.ts":
      'import { value } from "@value"; const values = [value]; console.log(values[0] ?? 0);',
    "lib/value.ts": "export const value = 8;",
  });
  add("strict-floor", {
    "tsconfig.json": '{"compilerOptions":{"strict":false}}',
    "main.ts": 'console.log("floor");',
  });
  add("config-malformed", {
    "tsconfig.json": '{"compilerOptions": ',
    "main.ts": 'console.log("malformed config");',
  });
  add("type-error", {
    "main.ts": "const value: string = 123; console.log(value);",
  });
  add("syntax-error", {
    "main.ts": "export const value = ;",
  });
  add("missing-module", {
    "main.ts": 'import "missing-native-frontend-package"; console.log("unreachable");',
  });
  add("cjs-link-error", {
    "main.ts": 'import { hidden } from "./hidden.cjs"; console.log(hidden);',
    "hidden.cjs": 'const name = "hidden"; module.exports = { [name]: 1 };',
  });
  add("unsupported-builtin", {
    "main.ts": 'import vm from "node:vm"; console.log(vm);',
  });
  add("fork-url", {
    "main.ts":
      'import { fork } from "node:child_process"; import { fileURLToPath } from "node:url"; const target = new URL("./worker.ts", import.meta.url); fork(fileURLToPath(target));',
    "worker.ts": 'import { value } from "./worker-leaf.js"; console.log(value);',
    "worker-leaf.ts": "export const value = 9;",
  });
  add("unicode", {
    "main.ts": 'import { value } from "./café 雪.js"; console.log(value);',
    "café 雪.ts": 'export const value = "☕ 雪";',
  });
  add("declaration-twin", {
    "main.ts": 'import { value } from "./value.js"; console.log(value + 1);',
    "value.js": "export const value = 4;",
    "value.d.ts": "export const value: string;",
  });
  add(
    "npm-static",
    {
      "main.ts": 'import { value } from "native-fixture"; console.log(value + 1);',
      "node_modules/native-fixture/package.json":
        '{"name":"native-fixture","type":"module","main":"index.js","types":"index.d.ts","sideEffects":false}',
      "node_modules/native-fixture/index.js": 'export { value } from "./value.js";',
      "node_modules/native-fixture/value.js": "export const value = 11;",
      "node_modules/native-fixture/index.d.ts": "export const value: number;",
    },
    { npmStatic: ["native-fixture"] },
  );
  add(
    "npm-class-alias",
    {
      "main.ts":
        'import { PublicBox } from "native-box"; const box = new PublicBox(); box.value("hello"); console.log(box.value());',
      "node_modules/native-box/package.json":
        '{"name":"native-box","type":"module","main":"index.js","types":"index.d.ts","sideEffects":false}',
      "node_modules/native-box/index.js": 'export { InternalBox as PublicBox } from "./box.js";',
      "node_modules/native-box/box.js":
        'export class InternalBox { constructor() { this.text = ""; } value(next) { if (next === undefined) return this.text; this.text = next; return this; } }',
      "node_modules/native-box/index.d.ts": 'export { PublicBox } from "./box.js";',
      "node_modules/native-box/box.d.ts":
        "export class PublicBox { value(): string; value(next: string): this; }",
    },
    { npmStatic: ["native-box"] },
  );
  add(
    "external-types",
    {
      "main.ts": 'import { answer } from "host-api"; console.log(answer());',
      "host.d.ts": 'export { answer } from "./host-detail.js";',
      "host-detail.d.ts": "export function answer(): number;",
    },
    {
      externalTypes: [
        ["host-api", "host.d.ts"],
        ["host-alias", "host.d.ts"],
      ],
    },
  );
  add(
    "external-invalid",
    {
      "main.ts": 'console.log("invalid mapping");',
      "host.d.ts": "export function answer(): number;",
    },
    { externalTypes: [["host-*", "host.d.ts"]] },
  );
  add("reload", {
    "main.ts": 'import { value } from "./value.js"; console.log(value);',
    "value.ts": 'export const value = "before";',
  });
  cases.push({
    name: "reload-error",
    entry: "reload/main.ts",
    npmStatic: [],
    externalTypes: [],
    edits: [{ path: "reload/value.ts", source: 'export const value: number = "invalid";' }],
  });
  cases.push({
    name: "reload-repaired",
    entry: "reload/main.ts",
    npmStatic: [],
    externalTypes: [],
    edits: [{ path: "reload/value.ts", source: 'export const value = "after";' }],
  });
  // Revisit an opted package without opt-in, then restore it. Resolver state
  // must follow this load rather than whichever project ran first.
  cases.push({
    name: "npm-without-opt-in",
    entry: "npm-static/main.ts",
    npmStatic: [],
    externalTypes: [],
    edits: [],
  });
  cases.push({
    name: "npm-restored",
    entry: "npm-static/main.ts",
    npmStatic: ["native-fixture"],
    externalTypes: [],
    edits: [],
  });
  return { root: directory, cases };
}

interface Report {
  name: string;
  error: string;
  diagnostics: { code: string; message: string }[];
  order: string[];
  sources: { path: string; text: string }[];
  external: { file: string; specifiers: string[] }[];
  startup: { message: string; className: string } | null;
  entryIdentity: boolean;
  released: boolean;
}

function verify(reports: Report[]): void {
  const byName = new Map(reports.map((report) => [report.name, report]));
  const get = (name: string): Report => {
    const report = byName.get(name);
    expect(report, name).toBeDefined();
    return report!;
  };
  for (const report of reports) {
    if (report.name === "external-invalid") continue;
    expect(report.error, report.name).toBe("");
    expect(report.entryIdentity, report.name).toBe(true);
    expect(report.released, report.name).toBe(true);
  }
  for (const name of [
    "diamond",
    "type-edges",
    "safe-cycle",
    "commonjs",
    "create-require",
    "package-imports",
    "config-alias",
    "config-extends",
    "fork-url",
    "unicode",
    "declaration-twin",
    "npm-static",
    "npm-class-alias",
    "reload",
    "reload-repaired",
    "npm-restored",
  ]) {
    expect(get(name).diagnostics, name).toEqual([]);
    expect(get(name).startup, name).toBeNull();
  }
  expect(get("diamond").order).toEqual([
    "diamond/leaf.ts",
    "diamond/left.ts",
    "diamond/right.ts",
    "diamond/main.ts",
  ]);
  expect(get("type-edges").order).toEqual(["type-edges/side.ts", "type-edges/main.ts"]);
  expect(get("safe-cycle").order).toEqual([
    "safe-cycle/second.ts",
    "safe-cycle/first.ts",
    "safe-cycle/main.ts",
  ]);
  expect(get("unsafe-cycle").diagnostics.some((d) => d.code === "SC1016")).toBe(true);
  expect(get("commonjs").order).toEqual([
    "commonjs/leaf.cjs",
    "commonjs/left.cjs",
    "commonjs/right.cjs",
    "commonjs/main.cjs",
  ]);
  expect(get("create-require").order).toEqual([
    "create-require/answer.cjs",
    "create-require/main.ts",
  ]);
  expect(get("package-imports").order).toEqual([
    "package-imports/value.ts",
    "package-imports/other.ts",
    "package-imports/main.ts",
  ]);
  expect(get("config-alias").order).toEqual(["config-alias/lib/value.ts", "config-alias/main.ts"]);
  expect(get("config-extends").order).toEqual([
    "config-extends/lib/value.ts",
    "config-extends/main.ts",
  ]);
  expect(get("strict-floor").diagnostics.some((d) => d.message.includes("strictNullChecks"))).toBe(
    true,
  );
  for (const name of ["config-malformed", "type-error", "syntax-error", "reload-error"]) {
    expect(get(name).diagnostics.length, name).toBeGreaterThan(0);
  }
  expect(get("unsupported-builtin").diagnostics.some((d) => d.code === "SC1010")).toBe(true);
  expect(
    get("missing-module").diagnostics.some(
      (d) => d.code === "SC1010" && d.message.includes("missing-native-frontend-package"),
    ),
  ).toBe(true);
  expect(get("cjs-link-error").startup?.className).toBe("%SyntaxError");
  expect(get("fork-url").sources.map((source) => source.path)).toContain("fork-url/worker.ts");
  expect(get("fork-url").sources.map((source) => source.path)).toContain("fork-url/worker-leaf.ts");
  expect(get("unicode").order).toEqual(["unicode/café 雪.ts", "unicode/main.ts"]);
  expect(get("declaration-twin").order).toEqual([
    "declaration-twin/value.js",
    "declaration-twin/main.ts",
  ]);
  expect(get("npm-static").order).toEqual([
    "npm-static/node_modules/native-fixture/value.js",
    "npm-static/node_modules/native-fixture/index.js",
    "npm-static/main.ts",
  ]);
  expect(
    get("npm-class-alias").sources.find((source) => source.path.endsWith("/box.js"))?.text,
  ).toContain("@overload");
  expect(get("external-types").external).toEqual([
    { file: "external-types/host.d.ts", specifiers: ["host-api", "host-alias"] },
    { file: "external-types/host-detail.d.ts", specifiers: ["host-api", "host-alias"] },
  ]);
  expect(get("external-invalid").error).toContain("invalid external type specifier");
  expect(get("reload").sources.find((source) => source.path.endsWith("/value.ts"))?.text).toContain(
    '"before"',
  );
  expect(
    get("reload-repaired").sources.find((source) => source.path.endsWith("/value.ts"))?.text,
  ).toContain('"after"');
  expect(get("npm-without-opt-in").order).not.toContain(
    "npm-static/node_modules/native-fixture/value.js",
  );
  expect(get("npm-restored").order).toEqual(get("npm-static").order);
}

for (const backend of ["llvm"] as const) {
  test(`production program loading and preflight run without Node (${backend})`, async () => {
    const directory = mkdtempSync(join(tempRoot, "scriptc-frontend-program-"));
    try {
      const object = join(directory, "process.o");
      execFileSync("clang", [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        ...(sanitize ? ["-fsanitize=address"] : []),
        "-c",
        join(nativeSources, "ts7-process.c"),
        "-o",
        object,
      ]);
      const profile = join(directory, "ffi.json");
      writeFileSync(
        profile,
        JSON.stringify({
          ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")),
          libraries: [object],
        }),
      );
      const request = join(directory, "request.json");
      const expected = join(directory, "node.json");
      writeFileSync(request, JSON.stringify(inputs(directory)));
      const node = await execFileAsync(
        process.execPath,
        ["--import", "tsx", oracle, ts7Executable(), request, expected],
        { encoding: "utf8", timeout: 90_000 },
      );
      expect(node.stdout).toBe("");
      expect(node.stderr).toBe("");
      const nodeReports = JSON.parse(readFileSync(expected, "utf8")) as Report[];
      verify(nodeReports);
      // Restore edits made by the Node run before starting the native client.
      writeFileSync(request, JSON.stringify(inputs(directory)));
      const coverage = await analyzeInChild(entry, { dynamic: false, ffiProfilePath: profile });
      expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
      expect(coverage.stats.statementsFailed, JSON.stringify(coverage.diagnostics)).toBe(0);
      expect(coverage.stats.statementsIsland).toBe(0);
      expect(coverage.stats.functionsSkipped).toBe(0);
      const built = await compileInChild(entry, {
        backend,
        dynamic: false,
        optimization: "dev",
        sanitize,
        ffiProfilePath: profile,
        outDir: directory,
        outPath: join(directory, process.platform === "win32" ? "frontend.exe" : "frontend"),
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const report = join(directory, "native.json");
      const run = await execFileAsync(built.binaryPath, [ts7Executable(), request, report], {
        encoding: "utf8",
        timeout: 90_000,
      });
      expect(run.stdout).toBe(node.stdout);
      expect(run.stderr).toBe(node.stderr);
      const nativeReports = JSON.parse(readFileSync(report, "utf8")) as Report[];
      expect(nativeReports).toEqual(nodeReports);
      verify(nativeReports);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
