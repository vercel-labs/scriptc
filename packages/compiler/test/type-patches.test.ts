/* The type patch layer (frontend/type-patches/layer.ts) against real
 * packages: commander's HelpContext.helpWidth @typedef property and ms's
 * @return tags, patched from the fixtures' package.json; installed-version
 * selection; and the warnings for patches that do not apply as written. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { nodeFrontendServices } from "../src/frontend/services-node.js";
import {
  configureTypePatches,
  typePatchDiagnostics,
  typePatchedSpans,
  typePatchedText,
  typePatchFileExists,
  typePatchMatches,
  typePatchSuppliesTypes,
} from "../src/frontend/type-patches/layer.js";

const fixtures = join(import.meta.dirname, "../../../tests/fixtures");
const parse = (path: string, text: string, kind: "ts" | "js") =>
  nodeFrontendServices().parse(path, text, kind);

afterEach(() => configureTypePatches(join(tmpdir(), "none", "main.ts"), parse));

test("commander's HelpContext.helpWidth typedef property reads as number | undefined", () => {
  const root = join(fixtures, "commander-calc");
  configureTypePatches(join(root, "calc.ts"), parse);
  const command = join(root, "node_modules/commander/lib/command.js");
  const text = typePatchedText(command);
  expect(text).toBeDefined();
  expect(text).toContain("   * @property {number | undefined} helpWidth\n");
  expect(text).toContain("   * @returns {HelpContext}\n");
  expect(typePatchMatches()).toMatchObject([
    {
      file: command,
      line: 2481,
      before: "number",
      after: "number | undefined",
      pkg: "commander",
      version: "15.0.0",
    },
  ]);
  const [span] = typePatchedSpans(command);
  expect(text!.slice(span!.start, span!.end)).toBe(" | undefined");
  // Its declaration file has an unrelated HelpContext without helpWidth.
  expect(typePatchedText(join(root, "node_modules/commander/typings/index.d.ts"))).toBeUndefined();
  // Other files of the package are served as they are.
  expect(typePatchedText(join(root, "node_modules/commander/lib/help.js"))).toBeUndefined();
  expect(typePatchDiagnostics()?.diagnostics).toEqual([]);
});

test("ms's parse() and export return tags widen", () => {
  const root = join(fixtures, "type-patches");
  configureTypePatches(join(root, "ms.ts"), parse);
  const file = join(root, "node_modules/ms/index.js");
  const text = typePatchedText(file)!;
  const original = readFileSync(file, "utf8");
  expect(text).toBe(
    original
      .replace(" * @return {String|Number}\n", " * @return {String|Number | undefined}\n")
      .replace(
        " * @return {Number}\n * @api private\n */\n\nfunction parse",
        " * @return {Number | undefined}\n * @api private\n */\n\nfunction parse",
      ),
  );
  expect(text).not.toBe(original);
  expect(typePatchDiagnostics()?.diagnostics.map((d) => d.code)).toEqual([]);
});

test("a project without type patches serves every file unchanged", () => {
  configureTypePatches(join(fixtures, "npm-static", "ms-cli.ts"), parse);
  expect(typePatchedText(join(fixtures, "npm-static/node_modules/ms/index.js"))).toBeUndefined();
  expect(typePatchDiagnostics()).toBeNull();
});

test("patches that do not apply as written warn", () => {
  const root = join(fixtures, "type-patches");
  configureTypePatches(join(root, "stale", "main.ts"), parse);
  expect(typePatchedText(join(root, "node_modules/termctx/index.js"))).toBeUndefined();
  typePatchedText(join(root, "node_modules/ms/index.js"));
  const diags = typePatchDiagnostics()!.diagnostics;
  expect(diags.map((d) => [d.code, d.message])).toEqual([
    [
      "SC8030",
      "type patch 'termctx@^2.0.0' does not apply to termctx 1.2.0 at ../node_modules/termctx; its declarations are used unpatched",
    ],
    [
      "SC8031",
      "type patch 'ms@^2.1.0': 'index.js:format()' matches no declaration in the files of ms this program loads",
    ],
    ["SC8032", "type patch 'ms@^2.1.0': 'index.js:fmtShort(ms)' is already declared as Number"],
    [
      "SC8033",
      "type patch 'ms@^2.1.0': 'index.js:plural()' has no written type to widen; give the whole type instead (index.js)",
    ],
  ]);
  expect(
    diags.every((d) => d.loc.file === join(root, "stale", "package.json") && d.loc.start > 0),
  ).toBe(true);
});

