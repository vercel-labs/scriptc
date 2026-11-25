/* `--native=<package>` requires a package to compile natively, and
 * `--npm-static=<packages>` selects packages whose shipped JavaScript
 * compiles. Like a `--node-island` mark (node-island-marks.test.ts), neither
 * is accepted for a name that means nothing:
 *
 *  - `--native` decides where one package of this program runs, so a name
 *    the program does not load from node_modules stops the build (SC8006);
 *  - `--npm-static` is a selection that may serve several entry modules, so
 *    a name the program does not load selects nothing (and coverage does not
 *    list it as compiled), and a name that is installed nowhere the program
 *    could load it from stops the build (SC8006).
 *
 * `scriptc coverage` reports the same refusals. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A program that imports `plain-pkg` for its value, beside an installed
 * package nothing imports (`unused-pkg`), a scoped one (`@scope/unused`), a
 * dependency installed inside `plain-pkg` that it never requires
 * (`nested-dep`) with a dependency of its own (`deep-dep`), and an entry that
 * imports `plain-pkg` for a type only. */
function program(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-package-marks-"));
  scratch.push(dir);
  const install = (at: string, files: Record<string, string>): void => {
    mkdirSync(join(dir, at), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, at, file), text);
  };
  const unused = (name: string): Record<string, string> => ({
    "package.json": `{ "name": "${name}", "version": "1.0.0", "main": "index.js" }\n`,
    "index.js": "exports.x = 1;\n",
  });
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, "main.ts"),
    'import { twice } from "plain-pkg";\nconsole.log(twice(4));\n',
  );
  writeFileSync(
    join(dir, "types-only.ts"),
    'import type { Twice } from "plain-pkg";\nconst twice: Twice = (n) => n * 2;\nconsole.log(twice(4));\n',
  );
  install("node_modules/plain-pkg", {
    "package.json":
      '{ "name": "plain-pkg", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
    "index.js": '"use strict";\nexports.twice = function twice(n) {\n  return n * 2;\n};\n',
    "index.d.ts":
      "export declare function twice(n: number): number;\nexport type Twice = (n: number) => number;\n",
  });
  install("node_modules/unused-pkg", unused("unused-pkg"));
  install("node_modules/@scope/unused", unused("@scope/unused"));
  install("node_modules/plain-pkg/node_modules/nested-dep", unused("nested-dep"));
  install(
    "node_modules/plain-pkg/node_modules/nested-dep/node_modules/deep-dep",
    unused("deep-dep"),
  );
  return dir;
}

interface Marks {
  native?: string[];
  npmStatic?: string[];
  mode?: "auto" | "explicit" | "off";
}

/** What a build to IR says: its diagnostics as `code: message`, or "ok". */
async function build(dir: string, marks: Marks, entry = "main.ts"): Promise<string[]> {
  const result = await compile(join(dir, entry), {
    outPath: join(dir, "main.ir.json"),
    outDir: join(dir, ".scriptc"),
    outputKind: "ir",
    ...(marks.npmStatic !== undefined ? { npmStatic: marks.npmStatic } : {}),
    ...(marks.native !== undefined || marks.mode !== undefined
      ? {
          nodeIslands: {
            ...(marks.native !== undefined ? { native: marks.native } : {}),
            ...(marks.mode !== undefined ? { mode: marks.mode } : {}),
          },
        }
      : {}),
  });
  return result.ok ? ["ok"] : result.diagnostics.map((d) => `${d.code}: ${d.message}`);
}

const notLoaded = (value: string): string =>
  `SC8006: --native=${value} names no package this program loads from node_modules`;
const notInstalled = (value: string): string =>
  `SC8006: --npm-static=${value} names no package this program loads or could load from node_modules`;

