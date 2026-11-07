/* `--node-island=<path>` marks a module of the program to run in a Node
 * island, and `--node-island=<package>` a package. A mark is honored or
 * refused by name, never accepted and ignored: a marked JavaScript or
 * TypeScript module runs in Node, and a mark that names the entry module, no
 * module of the program, or a package the program does not load from
 * node_modules stops the build with SC8006.
 *
 * What a value names does not depend on what the name looks like: a package
 * called `widget.js` is marked by its name, `./widget.js` is always the
 * file, and a refusal says how the value was read and how to write the
 * other reading. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const sanitize = process.env["SCRIPTC_SAN"] === "1";
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A program whose helper module builds a function from a string: native
 * code refuses that, Node runs it. */
function program(helper: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-marks-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, "main.ts"),
    `import { adder } from "./${helper}";\nconsole.log(adder(2)(40));\n`,
  );
  writeFileSync(
    join(dir, helper),
    helper.endsWith(".ts")
      ? 'export function adder(n: number): (v: number) => number {\n  return new Function("v", `return v + ${n};`) as (v: number) => number;\n}\n'
      : '/** @param {number} n @returns {(v: number) => number} */\nexport function adder(n) {\n  return new Function("v", `return v + ${n};`);\n}\n',
  );
  return dir;
}

function build(dir: string, islands: string[]) {
  return compile(join(dir, "main.ts"), {
    outPath: join(dir, "main"),
    outDir: dir,
    sanitize,
    nodeIslands: { islands },
  });
}