test("an @types twin is matched by the runtime package's installed version", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-type-patches-"));
  try {
    const twin = join(fixtures, "npm/cases/type-patch-types-twin");
    configureTypePatches(join(twin, "main.ts"), parse);
    const text = typePatchedText(join(twin, "node_modules/@types/tallyjs/index.d.ts"))!;
    expect(text).toContain("  max: number | undefined;\n  mean: number | null;\n");
    // A range the installed runtime (0.4.2) does not satisfy leaves it alone,
    // even though the twin's own version (0.4.0) would.
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scriptc: {
          typePatches: { "tallyjs@0.4.0": { declarations: { "Totals.max": "| undefined" } } },
        },
      }),
    );
    configureTypePatches(join(root, "main.ts"), parse);
    expect(typePatchedText(join(twin, "node_modules/@types/tallyjs/index.d.ts"))).toBeUndefined();
    expect(typePatchDiagnostics()!.diagnostics.map((d) => d.code)).toEqual(["SC8030"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an @types twin in pnpm's layout is matched by the runtime package the project resolves", () => {
  // pnpm keeps each package in its own directory under node_modules/.pnpm
  // and links the project's dependencies from node_modules: the twin has no
  // runtime package beside it.
  const root = mkdtempSync(join(tmpdir(), "scriptc-type-patches-pnpm-"));
  try {
    const store = join(root, "node_modules/.pnpm");
    const runtime = join(store, "tallyjs@0.5.0/node_modules/tallyjs");
    const types = join(store, "@types+tallyjs@0.4.0/node_modules/@types/tallyjs");
    mkdirSync(runtime, { recursive: true });
    mkdirSync(types, { recursive: true });
    writeFileSync(join(runtime, "package.json"), '{ "name": "tallyjs", "version": "0.5.0" }');
    writeFileSync(join(runtime, "index.js"), "exports.totals = () => ({});\n");
    writeFileSync(join(types, "package.json"), '{ "name": "@types/tallyjs", "version": "0.4.0" }');
    writeFileSync(
      join(types, "index.d.ts"),
      "export type Totals = {\n  max: number;\n};\nexport declare function totals(): Totals;\n",
    );
    mkdirSync(join(root, "node_modules/@types"), { recursive: true });
    symlinkSync(runtime, join(root, "node_modules/tallyjs"));
    symlinkSync(types, join(root, "node_modules/@types/tallyjs"));
    const patchFor = (range: string) =>
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scriptc: {
            typePatches: {
              [`tallyjs@${range}`]: { declarations: { "Totals.max": "| undefined" } },
            },
          },
        }),
      );
    // A range the runtime (0.5.0) satisfies applies, though the twin's own
    // version (0.4.0) does not satisfy it.
    patchFor("0.5.0");
    configureTypePatches(join(root, "main.ts"), parse);
    expect(typePatchedText(join(types, "index.d.ts"))).toContain("max: number | undefined;");
    // A range only the twin's own version satisfies does not.
    patchFor("0.4.0");
    configureTypePatches(join(root, "main.ts"), parse);
    expect(typePatchedText(join(types, "index.d.ts"))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an export before its hoisted function is patched, and string text that looks like JSDoc is not", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-type-patches-js-"));
  try {
    const pkg = join(root, "node_modules/hoistkit");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{ "name": "hoistkit", "version": "1.0.0" }');
    const source = [
      '"use strict";',
      "exports.measure = size;",
      'exports.doc = "/** @typedef {object} Opts\\n * @property {number} width */";',
      "",
      "/**",
      " * @returns {number}",
      " */",
      "function size(s) {",
      "  return s.length || undefined;",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(pkg, "index.js"), source);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scriptc: {
          typePatches: {
            "hoistkit@^1.0.0": {
              declarations: { "measure()": "| undefined", "Opts.width": "| undefined" },
            },
          },
        },
      }),
    );
    configureTypePatches(join(root, "main.ts"), parse);
    // The export, under another name, comes before the function it exports:
    // the function's @returns tag widens.
    expect(typePatchedText(join(pkg, "index.js"))).toBe(
      source.replace(" * @returns {number}\n", " * @returns {number | undefined}\n"),
    );
    // The string's text is a value, not a typedef: the patch finds nothing.
    expect(
      typePatchDiagnostics()!
        .diagnostics.map((d) => d.message)
        .join("\n"),
    ).toContain("Opts.width");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files replaces a declaration file and declarations still apply on top", () => {
  const root = join(fixtures, "npm/cases/type-patch-files");
  configureTypePatches(join(root, "main.ts"), parse);
  const entry = typePatchedText(join(root, "node_modules/eventlog/dist/entry.d.ts"));
  expect(entry).toBe(readFileSync(join(root, "type-patches/entry.d.ts"), "utf8"));
  expect(typePatchedText(join(root, "node_modules/eventlog/dist/index.d.ts"))).toContain(
    "{ count: number; last: string | undefined }",
  );
  expect(typePatchDiagnostics()!.diagnostics).toEqual([]);
});

