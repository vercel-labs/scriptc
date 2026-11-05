import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const corpus = join(import.meta.dirname, "../corpus");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.each([
  ["package", "3064-installed-entry-imports", "main.ts"],
  ["@scope/package", "3064-installed-entry-imports", "main.ts"],
  ["outer/node_modules/package", "3064-installed-entry-imports", "main.ts"],
  ["package", "3065-installed-entry-js", "main.js"],
  ["@scope/package", "3065-installed-entry-js", "main.js"],
])("explicit entry in node_modules/%s: %s", async (name, fixture, entryName) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-installed-entry-"));
  try {
    const original = join(corpus, fixture);
    const installed = join(dir, "node_modules", name);
    cpSync(original, installed, { recursive: true });
    const entry = join(installed, entryName);
    // Node refuses native TS stripping inside node_modules. Its oracle
    // runs the identical source tree at the original corpus location.
    const oracle = await execFileAsync(process.execPath, [join(original, entryName)]);
    for (const backend of ["llvm"] as const) {
      const outDir = join(dir, backend);
      const built = await compile(entry, {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        sanitize,
      });
      expect(built.ok, !built.ok ? JSON.stringify(built.diagnostics) : "").toBe(true);
      if (!built.ok) continue;
      const native = await execFileAsync(built.binaryPath);
      expect(native.stdout).toBe(oracle.stdout);
      expect(native.stderr).toBe(oracle.stderr);
    }
    {
      const { coverage } = analyze(entry, {});
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.stats.statementsFailed).toBe(0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ["dependency", "package/node_modules/dependency", "dependency"],
  ["package-extra", "package-extra", "package-extra"],
  ["relative dependency", "package/node_modules/dependency", "./node_modules/dependency/index.js"],
])(
  "installed entry resolves %s with native package rules",
  async (label, dependencyPath, specifier) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-installed-entry-dependency-"));
    try {
      const entry = join(dir, "node_modules/package/main.ts");
      const dependency = join(dir, "node_modules", dependencyPath);
      mkdirSync(dirname(entry), { recursive: true });
      mkdirSync(dependency, { recursive: true });
      writeFileSync(join(dirname(entry), "package.json"), '{"type":"module"}\n');
      writeFileSync(
        join(dependency, "package.json"),
        JSON.stringify({ type: "module", main: "index.js", types: "index.d.ts" }),
      );
      writeFileSync(join(dependency, "index.d.ts"), "export declare const value: number;\n");
      writeFileSync(join(dependency, "index.js"), "export const value = 42;\n");
      writeFileSync(
        entry,
        `import { value } from ${JSON.stringify(specifier)}; ` + "console.log(`value ${value}`);\n",
      );
      const { coverage } = analyze(entry);
      expect(coverage.preflightFailed, label).toBe(false);
      if (specifier.startsWith(".")) {
        // A relative path into a nested dependency does not select that
        // package's implementation graph or extend the entry's ownership.
        expect(new Set(coverage.diagnostics.map((d) => d.code))).toEqual(new Set(["SC2013"]));
        return;
      }
      expect(coverage.diagnostics, label).toEqual([]);
      const outDir = join(dir, "out");
      const built = await compile(entry, { outDir, outPath: join(outDir, "program"), sanitize });
      expect(built.ok, JSON.stringify(built.diagnostics)).toBe(true);
      if (!built.ok) return;
      const native = await execFileAsync(built.binaryPath);
      expect(native.stdout).toBe("value 42\n");
      expect(native.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("installed entry ownership follows a linked package's source graph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-installed-entry-link-"));
  try {
    const original = join(corpus, "3065-installed-entry-js");
    const source = join(dir, "source");
    cpSync(original, source, { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(
      source,
      join(dir, "node_modules/package"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const entry = join(dir, "node_modules/package/main.js");
    const outDir = join(dir, "out");
    const built = await compile(entry, { outDir, outPath: join(outDir, "program"), sanitize });
    expect(built.ok, !built.ok ? JSON.stringify(built.diagnostics) : "").toBe(true);
    if (!built.ok) return;
    const [native, node] = await Promise.all([
      execFileAsync(built.binaryPath),
      execFileAsync(process.execPath, [entry]),
    ]);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit installed JavaScript entry keeps diagnostics in its own modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-installed-entry-errors-"));
  try {
    const entry = join(dir, "node_modules/package/main.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(join(dirname(entry), "package.json"), '{"type":"module"}\n');
    writeFileSync(entry, 'import { value } from "./value.js"; console.log(value);\n');
    // A syntax error: a read of an undeclared name is Node's run-time
    // ReferenceError in JavaScript, not a diagnostic.
    writeFileSync(join(dirname(entry), "value.js"), "export const value = ;\n");
    const { coverage } = analyze(entry);
    expect(coverage.preflightFailed).toBe(true);
    expect(coverage.diagnostics.map((d) => d.code)).toEqual(["SC0001"]);
    expect(coverage.diagnostics[0]?.loc.file.replaceAll("\\", "/")).toBe(
      join(dirname(entry), "value.js").replaceAll("\\", "/"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