describe("--node-island marks", () => {
  test("a mark on the entry module is refused by name", async () => {
    const dir = program("helper.ts");
    const result = await build(dir, [join(dir, "main.ts")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      "SC8006: --node-island marks the entry module to run in a Node island, and the entry module stays native",
    ]);
  });

  test("a mark that names no module of the program is refused by name", async () => {
    const dir = program("helper.ts");
    const missing = join(dir, "not-imported.ts");
    const result = await build(dir, [missing]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      `SC8006: --node-island=${missing} names no module of this program: read as the path ${missing}, because a value that starts with '.' or '/' is a path`,
    ]);
  });

  test("a package name the program does not load is refused by name", async () => {
    const dir = program("helper.ts");
    const result = await build(dir, ["left-pad"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      `SC8006: --node-island=left-pad names no package this program loads from node_modules: read as the package 'left-pad', because no file ${resolve("left-pad")} exists`,
    ]);
  });

  test("a package scriptc compiles from its own implementation is refused by name", async () => {
    // chalk 5 compiles from packages/compiler/shims/chalk/v5.ts.
    const entry = join(import.meta.dirname, "../fixtures/npm/cases/chalk5/main.ts");
    const dir = mkdtempSync(join(tmpdir(), "scriptc-island-marks-"));
    scratch.push(dir);
    const result = await compile(entry, {
      outPath: join(dir, "main"),
      outDir: dir,
      sanitize,
      nodeIslands: { islands: ["chalk"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      "SC8006: --node-island=chalk cannot run 'chalk' in a Node island: scriptc compiles this package from its own implementation, not from the installed one",
    ]);
  });

  test.skipIf(libnodePack() === null).each(["helper.ts", "helper.js"])(
    "a marked %s module runs in a Node island",
    async (helper) => {
      const dir = program(helper);
      const result = await build(dir, [join(dir, helper)]);
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(result.islands?.modules.map((file) => basename(file))).toEqual([helper]);
      expect(execFileSync(result.binaryPath, { encoding: "utf8" })).toBe("42\n");
    },
    120_000,
  );
});

const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");

/** `scriptc <command> main.ts <args>` run in `cwd`, as a user types it: the
 * frontend only (`--emit=ir` for a build), so no libnode pack is needed. The
 * text is what the command printed, with `cwd` shown as `<dir>`. */
function scriptc(
  cwd: string,
  command: "build" | "coverage",
  args: string[],
): { status: number | null; text: string } {
  const out = mkdtempSync(join(tmpdir(), "scriptc-island-marks-out-"));
  scratch.push(out);
  const run = spawnSync(
    process.execPath,
    [
      cli,
      command,
      "main.ts",
      ...(command === "build" ? ["--emit=ir", "-o", join(out, "main.ir.json")] : []),
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", SCRIPTC_NO_CACHE: "1" } },
  );
  return { status: run.status, text: `${run.stdout}${run.stderr}`.replaceAll(cwd, "<dir>") };
}

/** A program around the package `widget.js`, whose name looks like a file:
 *
 *   main.ts                    imports the package, ./widget.js and ./legacy.js
 *   widget.js, legacy.js       modules of the program
 *   notes.js, spare.js         files the program does not load
 *   node_modules/widget.js     the package; `plain` keeps it inside the
 *                              native subset, otherwise it builds a function
 *                              from a string
 *   node_modules/spare.js      a package the program does not load
 */
function packageProgram(plain = false): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-island-marks-")));
  scratch.push(dir);
  const file = (name: string, text: string): void => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  file("package.json", '{ "type": "module" }\n');
  file(
    "main.ts",
    [
      'import { adder } from "widget.js";',
      'import { local } from "./widget.js";',
      'import { legacy } from "./legacy.js";',
      "console.log(adder(2)(40), local(), legacy());",
      "",
    ].join("\n"),
  );
  file("widget.js", '/** @returns {string} */\nexport function local() {\n  return "local";\n}\n');
  file(
    "legacy.js",
    '/** @returns {string} */\nexport function legacy() {\n  return "legacy";\n}\n',
  );
  file("notes.js", "export const unused = 1;\n");
  file("spare.js", "export const unused = 2;\n");
  file(
    "node_modules/widget.js/package.json",
    '{ "name": "widget.js", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
  );
  file(
    "node_modules/widget.js/index.js",
    plain
      ? '"use strict";\nexports.adder = function adder(n) {\n  return function (v) {\n    return v + n;\n  };\n};\n'
      : '"use strict";\nexports.adder = function adder(n) {\n  return new Function("v", `return v + ${n};`);\n};\n',
  );
  file(
    "node_modules/widget.js/index.d.ts",
    "export declare function adder(n: number): (v: number) => number;\n",
  );
  file("node_modules/spare.js/package.json", '{ "name": "spare.js", "version": "1.0.0" }\n');
  return dir;
}

describe("--node-island on a package named like a file", () => {
  const packageNote = "note SC8001: package 'widget.js@1.0.0' runs in a Node island";
  const moduleNote = (file: string): string =>
    `note SC8001: module '<dir>/${file}' runs in a Node island`;

  test.each([
    // The package, by its name and by a subpath of it: the name ends in .js
    // and a file ./widget.js exists, and it is still the package.
    ["widget.js", packageNote],
    ["widget.js/", packageNote],
    ["widget.js/index.js", packageNote],
    // The file of the same name, by a path.
    ["./widget.js", moduleNote("widget.js")],
    // A bare value no package is named like is the file it names.
    ["legacy.js", moduleNote("legacy.js")],
  ])("--node-island=%s is honored", (mark, note) => {
    const run = scriptc(packageProgram(), "build", [
      "--node-islands=explicit",
      `--node-island=${mark}`,
    ]);
    expect(run.text).toContain(note);
    expect(run.text.split("note SC8001").length - 1).toBe(1);
    expect(run.status).toBe(0);
  });

  test.each([
    [
      "node_modules/widget.js",
      "names no module of this program: read as the path <dir>/node_modules/widget.js, because no package is named node_modules",
      "to mark the package write --node-island=widget.js",
    ],
    [
      "node_modules/widget.js/**",
      "names no module of this program: read as the glob <dir>/node_modules/widget.js/**, because a value with '*' is a glob over the program's own modules",
      "to mark the package write --node-island=widget.js",
    ],
    [
      "./absent.js",
      "names no module of this program: read as the path <dir>/absent.js, because a value that starts with '.' or '/' is a path",
      "to mark a package write its name as the program imports it",
    ],
    [
      "notes.js",
      "names no module of this program: read as the path <dir>/notes.js, because that file exists and the entry module resolves no package of that name",
      "the program loads no module from this file",
    ],
    [
      "absent.js",
      "names no package this program loads from node_modules: read as the package 'absent.js', because no file <dir>/absent.js exists",
      "a path starts with ./ (--node-island=./absent.js)",
    ],
    [
      "spare.js",
      "names no package this program loads from node_modules: read as the package 'spare.js', because the entry module resolves a package of that name, which wins over the file <dir>/spare.js",
      "a path starts with ./ (--node-island=./spare.js)",
    ],
  ])("--node-island=%s is refused, and the refusal says how it was read", (mark, message, hint) => {
    const run = scriptc(packageProgram(), "build", [`--node-island=${mark}`]);
    expect(run.text).toContain(`error SC8006: --node-island=${mark} ${message}`);
    expect(run.text).toContain(hint);
    expect(run.status).toBe(1);
  });

  test("--native takes the name as a package, and contradicts a mark on a subpath of it", () => {
    const dir = packageProgram();
    expect(scriptc(dir, "coverage", ["--native=widget.js"]).text).toContain(
      "SC8003  npm package 'widget.js' is marked native but is outside the native subset",
    );
    const run = scriptc(dir, "build", ["--native=widget.js", "--node-island=widget.js/index.js"]);
    expect(run.text).toContain(
      "error SC8006: --node-island=widget.js/index.js and --native=widget.js contradict each other",
    );
    expect(run.status).toBe(1);
  });

  test("--npm-static takes the name as a package: it compiles and runs natively", async () => {
    const dir = packageProgram(true);
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, "main"),
      outDir: dir,
      sanitize,
      npmStatic: ["widget.js"],
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.islands).toBeUndefined();
    expect(execFileSync(result.binaryPath, { encoding: "utf8" })).toBe("42 local legacy\n");
  }, 120_000);

  test.skipIf(libnodePack() === null).each(["widget.js", "widget.js/index.js"])(
    "the package marked with %s runs in a Node island",
    async (mark) => {
      const dir = packageProgram();
      const result = await compile(join(dir, "main.ts"), {
        outPath: join(dir, "main"),
        outDir: dir,
        sanitize,
        nodeIslands: { mode: "explicit", islands: [mark] },
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(result.islands).toEqual({ packages: ["widget.js"], modules: [] });
      expect(execFileSync(result.binaryPath, { encoding: "utf8" })).toBe("42 local legacy\n");
    },
    120_000,
  );
});

describe("SC8006 for a mark that matches nothing", () => {
  // The corpus program's directory: its packages are named like files.
  const fixture = join(repoRoot, "tests/corpus/8735-node-island-package-named-like-file");

  test.each([
    [
      "paths",
      [
        "node_modules/widget.js",
        "node_modules/@acme/table.json/**",
        "./lib/missing.js",
        "package.json",
      ],
    ],
    ["packages", ["absent.js", "@acme/missing.json/lib/index.js"]],
  ])("the rendered refusal of %s", async (name, marks) => {
    const run = scriptc(
      fixture,
      "build",
      marks.map((mark) => `--node-island=${mark}`),
    );
    expect(run.status).toBe(1);
    await expect(run.text).toMatchFileSnapshot(`__snapshots__/node-island-marks-${name}.txt`);
  });
});
