import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";

const root = join(import.meta.dirname, "../..");

test.each(["build", "run", "coverage"])("%s rejects the retired --dynamic option", (command) => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "packages/cli/src/main.ts"), command, "main.ts", "--dynamic"],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--dynamic");
});

test("default package compilation preserves checked values, regex, imports, and comptime without an engine", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-static-only-"));
  try {
    mkdirSync(join(directory, "node_modules"));
    cpSync(
      join(root, "tests/fixtures/npm-static/node_modules/slash"),
      join(directory, "node_modules/slash"),
      { recursive: true },
    );
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `import slash from "slash";
const answer = comptime(() => 6 * 7);
const value: any = answer;
const path = await import("node:path");
console.log(slash("a\\\\b"), /^a/.test("abc"), value + 1, path.basename("a/b"));
`,
    );
    const coverage = analyze(entry).coverage;
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.npmStatic).toEqual([{ package: "slash", status: "static" }]);
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, process.platform === "win32" ? "program.exe" : "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const actual = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    const expected = spawnSync(
      process.execPath,
      ["--import", join(root, "tests/harness/comptime-shim.mjs"), entry],
      { encoding: "utf8" },
    );
    expect(actual.status, actual.stderr).toBe(expected.status);
    expect(actual.stdout).toBe(expected.stdout);
    const stderr =
      process.env["SCRIPTC_SAN"] === "1"
        ? actual.stderr
            .split("\n")
            .filter(
              (line) =>
                !line.startsWith("scriptc RC audit skipped:") &&
                !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(line),
            )
            .join("\n")
        : actual.stderr;
    expect(stderr).toBe(expected.stderr);
    expect(actual.stdout).toBe("a/b true 43 b\n");
    expect(readFileSync(result.llvmPath, "utf8")).not.toMatch(/@scr_(?:island|jsval)_/);
    if (process.platform !== "win32") {
      const symbols = spawnSync("nm", [result.binaryPath], { encoding: "utf8" });
      expect(symbols.status, symbols.stderr).toBe(0);
      expect(symbols.stdout).not.toMatch(/\b_?(?:JS_NewRuntime|JS_Eval|scr_island_init)\b/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an ineligible package fails with its package-specific native refusal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-package-refusal-"));
  try {
    // Node islands off: the native refusal itself (with islands on, the
    // package would run in a Node island instead).
    const result = await compile(join(root, "tests/fixtures/npm-static/typegap-mix.ts"), {
      outDir: directory,
      outPath: join(directory, "program"),
      nodeIslands: { mode: "off" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "SC2013",
          message: expect.stringContaining("cannot compile npm package 'typegapped' statically"),
        }),
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
