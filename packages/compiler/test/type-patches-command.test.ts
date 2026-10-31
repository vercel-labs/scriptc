/* `scriptc types patch` and `scriptc types list`
 * (frontend/type-patches/command.ts) on a copy of the type patch fixture:
 * matches are shown before anything is written, the patch lands in the
 * nearest package.json under a range covering the installed version (or
 * an existing entry that covers it), and nothing is written when the
 * selector matches nothing or the build already uses the requested type. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nodeFrontendServices } from "../src/frontend/services-node.js";
import { runTypePatchCommand } from "../src/frontend/type-patches/command.js";

const fixture = join(import.meta.dirname, "../../../tests/fixtures/type-patches");
const parse = (path: string, text: string, kind: "ts" | "js") =>
  nodeFrontendServices().parse(path, text, kind);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scriptc-types-command-"));
  cpSync(fixture, root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "app", private: true, type: "module" }, null, 2) + "\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const patch = (pkg: string, selector: string, type: string, extra: object = {}) =>
  runTypePatchCommand(
    { action: "patch", cwd: root, pkg, selector, type, range: null, dryRun: false, ...extra },
    parse,
  );

test("patch shows the matches and writes the entry", () => {
  const result = patch("termctx", "OutputContext.width", "| undefined");
  expect(result).toEqual({
    stdout:
      "termctx 1.2.0 (node_modules/termctx)\n" +
      "  index.js:24  number  ->  number | undefined\n" +
      `wrote package.json scriptc.typePatches["termctx@^1.2.0"].declarations["OutputContext.width"]\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
    name: "app",
    private: true,
    type: "module",
    scriptc: {
      typePatches: {
        "termctx@^1.2.0": { declarations: { "OutputContext.width": "| undefined" } },
      },
    },
  });
  // A second patch joins the entry whose range covers the installed copy.
  expect(patch("termctx", "Terminal.columns()", "| undefined").exitCode).toBe(0);
  const text = readFileSync(join(root, "package.json"), "utf8");
  expect(text.endsWith("}\n")).toBe(true);
  expect(JSON.parse(text).scriptc.typePatches).toEqual({
    "termctx@^1.2.0": {
      declarations: { "OutputContext.width": "| undefined", "Terminal.columns()": "| undefined" },
    },
  });
});

test("--range and --dry-run", () => {
  const dry = patch("ms", "index.js:parse()", "| undefined", { dryRun: true, range: "2.1.x" });
  expect(dry.stdout).toBe(
    "ms 2.1.3 (node_modules/ms)\n" +
      "  index.js:44  Number  ->  Number | undefined\n" +
      `would write package.json scriptc.typePatches["ms@2.1.x"].declarations["index.js:parse()"]\n`,
  );
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scriptc).toBeUndefined();
});

test("nothing is written for a selector that matches nothing or is already so", () => {
  const missing = patch("termctx", "OutputContext.height", "| undefined");
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toBe(
    "scriptc: 'OutputContext.height' matches no declaration\nnothing was written\n",
  );
  const redundant = patch("ms", "index.js:fmtShort(ms)", "| Number");
  expect(redundant).toMatchObject({ exitCode: 0 });
  expect(redundant.stdout).toContain("the declarations already say this; nothing was written\n");
  expect(patch("absent-package", "A.b", "| undefined").stderr).toBe(
    "scriptc: absent-package is not installed here\n",
  );
  expect(patch("termctx", "1bad", "| undefined").stderr).toContain("is not a selector");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scriptc).toBeUndefined();
});

test("a type the declarations already say replaces a covering patch that says another", () => {
  const manifest = join(root, "package.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: "app",
        scriptc: {
          typePatches: {
            "termctx@^1.2.0": { declarations: { "OutputContext.width": "| undefined" } },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  const result = patch("termctx", "OutputContext.width", "number");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    `wrote package.json scriptc.typePatches["termctx@^1.2.0"].declarations["OutputContext.width"]\n`,
  );
  expect(JSON.parse(readFileSync(manifest, "utf8")).scriptc.typePatches).toEqual({
    "termctx@^1.2.0": { declarations: { "OutputContext.width": "number" } },
  });
  expect(patch("termctx", "OutputContext.width", "number").stdout).toContain(
    "the declarations already say this; nothing was written\n",
  );
});

test("list shows each patch and what it matches", () => {
  writeFileSync(join(root, "package.json"), readFileSync(join(fixture, "package.json")));
  const listed = runTypePatchCommand({ action: "list", cwd: root }, parse);
  expect(listed.stdout).toBe(
    [
      "termctx@^1.0.0",
      "  OutputContext.width: | undefined",
      "    node_modules/termctx/index.js:24  number  ->  number | undefined",
      "  Terminal.columns(): | undefined",
      "    node_modules/termctx/index.js:14  number  ->  number | undefined",
      "ms@^2.1.0",
      "  index.js:parse(): | undefined",
      "    node_modules/ms/index.js:44  Number  ->  Number | undefined",
      "  export=(): | undefined",
      "    node_modules/ms/index.js:22  String|Number  ->  String|Number | undefined",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "stale.json"), "");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scriptc: { typePatches: { "termctx@^2.0.0": { declarations: { "A.b": "| undefined" } } } },
    }),
  );
  expect(runTypePatchCommand({ action: "list", cwd: root }, parse).stdout).toBe(
    "termctx@^2.0.0\n  does not apply to the installed termctx 1.2.0\n  A.b: | undefined\n",
  );
});

test("nothing is written when a replacement is ambiguous in one of the files it matches", () => {
  const pkg = join(root, "node_modules/overloads");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "overloads", version: "1.0.0", types: "index.d.ts" }),
  );
  writeFileSync(join(pkg, "index.d.ts"), "export declare function pick(a: string): string;\n");
  writeFileSync(
    join(pkg, "more.d.ts"),
    "export declare function pick(a: string): string;\nexport declare function pick(a: number): string;\n",
  );
  const result = patch("overloads", "pick()", "string | undefined");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe(
    "scriptc: 'pick()' matches 2 declarations in more.d.ts; a replacement must name one " +
      "(widen them, or replace the declaration file) (more.d.ts)\nnothing was written\n",
  );
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scriptc).toBeUndefined();
});

test("the patch goes to the covering entry the compiler applies", () => {
  const manifest = join(root, "package.json");
  const entries = {
    "termctx@^1.0.0": { declarations: { "OutputContext.width": "| null" } },
    "termctx@1.x": { declarations: { "OutputContext.width": "| null" } },
  };
  writeFileSync(manifest, JSON.stringify({ name: "app", scriptc: { typePatches: entries } }));
  // Both ranges cover termctx 1.2.0, and the later entry wins on the same
  // selector: it takes the patch.
  const result = patch("termctx", "OutputContext.width", "| undefined");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    `wrote package.json scriptc.typePatches["termctx@1.x"].declarations["OutputContext.width"]\n`,
  );
  expect(JSON.parse(readFileSync(manifest, "utf8")).scriptc.typePatches).toEqual({
    "termctx@^1.0.0": { declarations: { "OutputContext.width": "| null" } },
    "termctx@1.x": { declarations: { "OutputContext.width": "| undefined" } },
  });
  // Asked for the earlier range, the later entry would still win.
  const earlier = patch("termctx", "OutputContext.width", "| undefined", { range: "^1.0.0" });
  expect(earlier.exitCode).toBe(1);
  expect(earlier.stderr).toBe(
    `scriptc: scriptc.typePatches["termctx@1.x"] also patches 'OutputContext.width' for termctx 1.2.0 ` +
      `and takes precedence over scriptc.typePatches["termctx@^1.0.0"]\nnothing was written\n`,
  );
});
