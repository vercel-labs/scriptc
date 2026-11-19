import { execFile } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

// A package that declares `"scriptc": { "source": true }` ships TypeScript
// meant to compile into the program that installs it. The fixture's dom-kit
// is installed under node_modules (not linked), its runtime extends a base
// class declared only in its own source, and the program extends the
// runtime's class again.
//
// Node.js refuses to strip types under node_modules, so the oracle runs the
// same files with the package linked from outside node_modules, the layout a
// git checkout of the package has. The native binary must match it
// byte-for-byte.

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/source-package");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/source-package");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const scratch = mkdtempSync(join(tmpdir(), "scriptc-source-package-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(file: string, args: string[], cwd: string): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { cwd, encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof e.code !== "number") throw error;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
  }
}

/** The fixture copied to `name` under the scratch directory. */
function copyFixture(name: string): string {
  const dir = join(scratch, name);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

// Naming the package in --npm-static selects nothing: it still compiles from
// its TypeScript, not from published JavaScript it doesn't ship.
test.for([
  ["by default", undefined],
  ["when --npm-static names it", ["dom-kit"]],
] as const)(
  "a package marked as source compiles from node_modules %s and matches Node",
  async ([label, npmStatic]) => {
    const outDir = join(cacheDir, `${sanitize ? "san" : "plain"}-${label.replaceAll(/\W+/g, "-")}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(fixture, "main.ts"), {
      outPath: join(outDir, "program"),
      outDir,
      backend: "llvm",
      sanitize,
      ...(npmStatic !== undefined ? { npmStatic } : {}),
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const native = await run(result.binaryPath, [], fixture);

    const linked = copyFixture(`linked-${outDir.slice(outDir.lastIndexOf("/") + 1)}`);
    mkdirSync(join(linked, "packages"));
    cpSync(join(linked, "node_modules/dom-kit"), join(linked, "packages/dom-kit"), {
      recursive: true,
    });
    rmSync(join(linked, "node_modules/dom-kit"), { recursive: true });
    symlinkSync("../packages/dom-kit", join(linked, "node_modules/dom-kit"));
    const node = await run(process.execPath, ["main.ts"], linked);

    expect(native).toEqual(node);
    expect(native.stdout).toBe(
      [
        '<div id="app">Hello, [<button type="submit">Send</button>]</div>',
        "Hello, Send",
        "true true true",
        "submit null",
        "4 #text,BUTTON",
        "",
      ].join("\n"),
    );
  },
  120_000,
);

test("a package without the source mark keeps refusing its TypeScript", async () => {
  const dir = copyFixture("unmarked");
  const manifest = join(dir, "node_modules/dom-kit/package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  delete pkg["scriptc"];
  writeFileSync(manifest, JSON.stringify(pkg, null, 2));

  const result = await compile(join(dir, "main.ts"), {
    outPath: join(dir, "program"),
    outDir: join(dir, "out"),
    backend: "llvm",
    sanitize,
  });
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toContain(
    "SC2013: cannot compile npm package 'dom-kit' statically: it ships no own .d.ts declaration surface",
  );
}, 120_000);

test("a type error in a source package is reported in the package's file", async () => {
  const dir = copyFixture("type-error");
  const dom = join(dir, "node_modules/dom-kit/runtime/dom.ts");
  writeFileSync(dom, `${readFileSync(dom, "utf8")}export const count: number = "none";\n`);

  const result = await compile(join(dir, "main.ts"), {
    outPath: join(dir, "program"),
    outDir: join(dir, "out"),
    backend: "llvm",
    sanitize,
  });
  expect(result.ok).toBe(false);
  expect(
    result.diagnostics.map((d) => [
      d.loc.file.endsWith("/node_modules/dom-kit/runtime/dom.ts"),
      d.message,
    ]),
  ).toContainEqual([true, "Type 'string' is not assignable to type 'number'."]);
}, 120_000);
