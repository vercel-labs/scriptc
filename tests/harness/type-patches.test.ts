/* Type patches (package.json scriptc.typePatches): project-owned fixes for
 * npm declarations that do not describe what the package does. A JSDoc
 * @typedef property and @returns tag that say number for an undefined
 * value (the shape of commander's HelpContext.helpWidth), and ms's @return
 * tags, compile natively and byte-match Node once patched; without the
 * patches the same declarations throw where Node runs. Patches that do not
 * apply as written warn (SC8030-SC8033). The `.d.ts`, `@types`, replaced
 * file and supplied entry cases run in npm.test.ts (type-patch-dts,
 * type-patch-types-twin, type-patch-files, type-patch-types-entry); here
 * their unpatched copies show the patches are what makes them compile, and
 * a failing check names the declaration and the patch (scr_type_origin.c,
 * frontend/lowering/decl-origin.ts), its own package's also when two
 * packages declare a record of one name and shape. And
 * commander-calc carries the HelpContext.helpWidth patch. */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/type-patches");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/type-patches");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(cmd: string, args: string[]): Promise<Run> {
  try {
    const pending = execFileAsync(cmd, args, { encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

async function build(entry: string, name: string, npmStatic: string[]) {
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, { outPath: join(outDir, name), outDir, sanitize, npmStatic });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return result;
}

/** A copy of a fixture directory whose package.json has no scriptc key. */
function unpatched(dir: string): string {
  const copy = mkdtempSync(join(tmpdir(), "scriptc-unpatched-"));
  cpSync(dir, copy, { recursive: true });
  const manifest = join(copy, "package.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  delete parsed["scriptc"];
  writeFileSync(manifest, JSON.stringify(parsed, null, 2));
  return copy;
}

describe("type patches", () => {
  test.for([
    ["jsdoc.ts", ["termctx"]],
    ["ms.ts", ["ms"]],
  ] as const)(
    "%s compiles with its patches and byte-matches Node",
    { timeout: 600_000 },
    async ([file, pkgs]) => {
      const entry = join(fixture, file);
      const result = await build(entry, file.replace(".ts", ""), [...pkgs]);
      expect(result.warnings ?? []).toEqual([]);
      const [node, native] = await Promise.all([
        run(process.execPath, [entry]),
        run(result.binaryPath, []),
      ]);
      expect(node.exitCode).toBe(0);
      expect(native).toEqual(node);
    },
  );

  test(
    "without the patches the lying JSDoc throws where Node runs",
    { timeout: 600_000 },
    async () => {
      const copy = unpatched(fixture);
      try {
        const result = await build(join(copy, "jsdoc.ts"), "jsdoc-unpatched", ["termctx"]);
        const native = await run(result.binaryPath, []);
        expect(native.exitCode).not.toBe(0);
        expect(native.stderr).toContain("TypeError");
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
  );

  test(
    "without the patch the lying .d.ts throws at the declaration boundary",
    { timeout: 600_000 },
    async () => {
      const copy = unpatched(join(repoRoot, "tests/fixtures/npm/cases/type-patch-dts"));
      try {
        mkdirSync(outDir, { recursive: true });
        const result = await compile(join(copy, "main.ts"), {
          outPath: join(outDir, "dts-unpatched"),
          outDir,
          sanitize,
        });
        // Unpatched, `p.email ?? ...` and `found === undefined` test values
        // the declarations say cannot be missing; the build may refuse them
        // or the boundary cast throws when the guest profile crosses.
        if (result.ok) {
          const native = await run(result.binaryPath, []);
          expect(native.exitCode).not.toBe(0);
          expect(native.stderr).toBe(
            "Uncaught TypeError: expected string at $, got undefined\n" +
              "    profilekit@3.1.0 declares Profile.email as string (index.d.ts:7)\n" +
              `    if that declaration is wrong, patch it: scriptc types patch profilekit Profile.email '| undefined'\n`,
          );
        }
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
  );

  test(
    "without its patch, code using the out-of-date declaration file does not type-check",
    { timeout: 600_000 },
    async () => {
      const copy = unpatched(join(repoRoot, "tests/fixtures/npm/cases/type-patch-files"));
      try {
        mkdirSync(outDir, { recursive: true });
        const result = await compile(join(copy, "main.ts"), {
          outPath: join(outDir, "files-unpatched"),
          outDir,
          sanitize,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.diagnostics.map((d) => d.message)).toContain(
            "Property 'toUpperCase' does not exist on type 'number'.",
          );
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
  );

  test(
    "without its patch, a package without declarations is not compiled for a typed import",
    { timeout: 600_000 },
    async () => {
      const copy = unpatched(join(repoRoot, "tests/fixtures/npm/cases/type-patch-types-entry"));
      try {
        mkdirSync(outDir, { recursive: true });
        const result = await compile(join(copy, "main.ts"), {
          outPath: join(outDir, "types-entry-unpatched"),
          outDir,
          sanitize,
        });
        expect(result.ok).toBe(false);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
  );

  test(
    "a failing check names the package declaration and the patch",
    { timeout: 600_000 },
    async () => {
      const result = await build(join(fixture, "unpatched/main.ts"), "unpatched", ["termctx"]);
      const native = await run(result.binaryPath, []);
      const patch = (selector: string) =>
        `    if that declaration is wrong, patch it: scriptc types patch termctx ${selector} '| undefined'`;
      expect(native.stdout).toBe(
        [
          "expected number at $, got undefined",
          "    termctx@1.2.0 declares Terminal.columns() as number (index.js:16)",
          patch("'Terminal.columns()'"),
          "undefined is not representable in the target union (a value narrowed or asserted past it still held it)",
          "    termctx@1.2.0 declares OutputContext.width as number (index.js:24)",
          patch("OutputContext.width"),
          "",
        ].join("\n"),
      );
    },
  );

  test(
    "records of one name and shape from two packages name their own declarations",
    { timeout: 600_000 },
    async () => {
      const result = await build(join(fixture, "same-name/main.ts"), "same-name", [
        "panectx",
        "gridctx",
      ]);
      const native = await run(result.binaryPath, []);
      const failure = (pkg: string, version: string) => [
        "undefined is not representable in the target union (a value narrowed or asserted past it still held it)",
        `    ${pkg}@${version} declares OutputContext.width as number (index.js:24)`,
        `    if that declaration is wrong, patch it: scriptc types patch ${pkg} OutputContext.width '| undefined'`,
      ];
      expect(native.stdout).toBe(
        [...failure("panectx", "2.0.0"), ...failure("gridctx", "4.1.0"), ""].join("\n"),
      );
    },
  );

  test(
    "a rebuild after the package's version changes names the installed version",
    { timeout: 600_000 },
    async () => {
      const copy = mkdtempSync(join(tmpdir(), "scriptc-reinstalled-"));
      try {
        cpSync(fixture, copy, { recursive: true });
        const entry = join(copy, "unpatched/main.ts");
        const declares = async (name: string) => {
          const native = await run((await build(entry, name, ["termctx"])).binaryPath, []);
          return native.stdout.split("\n").filter((line) => line.includes(" declares "));
        };
        expect(await declares("reinstalled-1.2.0")).toEqual([
          "    termctx@1.2.0 declares Terminal.columns() as number (index.js:16)",
          "    termctx@1.2.0 declares OutputContext.width as number (index.js:24)",
        ]);
        writeFileSync(
          join(copy, "node_modules/termctx/package.json"),
          '{ "name": "termctx", "version": "1.3.0", "main": "index.js" }\n',
        );
        expect(await declares("reinstalled-1.3.0")).toEqual([
          "    termctx@1.3.0 declares Terminal.columns() as number (index.js:16)",
          "    termctx@1.3.0 declares OutputContext.width as number (index.js:24)",
        ]);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
  );

  test(
    "patches that do not apply as written warn and the build goes on",
    { timeout: 600_000 },
    async () => {
      const entry = join(fixture, "stale/main.ts");
      const result = await build(entry, "stale", ["ms", "termctx"]);
      expect((result.warnings ?? []).map((w) => w.code)).toEqual([
        "SC8030",
        "SC8031",
        "SC8032",
        "SC8033",
      ]);
      const [node, native] = await Promise.all([
        run(process.execPath, [entry]),
        run(result.binaryPath, []),
      ]);
      expect(native).toEqual(node);
    },
  );
});
