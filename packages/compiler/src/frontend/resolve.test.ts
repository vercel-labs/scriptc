import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  clearResolveCaches,
  projectDtsRuntimeSibling,
  resolveProjectModule,
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