describe("--native and --npm-static marks", () => {
  test("a mark that names a package the program loads is honored", async () => {
    const dir = program();
    expect(await build(dir, {})).toEqual(["ok"]);
    expect(await build(dir, { native: ["plain-pkg"] })).toEqual(["ok"]);
    expect(await build(dir, { npmStatic: ["plain-pkg"] })).toEqual(["ok"]);
    expect(await build(dir, { npmStatic: ["plain-pkg..."] })).toEqual(["ok"]);
    expect(await build(dir, { native: ["plain-pkg"], npmStatic: ["plain-pkg"] })).toEqual(["ok"]);
  });

  test("a name that is installed nowhere is refused by both flags", async () => {
    const dir = program();
    expect(await build(dir, { native: ["absent"] })).toEqual([notLoaded("absent")]);
    expect(await build(dir, { npmStatic: ["absent"] })).toEqual([notInstalled("absent")]);
    expect(await build(dir, { npmStatic: ["absent..."] })).toEqual([notInstalled("absent...")]);
  });

  test.each([
    ["an installed package nothing imports", "unused-pkg"],
    ["a scoped package nothing imports", "@scope/unused"],
    ["a dependency installed inside a loaded package", "nested-dep"],
  ])("%s: --native is refused, the --npm-static selection is empty", async (_what, name) => {
    const dir = program();
    expect(await build(dir, { native: [name] })).toEqual([notLoaded(name)]);
    expect(await build(dir, { npmStatic: [name] })).toEqual(["ok"]);
  });

  test("a selection finds a dependency through the named package that installs it", async () => {
    const dir = program();
    // deep-dep is installed inside nested-dep only: named together it is
    // found; alone, nothing the program loads would resolve it.
    expect(await build(dir, { npmStatic: ["deep-dep", "nested-dep"] })).toEqual(["ok"]);
    expect(await build(dir, { npmStatic: ["deep-dep"] })).toEqual([notInstalled("deep-dep")]);
  });

  test("a name both flags carry is refused for --native and an empty selection for --npm-static", async () => {
    const dir = program();
    expect(await build(dir, { native: ["unused-pkg"], npmStatic: ["unused-pkg"] })).toEqual([
      notLoaded("unused-pkg"),
    ]);
    expect(await build(dir, { native: ["absent"], npmStatic: ["absent"] })).toEqual([
      notLoaded("absent"),
      notInstalled("absent"),
    ]);
  });

  test("a dependency installed inside a second installation of a loaded package is found", async () => {
    // host-pkg brings its own copy of plain-pkg, and only that copy
    // installs inner-dep: the program loads both installations of
    // plain-pkg, and each is a place a named dependency may live.
    const dir = program();
    const at = (path: string, files: Record<string, string>): void => {
      mkdirSync(join(dir, path), { recursive: true });
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, path, file), text);
    };
    at("node_modules/host-pkg", {
      "package.json":
        '{ "name": "host-pkg", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
      "index.js":
        '"use strict";\nconst { twice } = require("plain-pkg");\nexports.quad = function quad(n) {\n  return twice(twice(n));\n};\n',
      "index.d.ts": "export declare function quad(n: number): number;\n",
    });
    at("node_modules/host-pkg/node_modules/plain-pkg", {
      "package.json":
        '{ "name": "plain-pkg", "version": "2.0.0", "main": "index.js", "types": "index.d.ts" }\n',
      "index.js": '"use strict";\nexports.twice = function twice(n) {\n  return n + n;\n};\n',
      "index.d.ts": "export declare function twice(n: number): number;\n",
    });
    at("node_modules/host-pkg/node_modules/plain-pkg/node_modules/inner-dep", {
      "package.json": '{ "name": "inner-dep", "version": "1.0.0", "main": "index.js" }\n',
      "index.js": "exports.x = 1;\n",
    });
    writeFileSync(
      join(dir, "both.ts"),
      'import { twice } from "plain-pkg";\nimport { quad } from "host-pkg";\nconsole.log(twice(4), quad(1));\n',
    );
    expect(await build(dir, {}, "both.ts")).toEqual(["ok"]);
    expect(await build(dir, { npmStatic: ["inner-dep"] }, "both.ts")).toEqual(["ok"]);
    // The entry that loads only the first installation has nowhere to
    // find it.
    expect(await build(dir, { npmStatic: ["inner-dep"] })).toEqual([notInstalled("inner-dep")]);
  });

  test("a mark given twice is judged once", async () => {
    const dir = program();
    expect(await build(dir, { native: ["absent", "absent"] })).toEqual([notLoaded("absent")]);
    expect(await build(dir, { npmStatic: ["absent", "absent", "absent..."] })).toEqual([
      notInstalled("absent"),
    ]);
    expect(await build(dir, { native: ["plain-pkg", "plain-pkg"] })).toEqual(["ok"]);
  });

  test("the project's configuration is not held to the entry; the flag is", async () => {
    // A project's scriptc.packages may list packages for other entries, so
    // a setting for a package this entry does not load is not refused. The
    // same name on the command line is a mark on this build.
    const dir = program();
    writeFileSync(
      join(dir, "package.json"),
      '{ "type": "module", "scriptc": { "packages": { "unused-pkg": "native", "absent": "native" } } }\n',
    );
    expect(await build(dir, {})).toEqual(["ok"]);
    expect(await build(dir, { native: ["unused-pkg"] })).toEqual([notLoaded("unused-pkg")]);
    expect(await build(dir, { npmStatic: ["unused-pkg"] })).toEqual(["ok"]);
    expect(await build(dir, { npmStatic: ["absent"] })).toEqual([notInstalled("absent")]);
  });

  test("a package named like a file is a package, whatever file has its name", async () => {
    // --node-island reads `widget.js` as the package when the entry
    // resolves one of that name (policy.ts readNodeIslandMark). These two
    // flags name packages only, so the file beside the entry never counts.
    const dir = program();
    mkdirSync(join(dir, "node_modules/widget.js"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/widget.js/package.json"),
      '{ "name": "widget.js", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
    );
    writeFileSync(
      join(dir, "node_modules/widget.js/index.js"),
      '"use strict";\nexports.widget = function widget() {\n  return "package";\n};\n',
    );
    writeFileSync(
      join(dir, "node_modules/widget.js/index.d.ts"),
      "export declare function widget(): string;\n",
    );
    writeFileSync(join(dir, "widget.js"), "export const unrelated = 1;\n");
    writeFileSync(join(dir, "notes.js"), "export const unrelated = 2;\n");
    writeFileSync(
      join(dir, "named.ts"),
      'import { widget } from "widget.js";\nconsole.log(widget());\n',
    );
    expect(await build(dir, { native: ["widget.js"] }, "named.ts")).toEqual(["ok"]);
    expect(await build(dir, { npmStatic: ["widget.js"] }, "named.ts")).toEqual(["ok"]);
    // A file of the program's directory is not a package.
    expect(await build(dir, { native: ["notes.js"] }, "named.ts")).toEqual([notLoaded("notes.js")]);
    expect(await build(dir, { npmStatic: ["notes.js"] }, "named.ts")).toEqual([
      notInstalled("notes.js"),
    ]);
    // The entry that does not import the package: the mark is refused, the
    // selection is empty.
    expect(await build(dir, { native: ["widget.js"] })).toEqual([notLoaded("widget.js")]);
    expect(await build(dir, { npmStatic: ["widget.js"] })).toEqual(["ok"]);
  });

  test("each refused mark is named, the others are not", async () => {
    const dir = program();
    expect(
      await build(dir, {
        native: ["plain-pkg", "absent"],
        npmStatic: ["unused-pkg", "plain-pkg", "missing"],
      }),
    ).toEqual([notLoaded("absent"), notInstalled("missing")]);
  });

  test("a path inside a package names no package, and the hint names the package", async () => {
    const dir = program();
    for (const [flag, marks, message] of [
      ["--native", { native: ["plain-pkg/index.js"] }, notLoaded("plain-pkg/index.js")],
      ["--npm-static", { npmStatic: ["plain-pkg/index.js"] }, notInstalled("plain-pkg/index.js")],
    ] as const) {
      const result = await compile(join(dir, "main.ts"), {
        outPath: join(dir, "main.ir.json"),
        outDir: join(dir, ".scriptc"),
        outputKind: "ir",
        ...("npmStatic" in marks ? { npmStatic: marks.npmStatic } : {}),
        ...("native" in marks ? { nodeIslands: { native: marks.native } } : {}),
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics.map((d) => `${d.code}: ${d.message} / ${d.hint}`)).toEqual([
        `${message} / the flag names a package, not a module of one: write ${flag}=plain-pkg`,
      ]);
    }
  });

  test("an import of a type loads nothing", async () => {
    const dir = program();
    expect(await build(dir, { native: ["plain-pkg"] }, "types-only.ts")).toEqual([
      notLoaded("plain-pkg"),
    ]);
    expect(await build(dir, { npmStatic: ["plain-pkg"] }, "types-only.ts")).toEqual(["ok"]);
  });

  test.each(["explicit", "off"] as const)(
    "the refusal does not depend on --node-islands=%s",
    async (mode) => {
      const dir = program();
      expect(await build(dir, { native: ["absent"], mode })).toEqual([notLoaded("absent")]);
      expect(await build(dir, { npmStatic: ["absent"], mode })).toEqual([notInstalled("absent")]);
      expect(await build(dir, { npmStatic: ["plain-pkg", "unused-pkg"], mode })).toEqual(["ok"]);
    },
  );

  test("a package scriptc compiles from its own implementation is left to that rule", async () => {
    // chalk 5 compiles from packages/compiler/shims/chalk/v5.ts: it is
    // compiled natively, which is what --native asks for.
    const entry = join(import.meta.dirname, "../fixtures/npm/cases/chalk5/main.ts");
    const dir = mkdtempSync(join(tmpdir(), "scriptc-package-marks-"));
    scratch.push(dir);
    const result = await compile(entry, {
      outPath: join(dir, "main.ir.json"),
      outDir: dir,
      outputKind: "ir",
      nodeIslands: { native: ["chalk"] },
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  test("coverage reports the refusals and lists only what compiles", async () => {
    const dir = program();
    const report = (marks: Marks): { diagnostics: string[]; packages: string[] } => {
      const { coverage } = analyze(join(dir, "main.ts"), {
        ...(marks.npmStatic !== undefined ? { npmStatic: marks.npmStatic } : {}),
        ...(marks.native !== undefined ? { nodeIslands: { native: marks.native } } : {}),
      });
      return {
        diagnostics: coverage.diagnostics.map((d) => `${d.code}: ${d.message}`),
        packages: (coverage.npmStatic ?? []).map((entry) => `${entry.package} ${entry.status}`),
      };
    };
    expect(report({ npmStatic: ["plain-pkg"] })).toEqual({
      diagnostics: [],
      packages: ["plain-pkg static"],
    });
    // Installed, not loaded: the selection is empty for it, and it is not
    // listed as compiled.
    expect(report({ npmStatic: ["plain-pkg", "unused-pkg"] })).toEqual({
      diagnostics: [],
      packages: ["plain-pkg static"],
    });
    expect(report({ npmStatic: ["absent"] })).toEqual({
      diagnostics: [notInstalled("absent")],
      packages: [],
    });
    expect(report({ native: ["absent"] })).toEqual({
      diagnostics: [notLoaded("absent")],
      packages: [],
    });
  });
});