test("types gives a package without declarations an entry beside its main", () => {
  const root = join(fixtures, "npm/cases/type-patch-types-entry");
  configureTypePatches(join(root, "main.ts"), parse);
  const pkg = join(root, "node_modules/pointjs");
  expect(typePatchFileExists(join(pkg, "lib/point.d.ts"))).toBe(true);
  expect(typePatchFileExists(join(pkg, "index.d.ts"))).toBe(false);
  expect(typePatchFileExists(join(pkg, "lib/other.d.ts"))).toBe(false);
  expect(typePatchSuppliesTypes(pkg)).toBe(true);
  expect(typePatchedText(join(pkg, "lib/point.d.ts"))).toBe(
    readFileSync(join(root, "type-patches/pointjs.d.ts"), "utf8"),
  );
  // Without patches nothing exists that is not on disk.
  configureTypePatches(join(tmpdir(), "none", "main.ts"), parse);
  expect(typePatchFileExists(join(pkg, "lib/point.d.ts"))).toBe(false);
  expect(typePatchSuppliesTypes(pkg)).toBe(false);
});

test("types gives a package whose main is a .jsx file an entry beside it", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-type-patches-"));
  try {
    const pkg = join(root, "node_modules/viewjs");
    mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "viewjs", version: "1.0.0", main: "lib/view.jsx" }),
    );
    writeFileSync(join(pkg, "lib/view.jsx"), "export const view = 1;\n");
    writeFileSync(join(root, "viewjs.d.ts"), "export declare const view: number;\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scriptc: { typePatches: { "viewjs@^1.0.0": { types: "./viewjs.d.ts" } } } }),
    );
    configureTypePatches(join(root, "main.ts"), parse);
    expect(typePatchFileExists(join(pkg, "lib/view.d.ts"))).toBe(true);
    expect(typePatchSuppliesTypes(pkg)).toBe(true);
    expect(typePatchedText(join(pkg, "lib/view.d.ts"))).toBe(
      "export declare const view: number;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a files target the installed package does not ship warns", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-type-patches-"));
  try {
    const twin = join(fixtures, "npm/cases/type-patch-files");
    writeFileSync(join(root, "local.d.ts"), "export type Entry = {};\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scriptc: {
          typePatches: { "eventlog@^2.0.0": { files: { "dist/gone.d.ts": "./local.d.ts" } } },
        },
      }),
    );
    configureTypePatches(join(root, "main.ts"), parse);
    expect(typePatchedText(join(twin, "node_modules/eventlog/dist/index.d.ts"))).toBeUndefined();
    const diags = typePatchDiagnostics()!.diagnostics;
    expect(diags.map((d) => d.code)).toEqual(["SC8031"]);
    expect(diags[0]!.message).toMatch(
      /^type patch 'eventlog@\^2\.0\.0': dist\/gone\.d\.ts is not a file of eventlog at .*type-patch-files\/node_modules\/eventlog$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
