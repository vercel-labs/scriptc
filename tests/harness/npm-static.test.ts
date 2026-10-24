import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";
import { skipUnownedTest } from "./shard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures");
const pilotRoot = join(fixturesRoot, "npm-static");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
/* Sanitized builds of the published Effect pilots alone take 290 to 330 s on a 16-vCPU host, most of it in
 * the sanitized native link: near or past the suite's 300 s default. */
const effectBuildTimeout = sanitize ? 900_000 : undefined;
// Measured milliseconds per test on a CI runner (scripts/ci-test-costs.mjs).
const testCosts = (
  JSON.parse(readFileSync(new URL("./npm-static-costs.json", import.meta.url), "utf8")) as {
    plain: Record<string, number>;
    san: Record<string, number>;
  }
)[sanitize ? "san" : "plain"];

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function runBinary(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: "buffer", env });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr))
      throw err;
    return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
  }
}

function comparableStderr(stderr: Buffer): Buffer {
  if (!sanitize) return stderr;
  const kept = stderr
    .toString("utf8")
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("scriptc RC audit skipped:") &&
        !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(line),
    );
  return Buffer.from(kept.join("\n"), "utf8");
}

async function buildStatic(entry: string, npmStatic: string[] | "auto"): Promise<string> {
  const hash = createHash("sha256");
  const inputs = [
    entry,
    ...globSync(join(pilotRoot, "**/node_modules/**/*.{js,mjs,cjs,json,ts}")).sort(),
    ...globSync(
      join(fixturesRoot, "commander-calc/node_modules/**/*.{js,mjs,cjs,json,d.ts}"),
    ).sort(),
    ...globSync(
      join(fixturesRoot, "npm/node_modules/cryptozoo/**/*.{js,mjs,cjs,json,d.ts}"),
    ).sort(),
    // the bundler-emitted-CJS mini packages (cases 2465-2469, 2556-2567, 2571, 2580-2590, 2595)
    ...globSync(join(fixturesRoot, "npm/node_modules/gt*/**/*.{js,cjs,json}")).sort(),
    ...globSync(join(fixturesRoot, "npm/store/gt*/**/*.{js,cjs,json}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(npmStatic === "auto" ? "auto" : npmStatic.join(","))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `npm-static-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    npmStatic,
    // Pinned: the suite pins --npm-static's FRONTEND frontier (coverage
    // numbers, fence sites); the backend lane is held fixed so those pins
    // move only when the frontend moves.
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "npm-static pilot failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

describe(`npm-static pilots${sanitize ? " (sanitized)" : ""}`, () => {
  // CI runs this file on every Linux shard; each runs its share of the tests.
  beforeEach((context) => skipUnownedTest(context, testCosts));

  test.each([
    ["effect4-shape-string-constructor.ts", "effect4-shapes"],
    ["effect4-shape-prototype-factory.ts", "effect4-shapes"],
    ["effect4-shape-semantics.ts", "effect4-shapes"],
    ["effect4-shape-match-metadata.ts", "effect4-shapes"],
    ["selectivebarrel-cli.ts", "selectivebarrel"],
  ])("%s preserves native object layout and module initialization", async (name, pkg) => {
    const entry = join(pilotRoot, name);
    const reference = await runBinary(process.execPath, [entry]);
    const binary = await buildStatic(entry, [pkg]);
    const actual = await runBinary(binary, []);
    actual.stderr = comparableStderr(actual.stderr);
    expect(actual).toEqual(reference);
    expect(actual.exitCode).toBe(0);
  });

  test("conditional exports keep distinct import and require behavior", async () => {
    const dir = mkdtempSync("/tmp/scriptc-conditional-exports-");
    try {
      const pkg = join(dir, "node_modules", "dual");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "dual",
          type: "module",
          exports: {
            ".": {
              types: "./index.d.ts",
              node: { import: "./esm.js", require: "./cjs.cjs" },
              default: "./browser.js",
            },
          },
        }),
      );
      writeFileSync(join(pkg, "index.d.ts"), "export declare const value: string;");
      writeFileSync(join(pkg, "esm.js"), 'console.log("esm init"); export const value = "import";');
      writeFileSync(join(pkg, "cjs.cjs"), 'console.log("cjs init"); exports.value = "require";');
      writeFileSync(join(pkg, "browser.js"), 'export const value = "browser";');
      for (const [name, source] of [
        ["main.mjs", 'import { value } from "dual"; console.log(value);'],
        ["main.cjs", 'const { value } = require("dual"); console.log(value);'],
        [
          "mixed.mjs",
          'import { value } from "dual"; import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const cjs = require("dual"); console.log(value, cjs.value);',
        ],
      ] as const) {
        const entry = join(dir, name);
        writeFileSync(entry, source);
        const result = await compile(entry, {
          backend: "llvm",
          npmStatic: ["dual"],
          sanitize,
          outDir: join(dir, name + "-out"),
          outPath: join(dir, name + "-program"),
        });
        if (!result.ok)
          throw new Error(
            name + ": " + result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
          );
        const [reference, native] = await Promise.all([
          runBinary(process.execPath, [entry]),
          runBinary(result.binaryPath, []),
        ]);
        expect(native.stdout).toEqual(reference.stdout);
        expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
        expect(native.exitCode).toEqual(reference.exitCode);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(["llvm"] as const)(
    "renderer values and callbacks compile from shipped JavaScript (%s)",
    async (backend) => {
      const dir = mkdtempSync(join(tmpdir(), "scriptc-renderer-values-"));
      try {
        const pkg = join(dir, "node_modules", "renderer-values");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(dir, "package.json"), '{"type":"module"}');
        writeFileSync(
          join(pkg, "package.json"),
          '{"name":"renderer-values","version":"1.0.0","type":"module","main":"index.js","types":"index.d.ts"}',
        );
        writeFileSync(join(pkg, "index.d.ts"), "export {};\n");
        const cases = [
          "native-factory-records.js",
          "native-method-values.js",
          "error-cause-writes.js",
          "renderer-null-state.js",
        ];
        for (const name of cases) cpSync(join(repoRoot, "tests/corpus", name), join(pkg, name));
        cpSync(
          join(repoRoot, "tests/corpus/module-fallback-functions"),
          join(pkg, "module-fallback-functions"),
          { recursive: true },
        );
        writeFileSync(
          join(pkg, "index.js"),
          [
            ...cases.map((name) => `import "./${name}";`),
            'import "./module-fallback-functions/main.js";',
          ].join("\n"),
        );
        const entry = join(dir, "main.js");
        writeFileSync(entry, 'import "renderer-values";');
        const { coverage } = analyze(entry, { npmStatic: "auto" });
        expect(coverage.npmStatic).toEqual([{ package: "renderer-values", status: "static" }]);
        expect(coverage.diagnostics).toHaveLength(0);
        expect(
          coverage.runtimeFences ?? [],
          JSON.stringify(coverage.runtimeFences, null, 2),
        ).toHaveLength(0);
        const result = await compile(entry, {
          backend,
          npmStatic: "auto",
          sanitize,
          outDir: join(dir, "out"),
          outPath: join(dir, "program"),
        });
        if (!result.ok)
          throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary(process.execPath, [entry]),
          runBinary(result.binaryPath, []),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
        expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.each(
    [
      "stored-native-builtins.js",
      "stored-object-helpers.js",
      "renderer-specializations.js",
      "renderer-export-dictionaries.js",
      "fresh-array-union-layout.js",
      "async-backend-factory.mjs",
      "destructure-inferred-row-defaults.js",
      "object-from-checked-entries.js",
      "regex-checked-storage.js",
      "set-checked-methods.js",
      "frozen-checked-dictionaries.mjs",
      "checked-renderer-defaults.js",
    ].flatMap((name) => (["llvm"] as const).map((backend) => ({ name, backend }))),
  )(
    "renderer startup $name compiles from shipped JavaScript ($backend)",
    async ({ name, backend }) => {
      const dir = mkdtempSync(join(tmpdir(), "scriptc-renderer-startup-"));
      try {
        const pkg = join(dir, "node_modules", "renderer-startup");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(dir, "package.json"), '{"type":"module"}');
        writeFileSync(
          join(pkg, "package.json"),
          '{"name":"renderer-startup","type":"module","main":"index.js","types":"index.d.ts"}',
        );
        writeFileSync(join(pkg, "index.d.ts"), "export {};\n");
        cpSync(join(repoRoot, "tests/corpus", name), join(pkg, "index.js"));
        const entry = join(dir, "main.js");
        writeFileSync(entry, 'import "renderer-startup";');
        const { coverage } = analyze(entry, { npmStatic: "auto" });
        expect(coverage.diagnostics).toEqual([]);
        expect(coverage.runtimeFences ?? [], JSON.stringify(coverage.runtimeFences)).toEqual([]);
        const result = await compile(entry, {
          backend,
          npmStatic: "auto",
          sanitize,
          outDir: dir,
          outPath: join(dir, "program"),
        });
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
        if (!result.ok) return;
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary(process.execPath, [entry]),
          runBinary(result.binaryPath, []),
        ]);
        expect(nativeRes.stdout.toString()).toEqual(nodeRes.stdout.toString());
        expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
        expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.each(["llvm"] as const)(
    "bundled class aliases preserve declared methods and callback fields (%s)",
    async (backend) => {
      const entry = join(pilotRoot, "bundled-methods-cli.ts");
      const { coverage } = analyze(entry, { npmStatic: "auto" });
      expect(coverage.npmStatic).toEqual([{ package: "bundled-methods", status: "static" }]);
      expect(coverage.diagnostics).toHaveLength(0);
      expect(coverage.runtimeFences ?? []).toHaveLength(0);
      const outDir = join(cacheDir, "bundled-methods", sanitize ? "san" : "plain", backend);
      const result = await compile(entry, {
        backend,
        npmStatic: "auto",
        sanitize,
        outDir,
        outPath: join(outDir, "program"),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(result.binaryPath, []),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
  );

  test("conflicting public class aliases keep the JavaScript return inference", () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-class-alias-conflict-"));
    try {
      const pkg = join(dir, "node_modules", "alias-conflict");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(pkg, "package.json"),
        '{"name":"alias-conflict","type":"module","main":"index.js","types":"index.d.ts"}',
      );
      writeFileSync(
        join(pkg, "index.d.ts"),
        "export class Text { read(): string; } export class Count { read(): number; }",
      );
      writeFileSync(
        join(pkg, "index.js"),
        'export { Value as Text } from "./chunk.js"; export { Value as Count } from "././chunk.js";',
      );
      writeFileSync(join(pkg, "chunk.js"), 'export class Value { read() { return "unchanged"; } }');
      const entry = join(dir, "main.ts");
      writeFileSync(
        entry,
        'import { Text, Count } from "alias-conflict"; const first: string = new Text().read(); const second: string = new Count().read(); console.log(first, second);',
      );
      const { coverage } = analyze(entry, { npmStatic: ["alias-conflict"] });
      expect(coverage.npmStatic).toEqual([{ package: "alias-conflict", status: "static" }]);
      expect(coverage.diagnostics).toHaveLength(0);
      expect(coverage.runtimeFences ?? []).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(["llvm"] as const)(
    "untyped package methods preserve virtual overrides (%s)",
    async (backend) => {
      const entry = join(pilotRoot, "virtual-classes-cli.ts");
      const { coverage } = analyze(entry, { npmStatic: "auto" });
      expect(coverage.npmStatic).toEqual([{ package: "virtual-classes", status: "static" }]);
      expect(coverage.diagnostics).toHaveLength(0);
      expect(coverage.runtimeFences ?? []).toHaveLength(0);
      const outDir = join(cacheDir, "virtual-classes", sanitize ? "san" : "plain", backend);
      const result = await compile(entry, {
        backend,
        npmStatic: "auto",
        sanitize,
        outDir,
        outPath: join(outDir, "program"),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(result.binaryPath, []),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
  );

  test.each(["llvm"] as const)(
    "a package's literal createRequire calls compile without an engine (%s)",
    async (backend) => {
      const entry = join(pilotRoot, "module-loader-cli.ts");
      const { coverage } = analyze(entry, { npmStatic: "auto" });
      expect(coverage.npmStatic).toEqual([{ package: "module-loader", status: "static" }]);
      expect(coverage.diagnostics).toHaveLength(0);
      expect(coverage.runtimeFences ?? []).toHaveLength(0);
      const outDir = join(cacheDir, "module-loader", sanitize ? "san" : "plain", backend);
      const result = await compile(entry, {
        backend,
        npmStatic: "auto",
        sanitize,
        outDir,
        outPath: join(outDir, "program"),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(result.binaryPath, []),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
  );

  test.each([
    [
      "computed specifier",
      'const spec = "node:path"; const path = load(spec);',
      "computed specifier",
    ],
    ["escaped require", 'const alias = load; const path = alias("node:path");', "escapes"],
    [
      "reassigned require",
      'let load = createLoader(import.meta.url); load = () => ({}); const path = load("node:path");',
      "reassigned",
    ],
    [
      "redeclared require",
      'var load = createLoader(import.meta.url); var load = () => ({}); const path = load("node:path");',
      "redeclared",
    ],
    [
      "exported mutable require",
      'export let load = createLoader(import.meta.url); const path = load("node:path");',
      "exported binding",
    ],
    [
      "exported mutable alias",
      'let load = createLoader(import.meta.url); export { load as exported }; const path = load("node:path");',
      "escapes",
    ],
    [
      "escaped mutable shorthand",
      'var load = createLoader(import.meta.url); const alias = { load }; const path = load("node:path");',
      "escapes",
    ],
    [
      "destructured reassignment",
      'var load = createLoader(import.meta.url); ({ load } = { load: () => ({}) }); const path = load("node:path");',
      "reassigned",
    ],
    [
      "early var call",
      'const path = load("node:path"); var load = createLoader(import.meta.url);',
      "before initialization",
    ],
    [
      "early let call",
      'const path = load("node:path"); let load = createLoader(import.meta.url);',
      "before initialization",
    ],
    [
      "early hoisted call",
      'const path = read(); var load = createLoader(import.meta.url); function read() { return load("node:path"); }',
      "before initialization",
    ],
    [
      "early shorthand call",
      'const callbacks = { read }; const path = callbacks.read(); var load = createLoader(import.meta.url); function read() { return load("node:path"); }',
      "before initialization",
    ],
    [
      "early declarator call",
      'var path = read(), load = createLoader(import.meta.url); function read() { return load("node:path"); }',
      "before initialization",
    ],
    [
      "optional resolution",
      'var load = createLoader(import.meta.url); load?.resolve("node:path"); const path = load("node:path");',
      "escapes",
    ],
    [
      "shadowed filename",
      'const __filename = "/tmp/other.js"; var load = createLoader(__filename); const path = load("node:path");',
      "current file",
    ],
    [
      "foreign base",
      'const load = createLoader("/tmp/other.js"); const path = load("node:path");',
      "current file",
    ],
  ])("a package's %s preserves createRequire fallback", (_name, source, reason) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-module-loader-"));
    try {
      const pkg = join(dir, "node_modules/module-loader");
      cpSync(join(pilotRoot, "node_modules/module-loader"), pkg, { recursive: true });
      const declaration = source.includes("load = createLoader")
        ? ""
        : "const load = createLoader(import.meta.url);\n";
      writeFileSync(
        join(pkg, "index.js"),
        `import { createRequire as createLoader } from "node:module";\n${declaration}${source}\nexport function describe() { return path.join("a", "b"); }\n`,
      );
      writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
      cpSync(join(pilotRoot, "module-loader-cli.ts"), join(dir, "main.ts"));
      const { coverage } = analyze(join(dir, "main.ts"), { npmStatic: "auto" });
      expect(coverage.npmStatic).toEqual([
        { package: "module-loader", status: "refused", detail: expect.stringContaining(reason!) },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a word segmenter in a package constructs, and its segment() throws SC2020", async () => {
    const entry = join(pilotRoot, "word-segments-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([{ package: "word-segments", status: "static" }]);
    expect(coverage.diagnostics).toHaveLength(0);
    const outDir = join(cacheDir, "word-segments", sanitize ? "san" : "plain");
    const result = await compile(entry, {
      backend: "llvm",
      npmStatic: "auto",
      sanitize,
      outDir,
      outPath: join(outDir, "program"),
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const nativeRes = await runBinary(result.binaryPath, []);
    expect(nativeRes.stdout.toString()).toMatch(
      /^SC2020: Intl\.Segmenter segmentation with granularity 'word' is not supported yet \[SC2020 at .*index\.js:1\]\n$/,
    );
    expect(nativeRes.exitCode).toBe(0);
  });

  test.each([
    'import { Console as Logger } from "node:console"; new Logger({ stdout: process.stdout }).dir(1);',
    'import * as output from "console"; new output.Console(process.stdout).table([1, 2]);',
    'import { trace } from "node:console"; trace("here");',
  ])("unsupported console members retain a use-site diagnostic: %s", (source) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-console-import-"));
    try {
      writeFileSync(join(dir, "main.ts"), source);
      const { coverage } = analyze(join(dir, "main.ts"));
      expect(coverage.preflightFailed).toBe(false);
      expect(
        coverage.diagnostics.some((d) => d.code === "SC2020" && /console\./i.test(d.message)),
      ).toBe(true);
      expect(coverage.diagnostics.some((d) => d.code === "SC1010")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(["llvm"] as const)(
    "bundled CommonJS function imports compile without an engine (%s)",
    async (backend) => {
      const entry = join(pilotRoot, "bundled-function-cli.ts");
      const { coverage } = analyze(entry, { npmStatic: "auto" });
      expect(coverage.npmStatic).toEqual([{ package: "bundled-function", status: "static" }]);
      expect(coverage.diagnostics).toHaveLength(0);
      expect(coverage.runtimeFences ?? []).toHaveLength(0);
      const outDir = join(cacheDir, "bundled-function", sanitize ? "san" : "plain", backend);
      const result = await compile(entry, {
        backend,
        npmStatic: "auto",
        sanitize,
        outDir,
        outPath: join(outDir, "program"),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(result.binaryPath, []),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
  );

  test.each(["release", "dev"] as const)(
    "inferred class methods dispatch through inherited checked receivers (%s)",
    async (optimization) => {
      const entry = join(pilotRoot, "class-helper-cli.ts");
      const outDir = join(cacheDir, `class-helper-${optimization}-${sanitize ? "san" : "plain"}`);
      const result = await compile(entry, {
        backend: "llvm",
        npmStatic: ["class-helper"],
        sanitize,
        optimization,
        outDir,
        outPath: join(outDir, "program"),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [reference, native] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(result.binaryPath, []),
      ]);
      expect(reference.stdout.toString()).toBe("base:inherited\nbase:own\ntrue\nsecond:detached\n");
      expect(native.stdout).toEqual(reference.stdout);
      expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
      expect(native.exitCode).toBe(reference.exitCode);
    },
  );

  test.each(["release", "dev"] as const)(
    "static methods a factory class defines build subclasses of their receiver (%s)",
    async (optimization) => {
      const entry = join(pilotRoot, "class-factory-cli.ts");
      const outDir = join(cacheDir, `class-factory-${optimization}-${sanitize ? "san" : "plain"}`);
      const result = await compile(entry, {
        backend: "llvm",
        npmStatic: ["class-factory"],
        sanitize,
        optimization,
        outDir,
        outPath: join(outDir, "program"),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [reference, native] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(result.binaryPath, []),
      ]);
      expect(reference.exitCode).toBe(0);
      expect(native.stdout).toEqual(reference.stdout);
      expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
      expect(native.exitCode).toBe(reference.exitCode);
    },
  );

  test.each(["release", "dev"] as const)(
    "a factory that destructures its base class from an options object builds static subclasses (%s)",
    async (optimization) => {
      const entry = join(pilotRoot, "class-options-cli.ts");
      const outDir = join(cacheDir, `class-options-${optimization}-${sanitize ? "san" : "plain"}`);
      const result = await compile(entry, {
        backend: "llvm",
        npmStatic: ["class-options"],
        sanitize,
        optimization,
        outDir,
        outPath: join(outDir, "program"),
        emitIr: true,
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [reference, native] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(result.binaryPath, []),
      ]);
      expect(reference.exitCode).toBe(0);
      expect(native.stdout).toEqual(reference.stdout);
      expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
      expect(native.exitCode).toBe(reference.exitCode);
      // One makeClass instance per distinct base (Root, Animal, Dog) plus
      // the generic one a class's own `extend` passing itself back reuses.
      const ir = JSON.parse(readFileSync(result.irPath!, "utf8")) as {
        functions: { name: string }[];
      };
      const instances = ir.functions.filter((fn) => /^%[\w.]*makeClass%\d+$/.test(fn.name));
      expect(instances.length).toBeLessThanOrEqual(4);
    },
  );

  test.for([
    ["escape-string-regexp", "escape-cli.ts"],
    ["slash", "slash-cli.ts"],
    ["ms", "ms-cli.ts"],
    ["ms", "ms-invalid-cli.ts"],
    // dualist pins the "node" exports condition: Node runs ./node.js
    // (yaml's browser-vs-node shape) and the opted-in resolution must
    // land on the SAME artifact, never the browser build.
    ["dualist", "dualist-cli.ts"],
  ] as const)(
    "%s compiles statically and byte-matches Node",
    async ([pkg, file]) => {
      const entry = join(pilotRoot, file);
      const binary = await buildStatic(entry, [pkg]);
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry]),
        runBinary(binary, []),
      ]);
      expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
    120_000,
  );

  test.for(["explicit", "auto"] as const)(
    "hoisted CommonJS function exports stay static (%s)",
    async (mode) => {
      const entry = join(pilotRoot, "early-export-cli.ts");
      const npmStatic = mode === "auto" ? "auto" : ["early-export"];
      const { coverage } = analyze(entry, { npmStatic });
      expect(coverage.npmStatic).toEqual([{ package: "early-export", status: "static" }]);
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toHaveLength(0);
      expect(coverage.runtimeFences ?? []).toHaveLength(0);
      expect(coverage.stats.statementsFailed).toBe(0);

      const binary = await buildStatic(entry, npmStatic);
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry]),
        runBinary(binary, []),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
    120_000,
  );

  test("picocolors compiles fully statically and byte-matches both color branches", async () => {
    const entry = join(pilotRoot, "colors-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["picocolors"] });
    expect(coverage.npmStatic).toEqual([{ package: "picocolors", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);
    expect(coverage.stats.statementsFailed).toBe(0);

    const binary = await buildStatic(entry, ["picocolors"]);
    const plainEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete plainEnv["FORCE_COLOR"];
    const colorEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1" };
    delete colorEnv["NO_COLOR"];

    for (const env of [plainEnv, colorEnv]) {
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry], env),
        runBinary(binary, [], env),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    }
  }, 180_000);

  test("createRequire loads an opted-in package through its require entry", async () => {
    const entry = join(pilotRoot, "create-require-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["picocolors"] });
    expect(coverage.npmStatic).toEqual([{ package: "picocolors", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);
    expect(coverage.stats.statementsFailed).toBe(0);

    const binary = await buildStatic(entry, ["picocolors"]);
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env["FORCE_COLOR"];
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry], env),
      runBinary(binary, [], env),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test("picocolors inherited valueOf matches Node", async () => {
    const entry = join(pilotRoot, "colors-prototype-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["picocolors"] });
    expect(coverage.npmStatic).toEqual([{ package: "picocolors", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);

    const binary = await buildStatic(entry, ["picocolors"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test("picocolors inherited hasOwnProperty matches Node", async () => {
    const entry = join(pilotRoot, "colors-hasown-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["picocolors"] });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);

    const binary = await buildStatic(entry, ["picocolors"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  // Tier 1, auto mode: the eligibility heuristics pick escape-string-regexp
  // (own .d.ts, unminified, no transform markers) without naming it.
  test("--npm-static=auto opts the eligible pilot in", () => {
    const { coverage } = analyze(join(pilotRoot, "escape-cli.ts"), { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([{ package: "escape-string-regexp", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.stats.statementsFailed).toBe(0);
  }, 120_000);

  // Auto's runtime-JS probe anchors at the IMPORTING file, not the entry:
  // shouty is installed only in inner/'s node_modules (the pnpm-monorepo
  // shape — vercel's CLI deps live in packages/cli/node_modules while the
  // analysis driver sits outside every package realm), so an entry-anchored
  // probe answers "no runtime JS entry resolves" for an ordinary install.
  test("--npm-static=auto probes runtime JS from the importing file's realm", async () => {
    const entry = join(pilotRoot, "nested/main.ts");
    const { coverage } = analyze(entry, { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([{ package: "shouty", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.stats.statementsFailed).toBe(0);
    const binary = await buildStatic(entry, "auto");
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);

  // Auto refuses ms: it ships no own .d.ts (the declared-claim criterion),
  // so the import keeps today's story — and the explicit opt-in below is
  // the user's override.
  test("--npm-static=auto refuses a package with no own .d.ts", () => {
    const { coverage } = analyze(join(pilotRoot, "ms-cli.ts"), { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([
      {
        package: "ms",
        status: "refused",
        detail: "it ships no own .d.ts declaration surface",
        hint: "to compile it anyway, name it with --npm-static=ms (or --npm-static=ms... to include its dependencies)",
      },
    ]);
  }, 120_000);

  // Types-first resolution answers @types/twinned, but the refusal names the
  // package that has the code and the flag that compiles it.
  // The default selection compiles a package typed by a DefinitelyTyped
  // twin that describes its installed release, and the untyped
  // dependencies of compiled packages.
  test("an @types-typed package and its untyped dependency compile by default", async () => {
    const entry = join(pilotRoot, "twinned-cli.ts");
    const { coverage } = analyze(entry);
    expect(coverage.npmStatic).toEqual([
      { package: "twinned", status: "static" },
      { package: "ms", status: "static" },
    ]);
    expect(coverage.preflightFailed).toBe(false);
    const binary = await buildStatic(entry, "auto");
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  // The twin only checks the program; the JavaScript compiles with its
  // inferred surface, so a twin naming an export the JavaScript lacks
  // (Node's link error) fails the build at the import's use instead of
  // compiling against the declaration.
  test("an @types twin that disagrees with the shipped JavaScript does not build", () => {
    const { coverage } = analyze(join(pilotRoot, "twinstale-cli.ts"));
    expect(coverage.npmStatic).toEqual([{ package: "twinstale", status: "static" }]);
    expect(coverage.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("'stale'") as string }),
    );
  }, 120_000);

  test("a named package's untyped dependency compiles with it", () => {
    const { coverage } = analyze(join(pilotRoot, "twinned-cli.ts"), { npmStatic: ["twinned"] });
    expect(coverage.npmStatic).toContainEqual({ package: "ms", status: "static" });
  }, 120_000);

  test("--npm-static=pkg... compiles the package's dependency closure", async () => {
    const entry = join(pilotRoot, "twinned-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["twinned..."] });
    expect(coverage.npmStatic).toEqual([
      { package: "twinned", status: "static" },
      { package: "ms", status: "static" },
    ]);
    expect(coverage.preflightFailed).toBe(false);
    const binary = await buildStatic(entry, ["twinned..."]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test("type-only imports select no package", async () => {
    const entry = join(pilotRoot, "type-only-cli.ts");
    const { coverage } = analyze(entry);
    expect(coverage.npmStatic ?? []).toEqual([]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    const binary = await buildStatic(entry, []);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test("ms supports invalid duration strings without runtime fences", () => {
    const { coverage } = analyze(join(pilotRoot, "ms-invalid-cli.ts"), { npmStatic: ["ms"] });
    expect(coverage.npmStatic).toEqual([{ package: "ms", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  }, 120_000);

  // Commander is the declaration-backed npm-static vertical slice: its
  // package declarations preserve overloads and selected field contracts,
  // while broad JSDoc implementation helpers specialize from reached call
  // sites. The driven add command is differential; the package-wide floor
  // separately pins dormant paths that still carry explicit runtime fences.
  test("commander compiles statically and byte-matches Node", async () => {
    const entry = join(fixturesRoot, "commander-calc/calc-npm-static.ts");
    const { coverage } = analyze(entry, {
      npmStatic: ["commander"],
    });
    expect(coverage.npmStatic).toEqual([{ package: "commander", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0); // builds — fences are runtime
    const total = coverage.stats.statementsTotal + (coverage.unreached?.stats.statementsTotal ?? 0);
    const failed =
      coverage.stats.statementsFailed + (coverage.unreached?.stats.statementsFailed ?? 0);
    expect(total).toBeGreaterThan(1200); // the whole package joined the program
    expect((total - failed) / total).toBeGreaterThanOrEqual(0.95);
    expect(total - failed).toBeGreaterThanOrEqual(1200);
    // Two promise-chain locals intentionally remain checked-dynamic: their
    // first assignment reads the preceding undefined value, so promoting
    // them to a scalar promise slot would be unsound.
    expect(coverage.runtimeFences?.length ?? 0).toBeLessThanOrEqual(56);
    const fenceMessages = (coverage.runtimeFences ?? []).map((f) => f.message).join("\n");
    expect(fenceMessages).not.toMatch(
      /storing 'm5\.Command' values|holding 'm5\.Command|ChildProcess' is expected/,
    );
    expect(fenceMessages).not.toMatch(
      /Command\[\] \| Option\[\]\.(?:map|forEach)|target\.parseArg/,
    );

    const binary = await buildStatic(entry, ["commander"]);
    const argv = ["add", "20", "22"];
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry, ...argv]),
      runBinary(binary, argv),
    ]);
    expect(nodeRes.stdout.toString("utf8")).toBe("42\n");
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test("commander computed option listener registration compiles statically and byte-matches Node", async () => {
    const entry = join(fixturesRoot, "commander-calc/version-npm-static.ts");
    const { coverage } = analyze(entry, { npmStatic: ["commander"] });
    expect(coverage.npmStatic).toEqual([{ package: "commander", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);

    const binary = await buildStatic(entry, ["commander"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test("the crypto utility package compiles fully statically and byte-matches Node", async () => {
    const entry = join(fixturesRoot, "npm/cases/crypto-shims/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["cryptozoo"] });
    expect(coverage.npmStatic).toEqual([{ package: "cryptozoo", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);
    expect(coverage.stats.statementsFailed).toBe(0);

    const binary = await buildStatic(entry, ["cryptozoo"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  // Real CommonJS packages whose require() placement (a binding required
  // below code that only reaches it after the require ran) or JSON
  // require preflight refused before.
  test("export-first CommonJS packages and JSON requires compile statically", () => {
    const { coverage } = analyze(join(pilotRoot, "cjs-interop-cli.ts"), {
      npmStatic: ["fs.realpath", "on-finished", "ee-first", "statuses"],
    });
    expect(coverage.preflightFailed).toBe(false);
    expect(
      [...(coverage.npmStatic ?? [])].sort((a, b) => a.package.localeCompare(b.package)),
    ).toEqual([
      { package: "ee-first", status: "static" },
      { package: "fs.realpath", status: "static" },
      { package: "on-finished", status: "static" },
      { package: "statuses", status: "static" },
    ]);
  }, 120_000);

  // A package preflight failure stays visible as a package-specific refusal.
  test("a preflight-refused package reports its native refusal", () => {
    const { coverage } = analyze(join(fixturesRoot, "npm/divergent/lazybuiltin.ts"), {
      npmStatic: ["esbundled"],
    });
    const statuses = coverage.npmStatic ?? [];
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.package).toBe("esbundled");
    expect(statuses[0]?.status).toBe("refused");
    expect(coverage.preflightFailed).toBe(false);
  }, 120_000);

  // A package-maintained .d.ts may state overloads its readable JS body
  // cannot infer. chainy is commander's getter/setter shape in miniature:
  // name()/tag() return strings with no argument and `this` with one. The
  // safe declaration groups project into JSDoc on the matching runtime
  // class, so the body compiles from JS while calls keep the authored surface.
  test("auto preserves safe declaration overloads while compiling the JavaScript body", async () => {
    const entry = join(pilotRoot, "chainy-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([{ package: "chainy", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.stats.statementsFailed).toBe(0);
    const binary = await buildStatic(entry, "auto");
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  // Ineligible packages remain declaration-only during analysis and receive
  // a refusal, while eligible dependencies can still be analyzed natively.
  test("an ineligible untyped package is refused alongside a compiled dependency", () => {
    const { coverage } = analyze(join(pilotRoot, "typegap-mix.ts"), {
      npmStatic: ["escape-string-regexp"],
    });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.npmStatic).toEqual([
      {
        package: "typegapped",
        status: "refused",
        detail: "it ships no own .d.ts declaration surface",
        hint: "to compile it anyway, name it with --npm-static=typegapped (or --npm-static=typegapped... to include its dependencies)",
      },
      { package: "escape-string-regexp", status: "static" },
    ]);
    // Report package eligibility rather than errors in unselected source.
    expect(
      coverage.diagnostics.some((d) => d.code === "SC2013" && d.message.includes("typegapped")),
    ).toBe(true);
  }, 120_000);

  test("opted-in npm packages retain imports deeper than four JavaScript modules", async () => {
    const entry = join(pilotRoot, "deepchain-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["deepchain"] });
    expect(coverage.npmStatic).toEqual([{ package: "deepchain", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    const binary = await buildStatic(entry, ["deepchain"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  // The two resolvers must answer one file for every opted-in edge. Each
  // shape below once left the runtime file outside tsgo's program (SC2013
  // "did not join the type-checked program"): uuid's node condition with
  // declarations in another tree, tldts's package-root TypeScript source
  // beside `main`, express's same-version copies of one package (tsgo's
  // package-id redirect), and get-intrinsic's dependency chain deeper than
  // maxNodeModuleJsDepth.
  test.each([
    ["split-node-types-cli.ts", ["split-node-types"]],
    ["ts-root-source-cli.ts", ["ts-root-source"]],
    ["dup-install-cli.ts", ["dup-left", "dup-right", "dup-leaf"]],
    ["deep-packages-cli.ts", Array.from({ length: 11 }, (_, i) => `hop-${i + 1}`)],
  ])(
    "%s joins the type-checked program and matches Node",
    async (name, pkgs) => {
      const entry = join(pilotRoot, name);
      const { coverage } = analyze(entry, { npmStatic: pkgs });
      expect(coverage.npmStatic.map((p) => [p.package, p.status]).sort()).toEqual(
        pkgs.map((p) => [p, "static"]).sort(),
      );
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toHaveLength(0);
      const binary = await buildStatic(entry, pkgs);
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry]),
        runBinary(binary, []),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
    180_000,
  );

  test("recursive inferred JavaScript results retain their promised ABI", async () => {
    const entry = join(pilotRoot, "recursive-result-cli.ts");
    const binary = await buildStatic(entry, ["recursive-result"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test("the published Effect Function subpath initializes and runs statically", async () => {
    const entry = join(pilotRoot, "effect-function-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["effect"] });
    expect(coverage.npmStatic).toEqual([{ package: "effect", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    const binary = await buildStatic(entry, ["effect"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test(
    "the published Effect generator logs and completes statically",
    async () => {
      const entry = join(pilotRoot, "effect-gen-cli.ts");
      const binary = await buildStatic(entry, ["effect"]);
      const [reference, native] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(binary, []),
      ]);
      const log =
        /^timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z level=INFO fiber=#0 message="Hello, world!"\n$/;
      expect(reference.stdout.toString()).toMatch(log);
      expect(native.stdout.toString()).toMatch(log);
      expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
      expect(native.exitCode).toBe(reference.exitCode);
      expect(native.exitCode).toBe(0);
    },
    effectBuildTimeout,
  );

  test(
    "the published Effect generator has deterministic native results",
    async () => {
      const entry = join(pilotRoot, "effect-gen-result-cli.ts");
      const binary = await buildStatic(entry, ["effect"]);
      const [reference, native] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(binary, []),
      ]);
      expect(reference.stdout.toString()).toBe("Hello, world!\n42\n");
      expect(native.stdout).toEqual(reference.stdout);
      expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
      expect(native.exitCode).toBe(reference.exitCode);
    },
    effectBuildTimeout,
  );

  test("the published js-yaml loads, dumps and reports errors statically and matches Node", async () => {
    const entry = join(pilotRoot, "js-yaml-cli.mjs");
    const { coverage } = analyze(entry, { npmStatic: ["js-yaml"] });
    expect(coverage.npmStatic).toEqual([{ package: "js-yaml", status: "static" }]);
    expect(coverage.diagnostics).toHaveLength(0);
    const binary = await buildStatic(entry, ["js-yaml"]);
    const [reference, native] = await Promise.all([
      runBinary(process.execPath, [entry]),
      runBinary(binary, []),
    ]);
    expect(native.stdout.toString()).toBe(reference.stdout.toString());
    expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
    expect(native.exitCode).toBe(reference.exitCode);
    expect(native.exitCode).toBe(0);
  }, 300_000);

  test("the published smol-toml parses and stringifies statically and matches Node", async () => {
    const entry = join(pilotRoot, "smol-toml-cli.mjs");
    const { coverage } = analyze(entry, { npmStatic: ["smol-toml"] });
    expect(coverage.npmStatic).toEqual([{ package: "smol-toml", status: "static" }]);
    expect(coverage.diagnostics).toHaveLength(0);
    const binary = await buildStatic(entry, ["smol-toml"]);
    const [reference, native] = await Promise.all([
      runBinary(process.execPath, [entry]),
      runBinary(binary, []),
    ]);
    expect(native.stdout.toString()).toBe(reference.stdout.toString());
    expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
    expect(native.exitCode).toBe(reference.exitCode);
    expect(native.exitCode).toBe(0);
  }, 300_000);

  test("inferred variadic factories preserve checked callable results", async () => {
    const entry = join(pilotRoot, "variadic-factory-cli.ts");
    const binary = await buildStatic(entry, ["variadic-factory"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test.each(["release", "dev"] as const)(
    "inferred helpers preserve native array storage (%s)",
    async (optimization) => {
      const entry = join(pilotRoot, "array-helper-cli.ts");
      const outDir = join(cacheDir, `array-helper-${optimization}-${sanitize ? "san" : "plain"}`);
      const result = await compile(entry, {
        backend: "llvm",
        npmStatic: ["array-helper"],
        sanitize,
        optimization,
        outDir,
        outPath: join(outDir, "program"),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [reference, native] = await Promise.all([
        runBinary(process.execPath, [entry]),
        runBinary(result.binaryPath, []),
      ]);
      expect(reference.stdout.toString()).toBe("[0,2,4,6]\n[]\n");
      expect(native.stdout).toEqual(reference.stdout);
      expect(comparableStderr(native.stderr)).toEqual(reference.stderr);
      expect(native.exitCode).toBe(reference.exitCode);
    },
  );

  test.for([
    ["purebarrel", "purebarrel-cli.ts"],
    ["statefulbarrel", "statefulbarrel-cli.ts"],
    ["statefulbarrel", "statefulbarrel-empty-cli.ts"],
  ] as const)(
    "%s namespace re-exports byte-match Node",
    async ([pkg, file]) => {
      const entry = join(pilotRoot, file);
      const { coverage } = analyze(entry, { npmStatic: [pkg] });
      expect(coverage.npmStatic).toEqual([{ package: pkg, status: "static" }]);
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toHaveLength(0);
      const binary = await buildStatic(entry, [pkg]);
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry]),
        runBinary(binary, []),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
    180_000,
  );

  test("a cyclic package tree retains an impure dependency through an unused namespace re-export", async () => {
    const entry = join(pilotRoot, "cycle-cli.ts");
    const packages = ["cycle-a", "cycle-b", "cycle-impure"];
    const { coverage } = analyze(entry, { npmStatic: packages });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    const binary = await buildStatic(entry, packages);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  // WORKSPACE-LINKED packages: node_modules/wslinked is a symlink whose
  // realpath lies outside every node_modules (the monorepo-internal
  // install every workspace tool produces). The opt-in compiles its
  // shipped dist statically as program modules — the fs shadow hides the
  // declaration twins along the realpath'd internal edges, resolution
  // lands on the runtime JS, and the binary byte-matches Node.
  test("a workspace-linked package compiles statically under --npm-static", async () => {
    const entry = join(fixturesRoot, "npm/cases/workspace-linked/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["wslinked"] });
    expect(coverage.npmStatic).toEqual([{ package: "wslinked", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.stats.statementsFailed).toBe(0);

    // Flavor-split like every fixed-name build dir: the other flavor's
    // concurrent suite runs this same test (with a different sanitize
    // flag, even) and must not share the dir.
    const outDir = join(cacheDir, `npm-static-workspace-${sanitize ? "san" : "plain"}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, {
      outPath: join(outDir, "program"),
      outDir,
      sanitize,
      npmStatic: ["wslinked"],
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(result.binaryPath, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);

  // The workspace link compiles automatically without explicit selection.
  test("a workspace-linked package classifies as an npm import without flags", () => {
    const { coverage } = analyze(join(fixturesRoot, "npm/cases/workspace-linked/main.ts"));
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.npmStatic).toContainEqual({ package: "wslinked", status: "static" });
  }, 120_000);

  /* ── bundler-emitted CJS: the getter-table export shapes (cases
   * 2465-2469) ─ the canonical-table rewrite types each shape's named
   * exports by their resolved values, the compiled binaries byte-match
   * Node, and the consumer-anchored offender attribution refuses what
   * inference cannot carry. */

  // 2465: the esbuild __export getter table (renamed local, member-access
  // getter body, mutable-var snapshot) + a lexer-visible-but-valueless
  // chunk-wrapped name binding undefined, exactly Node.
  // 2466: the esbuild __reExport star (+ annotation spread) over a plain
  // CJS sibling.
  // 2467: the tsc __exportStar barrel (defineProperty __esModule stamp,
  // void-init preamble, own member export beside the stars).
  // 2468: the Object.defineProperty(exports, 'n', { get }) re-export
  // family plus a scalar member export.
  test.for([
    ["2465-getter-table", "gtable"],
    ["2466-getter-star", "gtstar"],
    ["2467-star-barrel", "gtbarrel"],
    ["2468-defineprop-exports", "gtdefine"],
  ] as const)(
    "bundler-emitted CJS %s compiles statically and byte-matches Node",
    async ([caseDir, pkg]) => {
      const entry = join(fixturesRoot, "npm/cases", caseDir, "main.ts");
      const { coverage } = analyze(entry, { npmStatic: [pkg] });
      expect(coverage.npmStatic).toEqual([{ package: pkg, status: "static" }]);
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toHaveLength(0); // builds — fences are runtime
      const binary = await buildStatic(entry, [pkg]);
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry]),
        runBinary(binary, []),
      ]);
      expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
    180_000,
  );

  /* ── 2556-2557: esbuild's __toESM interop around EXTERNAL (unbundled)
   * dependencies ─ the wrapper erases (the recognized helper pads down to
   * the bare require it wraps), member accesses model on the required
   * package's canonical table, `.default` binds the module for plain-CJS
   * targets (and unconditionally under the `, 1` node-mode variant) and
   * stays a member read for __esModule-stamped ones; interop the
   * recognizer cannot finish degrades the package with a note naming the
   * construct. */

  // 2556: gtwrap wraps a plain-CJS external (gtcore — default IS the
  // module) and an esbuild-bundle external (gtable — stamped, named
  // getter passthrough); driven paths byte-match Node, and the undriven
  // inline `__toESM(require(…)).tag` form costs nothing.
  test("bundler-emitted CJS 2556-toesm-external compiles statically and byte-matches Node", async () => {
    const entry = join(fixturesRoot, "npm/cases/2556-toesm-external/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtwrap", "gtcore", "gtable"] });
    expect(coverage.npmStatic).toEqual([
      { package: "gtwrap", status: "static" },
      { package: "gtcore", status: "static" },
      { package: "gtable", status: "static" },
    ]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    const binary = await buildStatic(entry, ["gtwrap", "gtcore", "gtable"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  // The interop's require edges join recursive automatic package selection.
  test("__toESM dependencies compile recursively without explicit selection", () => {
    const entry = join(fixturesRoot, "npm/cases/2556-toesm-external/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtwrap"] });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.npmStatic).toEqual([
      { package: "gtwrap", status: "static" },
      { package: "gtcore", status: "static" },
      { package: "gtable", status: "static" },
    ]);
    expect(coverage.diagnostics).toEqual([]);
  }, 120_000);

  // 2557: a __toESM whose TEXT deviates beyond the structural recognizer
  // (a hand-rolled block-body interop). Refuse the package and name the
  // construct rather than claiming it compiled statically.
  test("a deviant __toESM helper refuses the package with a construct-naming note", () => {
    const entry = join(fixturesRoot, "npm/cases/2557-toesm-drift/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtdrift", "gtcore"] });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.npmStatic).toEqual([
      {
        package: "gtdrift",
        status: "refused",
        detail: expect.stringContaining("__toESM") as string,
      },
      { package: "gtcore", status: "static" },
    ]);
  }, 120_000);

  // Auto must not newly admit what the recognition cannot finish: the
  // eligibility heuristics pick gtdrift (own .d.ts, unminified, no
  // runtime markers), the attempt runs, and the SAME construct-naming
  // refusal answers — the preflight refusal and the lowering agree.
  test("--npm-static=auto degrades a deviant __toESM package with the same note", () => {
    const entry = join(fixturesRoot, "npm/cases/2557-toesm-drift/main.ts");
    const { coverage } = analyze(entry, { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([
      {
        package: "gtdrift",
        status: "refused",
        detail: expect.stringContaining("__toESM") as string,
      },
    ]);
  }, 120_000);

  /* ── 2558-2561: esbuild's bundled CommonJS chunks and per-file CommonJS
   * cycles ─ every __commonJS chunk compiles as its own CommonJS module
   * (evaluated once, at its first require); a require cycle between
   * esbuild outputs whose live getter tables install before their first
   * require initializes exactly like Node, and a cycle that reads a
   * binding in its temporal dead zone stays refused. */
  async function expectNodeParity(entry: string, packages: string[]): Promise<void> {
    const { coverage } = analyze(entry, { npmStatic: packages });
    expect(coverage.npmStatic).toEqual(packages.map((pkg) => ({ package: pkg, status: "static" })));
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    const binary = await buildStatic(entry, packages);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    // Node's stderr carries its type-stripping warning; the programs write
    // only to stdout.
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(comparableStderr(nativeRes.stderr).toString("utf8")).toBe("");
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    expect(nativeRes.exitCode).toBe(0);
  }

  // 2558: esbuild 0.25 (plain and whitespace/syntax minified) and 0.17
  // CommonJS bundles of one source, plus a .cjs bundle in a type-module
  // package with the node-mode interop.
  test("bundled CommonJS chunks 2558-bundled-chunks compile statically and byte-match Node", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/2558-bundled-chunks/main.ts"), [
      "gtchunk",
      "gtchunkws",
      "gtchunk17",
      "gtcjsdist",
      "gtcore",
    ]);
  }, 180_000);

  // 2595: a minified chunk whose top-level var statement mixes require
  // bindings with a class extending the events binding; the bindings own no
  // storage, so the constructor reaches the modules through them.
  test("bundled chunk 2595-bundled-chunk-emitter builds its emitters through require bindings", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/2595-bundled-chunk-emitter/main.ts"), [
      "gtchunkee",
    ]);
  }, 180_000);

  // 7546: a one-line minified ES module: a var statement whose later
  // declarators spread earlier ones, regexes read through an untyped rules
  // table, and a function instantiated with typed and untyped arguments.
  test("the minified module 7546-minified-esm-rules compiles statically and matches Node", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/7546-minified-esm-rules/main.ts"), [
      "gtminimark",
    ]);
  }, 180_000);

  // 7547: an identifier-minified esbuild CommonJS bundle: the __commonJS
  // helper and chunk parameters renamed, { value: !0 } stamps, and
  // (0, ns.member)(...) calls of builtin module functions.
  test("the identifier-minified bundle 7547-minified-cjs-chunks compiles statically and matches Node", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/7547-minified-cjs-chunks/main.ts"), [
      "gtminicache",
    ]);
  }, 180_000);

  // A whitespace/syntax-minified bundle whose helpers keep their names is
  // judged by the recognizers, not refused up front as minified.
  test("--npm-static=auto opts a minified bundle with named helpers in", () => {
    const entry = join(fixturesRoot, "npm/cases/2558-bundled-chunks/main.ts");
    const { coverage } = analyze(entry, { npmStatic: "auto" });
    expect(coverage.npmStatic).toContainEqual({ package: "gtchunkws", status: "static" });
  }, 120_000);

  test.each(["2559-cjs-cycle", "2560-cjs-cycle-partner-first"])(
    "the esbuild CommonJS cycle %s compiles statically and byte-matches Node",
    async (name) => {
      await expectNodeParity(join(fixturesRoot, `npm/cases/${name}/main.ts`), ["gtcycle"]);
    },
    180_000,
  );

  // 2561: Node throws a ReferenceError there; the cycle keeps SC1016.
  test("a CommonJS cycle that reads a binding before its declaration stays refused", () => {
    const entry = join(fixturesRoot, "npm/cases/2561-cjs-cycle-early-read/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtcyclebad"] });
    expect(coverage.npmStatic).toEqual([
      {
        package: "gtcyclebad",
        status: "refused",
        detail: expect.stringMatching(
          /circular imports .*can use its binding 'import_index' of a module of the cycle/,
        ) as string,
      },
    ]);
  }, 120_000);

  // 2563: lazily initialized ES modules (__esm) in esbuild 0.25 plain and
  // whitespace/syntax-minified bundles.
  test("bundled ES module initializers 2563-bundled-esm-inits compile statically and byte-match Node", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/2563-bundled-esm-inits/main.ts"), [
      "gtesm",
      "gtesmws",
      "gtcore",
    ]);
  }, 180_000);

  // 2580-2581: a barrel whose re-exports are memoized lazy loaders of
  // lazily initialized ES modules (a bundle plugin's shape): ES-module
  // importers copy every export when they link (Node's CommonJS import),
  // require() reads each export's getter at the read.
  test.each([
    ["2580-lazy-barrel", ["gtlazy", "gtlazyws"]],
    ["2581-lazy-barrel-require", ["gtlazyuser", "gtlazy"]],
  ])(
    "the lazy barrel %s compiles statically and byte-matches Node",
    async (name, packages) => {
      await expectNodeParity(join(fixturesRoot, `npm/cases/${name}/main.ts`), packages);
    },
    180_000,
  );

  // 2582: two releases of one package in a pnpm store, the newer through
  // an npm alias directory; the default selection compiles both copies.
  test("an npm alias of a selected package compiles from its JavaScript", async () => {
    const entry = join(fixturesRoot, "npm/cases/2582-npm-alias-two-releases/main.ts");
    const { coverage } = analyze(entry);
    expect(coverage.npmStatic).toEqual(
      expect.arrayContaining([
        { package: "gtroute", status: "static" },
        { package: "gtpattern", status: "static" },
      ]),
    );
    const binary = await buildStatic(entry, "auto");
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  // 2583: a module whose export object is one of its functions (semver
  // 5/6's `exports = module.exports = Version`), under both values of the
  // environment variable the module reads.
  test("function export objects 2583-cjs-function-exports compile statically and byte-match Node", async () => {
    const entry = join(fixturesRoot, "npm/cases/2583-cjs-function-exports/main.ts");
    await expectNodeParity(entry, ["gtfnexports", "gtfnmembers"]);
    const binary = await buildStatic(entry, ["gtfnexports", "gtfnmembers"]);
    const env = { ...process.env, GT_LABEL: "x" };
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry], env),
      runBinary(binary, [], env),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.stdout.toString("utf8")).toContain("[x]");
  }, 180_000);

  // 2584: an export object replaced inside an environment-dependent branch
  // (readable-stream 2.x) is named precisely.
  test("an environment-dependent export object is refused by name", () => {
    const entry = join(fixturesRoot, "npm/cases/2584-cjs-conditional-exports/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtcondexports"] });
    expect(JSON.stringify(coverage)).toContain(
      "replacing module.exports outside a top-level statement (a conditional or environment-dependent export object)",
    );
  }, 120_000);

  // 2567: an export that reads `this`, called through its namespace, sees
  // Node's module object; the lowered namespace would differ, so the
  // package stays refused.
  test("a namespace call to an export that reads `this` stays refused", () => {
    const entry = join(fixturesRoot, "npm/cases/2567-esm-namespace-this/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtesmthis", "gtcore"] });
    expect(coverage.npmStatic).toContainEqual({
      package: "gtesmthis",
      status: "refused",
      detail: expect.stringMatching(
        /calls only of exported functions that do not read 'this'/,
      ) as string,
    });
  }, 120_000);

  /* 2585-2587: polyfill packages whose module IS a Node builtin on Node 24
   * compile as the builtins (builtin-package-aliases.ts), installed
   * (2585, 2586) and bundled as versioned __commonJS chunks (2587).
   * readable-stream compiles as its own READABLE_STREAM=disable behavior,
   * so the Node side runs with that variable; util-deprecate's warning
   * reaches stderr on both sides (Node's carries its pid). */
  async function expectAliasParity(
    entry: string,
    packages: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const { coverage } = analyze(entry, { npmStatic: packages });
    expect(coverage.npmStatic).toEqual(packages.map((pkg) => ({ package: pkg, status: "static" })));
    expect(coverage.diagnostics).toHaveLength(0);
    const binary = await buildStatic(entry, packages);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry], env),
      runBinary(binary, [], env),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    const warnings = (stderr: Buffer) =>
      comparableStderr(stderr)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.includes("DeprecationWarning"))
        .map((line) => line.replace(/^\(node:\d+\) /, ""));
    expect(warnings(nativeRes.stderr)).toEqual(warnings(nodeRes.stderr));
    expect(nativeRes.exitCode).toBe(0);
    expect(nodeRes.exitCode).toBe(0);
  }
  const disabled = { ...process.env, READABLE_STREAM: "disable" };

  test("installed polyfill packages 2585-builtin-polyfill-aliases compile as the Node builtins", async () => {
    const entry = join(fixturesRoot, "npm/cases/2585-builtin-polyfill-aliases/main.ts");
    await expectAliasParity(entry, ["gtpolyfills"], process.env);
  }, 180_000);

  test("readable-stream 2.x and 4.x 2586-readable-stream-builtin compile as node:stream", async () => {
    const entry = join(fixturesRoot, "npm/cases/2586-readable-stream-builtin/main.ts");
    await expectAliasParity(entry, ["gtrs2", "gtrs4"], disabled);
  }, 180_000);

  test("bundled polyfill chunks 2587-bundled-polyfill-aliases compile as the Node builtins", async () => {
    const entry = join(fixturesRoot, "npm/cases/2587-bundled-polyfill-aliases/main.ts");
    await expectAliasParity(entry, ["gtpolybundle"], disabled);
  }, 180_000);

  // 2588: classes a bundled ES module defines inside its lazy initializer,
  // over stream.Readable and over each other, compile as declarations.
  test("bundled ES module classes 2588-bundled-esm-classes compile statically and byte-match Node", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/2588-bundled-esm-classes/main.ts"), [
      "gtesmclass",
    ]);
  }, 180_000);

  // 2589: a program class over an error class a bundled package defines
  // inside a lazy initializer (build-utils' NowBuildError shape), with new
  // and instanceof against both.
  test("a program subclass 2589-bundled-error-subclass of a bundled error class byte-matches Node", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/2589-bundled-error-subclass/main.ts"), [
      "gtesmerror",
    ]);
  }, 180_000);

  // 2590: a bundle that embeds fs-extra 9 (build-utils' shape): its
  // fs-extra chunk compiles as the built-in package.
  test("a bundled fs-extra copy 2590-bundled-fs-extra compiles as the built-in package", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/2590-bundled-fs-extra/main.ts"), [
      "gtfsxbundle",
    ]);
  }, 180_000);

  // 2562: a file with unverifiable interop that no compiled code can load
  // (the program imports a leaf data module and only a type from the
  // main entry) leaves its package static.
  test("a package is judged by the files its imported subpaths can load", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/2562-subpath-leaf/main.ts"), [
      "gtsubpath",
    ]);
  }, 180_000);

  // 2566: the same early read through esbuild's `(0, binding.fn)()` call
  // spelling also keeps SC1016.
  test("a CommonJS cycle that calls an export during initialization stays refused", () => {
    const entry = join(fixturesRoot, "npm/cases/2566-cjs-cycle-indirect-call/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtcyclecall"] });
    expect(coverage.npmStatic).toEqual([
      {
        package: "gtcyclecall",
        status: "refused",
        detail: expect.stringMatching(
          /circular imports .*can use its binding 'import_index' of a module of the cycle/,
        ) as string,
      },
    ]);
  }, 120_000);

  // 2571: the partner stores the export (in a const, or in an object
  // literal) and calls it while the cycle initializes; both keep SC1016.
  test("a CommonJS cycle that stores an export and calls it stays refused", () => {
    const entry = join(fixturesRoot, "npm/cases/2571-cjs-cycle-stored-function/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtcyclealias", "gtcyclebox"] });
    for (const pkg of ["gtcyclealias", "gtcyclebox"])
      expect(coverage.npmStatic).toContainEqual({
        package: pkg,
        status: "refused",
        detail: expect.stringMatching(
          /circular imports .*can use its binding 'import_index' of a module of the cycle/,
        ) as string,
      });
  }, 120_000);

  // 2564: a chunk reads a top-level function whose name a nested scope of
  // the chunk also declares; the function still travels with the chunk.
  test("a chunk carries a top-level function its nested scopes shadow", async () => {
    await expectNodeParity(join(fixturesRoot, "npm/cases/2564-chunk-helper-shadowing/main.ts"), [
      "gtchunkshadow",
    ]);
  }, 180_000);

  // 2565: Node shares one function between the chunks that export it; a
  // per-chunk copy would not, so the package stays refused.
  test("chunks that export a shared top-level function stay refused", () => {
    const entry = join(fixturesRoot, "npm/cases/2565-chunk-shared-function/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtchunkshared"] });
    expect(coverage.npmStatic).toEqual([
      {
        package: "gtchunkshared",
        status: "refused",
        detail: expect.stringMatching(
          /uses the bundle's top-level function 'tally' as a value, which its chunks cannot share/,
        ) as string,
      },
    ]);
  }, 120_000);

  test("published type-only declarations coexist with a static runtime bundle", async () => {
    const entry = join(fixturesRoot, "npm/cases/2469-bundle-offender/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["gtghost"] });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.npmStatic).toEqual([
      {
        package: "gtghost",
        status: "static",
      },
    ]);
    const binary = await buildStatic(entry, ["gtghost"]);
    const [reference, actual] = await Promise.all([
      runBinary(process.execPath, [entry]),
      runBinary(binary, []),
    ]);
    expect(actual.stdout).toEqual(reference.stdout);
    expect(comparableStderr(actual.stderr)).toEqual(reference.stderr);
    expect(actual.exitCode).toBe(reference.exitCode);
  }, 120_000);

  // The build-transform-marker relaxation: a getter-table bundle with its
  // own .d.ts is now ELIGIBLE for auto (the esbuild/tsc CJS stamps no
  // longer disqualify — only a bundler RUNTIME like webpack's registry
  // does), and the attempt succeeds outright here.
  test("--npm-static=auto opts a getter-table bundle in", () => {
    const entry = join(fixturesRoot, "npm/cases/2465-getter-table/main.ts");
    const { coverage } = analyze(entry, { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([{ package: "gtable", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
  }, 120_000);

  // The COPIED workspace shape classifies exactly like the symlinked one:
  // node_modules/wscopied is a real directory (no realpath escape — some
  // workspace installers copy members into node_modules), so detection
  // reads the workspace ROOT's "workspaces" globs instead. The member is
  // UNTYPED: its implicit-any module error (the import-site 7016) must
  // never gate. Package-specific diagnostics retain the workspace attribution.
  test("a copied workspace member classifies identically to a symlinked one", () => {
    const { coverage } = analyze(join(fixturesRoot, "npm/cases/workspace-copied/main.ts"));
    expect(coverage.preflightFailed).toBe(false);
    const all = JSON.stringify(coverage.diagnostics);
    expect(all).toContain("wscopied");
    expect(all).not.toContain("nothing installed resolves");
    expect(all).not.toContain("implicitly has an 'any' type");
  }, 120_000);
});
