import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  clearResolveCaches,
  projectDtsRuntimeSibling,
  resolveInTypeRoots,
  resolveProjectModule,
  resolveTypesAsProject,
  resolveWorkspaceSourceModule,
  setProjectPathMappings,
  setProjectRealm,
} from "./resolve.js";
import { setNpmStaticPackages } from "./npm-static.js";

const fixturesRoot = join(import.meta.dirname, "../../../..", "tests/fixtures");

test("resolver reset clears the active project package realm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-resolve-reset-"));
  try {
    const src = join(dir, "src");
    const declaration = join(src, "value.d.ts");
    const runtime = join(src, "value.js");
    await mkdir(src);
    await Promise.all([
      writeFile(join(dir, "package.json"), '{"type":"module"}\n'),
      writeFile(declaration, "export declare const value: number;\n"),
      writeFile(runtime, "export const value = 1;\n"),
    ]);

    clearResolveCaches();
    setProjectRealm(join(src, "main.ts"));
    expect(projectDtsRuntimeSibling(declaration)).toBe(runtime);
    setProjectPathMappings({ "@app/value": [join(src, "value")] });
    expect(resolveProjectModule(join(src, "main.ts"), "@app/value")).toBe(runtime);

    clearResolveCaches();
    expect(projectDtsRuntimeSibling(declaration)).toBeNull();
    expect(resolveProjectModule(join(src, "main.ts"), "@app/value")).toBeNull();
  } finally {
    clearResolveCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a project without a package.json is one declaration realm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-resolve-barerealm-"));
  try {
    const src = join(dir, "src");
    const nested = join(src, "nested");
    await mkdir(nested, { recursive: true });
    const declarations = {
      module: join(src, "value.d.ts"),
      esm: join(src, "value.d.mts"),
      cjs: join(src, "value.d.cts"),
      lone: join(src, "lone.d.ts"),
      other: join(nested, "other.d.ts"),
    };
    await Promise.all([
      writeFile(declarations.module, "export declare const value: number;\n"),
      writeFile(join(src, "value.js"), "export const value = 1;\n"),
      writeFile(declarations.esm, "export declare const value: number;\n"),
      writeFile(join(src, "value.mjs"), "export const value = 1;\n"),
      writeFile(declarations.cjs, "export declare const value: number;\n"),
      writeFile(join(src, "value.cjs"), "exports.value = 1;\n"),
      writeFile(declarations.lone, "export declare const value: number;\n"),
      writeFile(declarations.other, "export declare const value: number;\n"),
      writeFile(join(nested, "other.js"), "export const value = 1;\n"),
      writeFile(join(nested, "package.json"), '{"type":"module"}\n'),
    ]);

    clearResolveCaches();
    setProjectRealm(join(src, "main.ts"));
    expect(projectDtsRuntimeSibling(declarations.module)).toBe(join(src, "value.js"));
    expect(projectDtsRuntimeSibling(declarations.esm)).toBe(join(src, "value.mjs"));
    expect(projectDtsRuntimeSibling(declarations.cjs)).toBe(join(src, "value.cjs"));
    // A declaration without a runtime sibling, and one owned by a nested
    // package.json realm, stay declarations.
    expect(projectDtsRuntimeSibling(declarations.lone)).toBeNull();
    expect(projectDtsRuntimeSibling(declarations.other)).toBeNull();
  } finally {
    clearResolveCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("source-only workspace packages are project modules while JavaScript packages stay external", () => {
  const sourceEntry = join(fixturesRoot, "workspace-source/main.ts");
  const sourceDir = realpathSync(join(fixturesRoot, "workspace-source/node_modules/wssource"));
  const sourceModule = join(sourceDir, "index.ts");
  const sourceMember = join(sourceDir, "describe.ts");
  const jsEntry = join(fixturesRoot, "npm/cases/workspace-linked/main.ts");

  clearResolveCaches();
  try {
    expect(resolveWorkspaceSourceModule(sourceEntry, "wssource")?.typesFile).toBe(sourceModule);
    expect(resolveProjectModule(sourceEntry, "wssource")).toBe(sourceModule);
    expect(resolveProjectModule(sourceModule, "./describe.js")).toBe(sourceMember);
    expect(resolveWorkspaceSourceModule(jsEntry, "wslinked")).toBeNull();
    expect(resolveProjectModule(jsEntry, "wslinked")).toBeNull();
  } finally {
    clearResolveCaches();
  }
});

test("package imports inside a --npm-static package answer the shipped JavaScript", async () => {
  // chalk 5's shape: a declaration twin beside every runtime file, and a
  // `{ node, default }` imports entry whose node target is what Node runs.
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "scriptc-resolve-imports-")));
  try {
    const pkg = join(dir, "node_modules", "colors");
    const vendor = join(pkg, "source", "vendor");
    await mkdir(join(vendor, "styles"), { recursive: true });
    await mkdir(join(vendor, "detect"), { recursive: true });
    await Promise.all([
      writeFile(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "colors",
          version: "1.0.0",
          type: "module",
          exports: "./source/index.js",
          imports: {
            "#styles": "./source/vendor/styles/index.js",
            "#detect": {
              node: "./source/vendor/detect/index.js",
              default: "./source/vendor/detect/browser.js",
            },
          },
        }),
      ),
      writeFile(join(pkg, "source", "index.js"), 'import styles from "#styles";\n'),
      writeFile(join(pkg, "source", "index.d.ts"), "export {};\n"),
      writeFile(join(vendor, "styles", "index.js"), "export default {};\n"),
      writeFile(join(vendor, "styles", "index.d.ts"), "export {};\n"),
      writeFile(join(vendor, "detect", "index.js"), "export default 1;\n"),
      writeFile(join(vendor, "detect", "index.d.ts"), "export {};\n"),
      writeFile(join(vendor, "detect", "browser.js"), "export default 0;\n"),
      writeFile(join(vendor, "detect", "browser.d.ts"), "export {};\n"),
    ]);
    const from = join(pkg, "source", "index.js");

    clearResolveCaches();
    setNpmStaticPackages([]);
    expect(resolveProjectModule(from, "#styles")).toBe(join(vendor, "styles", "index.d.ts"));

    clearResolveCaches();
    setNpmStaticPackages(["colors"]);
    expect(resolveProjectModule(from, "#styles")).toBe(join(vendor, "styles", "index.js"));
    expect(resolveProjectModule(from, "#detect")).toBe(join(vendor, "detect", "index.js"));
    expect(resolveProjectModule(from, "#missing")).toBeNull();
  } finally {
    setNpmStaticPackages([]);
    clearResolveCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

/** A project directory with the packages and typings the tests below name:
 * `files` maps a path under it to the file's text. */
async function projectTree(files: Record<string, string>): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "scriptc-resolve-project-types-")));
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  }
  return dir;
}

const EXPORTS_ONLY_CLI = JSON.stringify({
  name: "shapes-kit",
  version: "1.0.0",
  type: "module",
  exports: { "./cli": { types: "./dist/cli.d.mts", default: "./dist/cli.mjs" } },
});

test("a node10 project reads a file the exports map does not list, for types only", async () => {
  const dir = await projectTree({
    "node_modules/shapes-kit/package.json": EXPORTS_ONLY_CLI,
    "node_modules/shapes-kit/dist/cli.d.mts": "export declare const commands: string[];\n",
    "node_modules/shapes-kit/dist/cli.mjs": "export const commands = [];\n",
    "types/shapes-kit.d.ts": "",
  });
  try {
    clearResolveCaches();
    const shim = join(dir, "types/shapes-kit.d.ts");
    const main = join(dir, "main.ts");
    const declaration = join(dir, "node_modules/shapes-kit/dist/cli.d.mts");
    const node10 = { typeRoots: [], byPath: true };
    const bundler = { typeRoots: [], byPath: false };
    // In the project's declaration file, and in an import Node erases.
    expect(resolveTypesAsProject(shim, "shapes-kit/dist/cli.mjs", node10, true)).toBe(declaration);
    expect(resolveTypesAsProject(main, "shapes-kit/dist/cli.mjs", node10, true)).toBe(declaration);
    // An import Node resolves at run time, where the map refuses it, stays
    // unresolved: preflight reports Node's refusal.
    expect(resolveTypesAsProject(main, "shapes-kit/dist/cli.mjs", node10, false)).toBeNull();
    // A project that resolves as a bundler does reads the map, as its tsc.
    expect(resolveTypesAsProject(shim, "shapes-kit/dist/cli.mjs", bundler, true)).toBeNull();
    // What the map lists resolves without help, and nothing is added.
    expect(resolveTypesAsProject(main, "shapes-kit/cli", node10, false)).toBeNull();
    // Relative, package-internal, URL-like and missing specifiers.
    expect(resolveTypesAsProject(main, "./dist/cli.mjs", node10, true)).toBeNull();
    expect(resolveTypesAsProject(main, "#cli", node10, true)).toBeNull();
    expect(resolveTypesAsProject(main, "node:fs", node10, true)).toBeNull();
    expect(resolveTypesAsProject(shim, "ghost-kit/dist/cli.mjs", node10, true)).toBeNull();
  } finally {
    clearResolveCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a node10 project finds declarations by path where the exports map names none", async () => {
  const dir = await projectTree({
    "node_modules/rule-kit/package.json": JSON.stringify({
      name: "rule-kit",
      version: "1.2.0",
      type: "module",
      exports: { "./cli": "./dist/cli.mjs" },
    }),
    "node_modules/rule-kit/dist/cli.mjs": "export function rule() {}\n",
    "node_modules/rule-kit/cli.d.ts": "export declare function rule(): void;\n",
  });
  try {
    clearResolveCaches();
    const main = join(dir, "main.ts");
    // Node loads the file the map names, so the import is not a refusal;
    // its declarations are where a lookup by path finds them.
    expect(resolveTypesAsProject(main, "rule-kit/cli", { typeRoots: [], byPath: true }, false)).toBe(
      join(dir, "node_modules/rule-kit/cli.d.ts"),
    );
    expect(
      resolveTypesAsProject(main, "rule-kit/cli", { typeRoots: [], byPath: false }, false),
    ).toBeNull();
  } finally {
    clearResolveCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a module without declarations in node_modules is found under a type root", async () => {
  const dir = await projectTree({
    "node_modules/tiny-lines/package.json": '{ "name": "tiny-lines", "version": "0.1.1", "main": "index.js" }',
    "node_modules/tiny-lines/index.js": "exports.parse = () => [];\n",
    "node_modules/typed-kit/package.json":
      '{ "name": "typed-kit", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }',
    "node_modules/typed-kit/index.js": "exports.one = 1;\n",
    "node_modules/typed-kit/index.d.ts": "export declare const one: number;\n",
    "typings/tiny-lines/index.d.ts": 'declare module "tiny-lines";\n',
    "typings/typed-kit/index.d.ts": 'declare module "typed-kit";\n',
    "typings/count-kit.d.ts": "export declare function count(): number;\n",
    "typings/field-kit/package.json": '{ "types": "lib/main.d.ts" }',
    "typings/field-kit/lib/main.d.ts": "export {};\n",
    "typings/field-kit/index.d.ts": "export {};\n",
    "typings/empty-kit/readme.txt": "",
  });
  try {
    clearResolveCaches();
    const main = join(dir, "main.ts");
    const typeRoots = [join(dir, "missing-root"), join(dir, "typings")];
    const project = { typeRoots, byPath: false };
    // A file, a package directory's `types` file, a directory's index.
    expect(resolveInTypeRoots(typeRoots, "count-kit")).toBe(join(dir, "typings/count-kit.d.ts"));
    expect(resolveInTypeRoots(typeRoots, "field-kit")).toBe(
      join(dir, "typings/field-kit/lib/main.d.ts"),
    );
    expect(resolveInTypeRoots(typeRoots, "tiny-lines")).toBe(
      join(dir, "typings/tiny-lines/index.d.ts"),
    );
    expect(resolveInTypeRoots(typeRoots, "empty-kit")).toBeNull();
    expect(resolveInTypeRoots(typeRoots, "ghost-kit")).toBeNull();
    expect(resolveInTypeRoots([], "count-kit")).toBeNull();
    // The package's JavaScript loads at run time; its declarations are the
    // type root's, before the JavaScript, as tsc orders them.
    expect(resolveTypesAsProject(main, "tiny-lines", project, false)).toBe(
      join(dir, "typings/tiny-lines/index.d.ts"),
    );
    // A package with declarations of its own keeps them.
    expect(resolveTypesAsProject(main, "typed-kit", project, false)).toBeNull();
    // A module nothing installed provides: only where Node never loads it.
    expect(resolveTypesAsProject(main, "count-kit", project, false)).toBeNull();
    expect(resolveTypesAsProject(main, "count-kit", project, true)).toBe(
      join(dir, "typings/count-kit.d.ts"),
    );
    expect(resolveTypesAsProject(main, "tiny-lines", { typeRoots: [], byPath: false }, false)).toBeNull();
  } finally {
    clearResolveCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
