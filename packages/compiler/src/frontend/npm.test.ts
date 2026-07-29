import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { NpmGraphBuilder } from "./npm.js";

const appDir = resolve("virtual-npm-app");
const mainFile = join(appDir, "main.ts");

function hostOf(
  files: Record<string, string>,
  directories: readonly string[] = [],
  realpaths: Readonly<Record<string, string>> = {},
) {
  const fileMap = new Map(Object.entries(files));
  const directorySet = new Set(directories);
  return {
    readFile: (path: string): string | null => fileMap.get(path) ?? null,
    isFile: (path: string): boolean => fileMap.has(path),
    isDirectory: (path: string): boolean => directorySet.has(path),
    realpath: (path: string): string => realpaths[path] ?? path,
  };
}

function fileFormat(source: string): string | null {
  const ambiguous = join(appDir, "ambiguous.js");
  const builder = new NpmGraphBuilder(hostOf({ [ambiguous]: source }));
  const key = builder.addFileImport(mainFile, "./ambiguous.js");
  expect(key).not.toBeNull();
  return builder.moduleFormatOf(key!);
}

describe("Node 24 ambiguous-module classification", () => {
  test.each([
    "await using resource = null;",
    "if (true) { await using resource = null; }",
  ])("top-level await-using syntax is ESM: %s", (source) => {
    expect(fileFormat(source)).toBe("esm");
  });

  test("top-level await in a computed method name is ESM", () => {
    expect(
      fileFormat('const value = { [await Promise.resolve("x")]() {} };'),
    ).toBe("esm");
  });

  test("a CommonJS for-of target named await stays CommonJS", () => {
    expect(fileFormat("var await; for (await of []);")).toBe("cjs");
  });

  test("Node 24 source-phase import syntax is ESM", () => {
    expect(fileFormat('import source wasm from "./module.wasm";')).toBe("esm");
  });

  test.each([
    'const loader = { import: { source(value) { return value; } } }; loader.import.source("ok");',
    'const pattern = /import source wasm from "module"/;',
  ])("valid CommonJS is not mistaken for a source-phase import: %s", (source) => {
    const ambiguous = join(appDir, "ambiguous.js");
    const builder = new NpmGraphBuilder(hostOf({ [ambiguous]: source }));
    const key = builder.addFileImport(mainFile, "./ambiguous.js");
    expect(key).not.toBeNull();
    expect(builder.moduleFormatOf(key!)).toBe("cjs");
    expect(builder.finish().errors).toEqual([]);
  });

  test.each(["wasm", "from", "as", "type", "module"])(
    "source-phase binding '%s' fails explicitly instead of leaving an incomplete graph",
    (binding) => {
      const packageDir = join(appDir, "node_modules", "sourcepkg");
      const packageJson = join(packageDir, "package.json");
      const entry = join(packageDir, "index.js");
      const builder = new NpmGraphBuilder(
        hostOf(
          {
            [packageJson]: JSON.stringify({
              name: "sourcepkg",
              type: "module",
              exports: "./index.js",
            }),
            [entry]: `import source ${binding} from "./module.wasm";`,
          },
          [packageDir],
        ),
      );

      builder.addImport(mainFile, "sourcepkg");
      expect(builder.finish().errors).toEqual([
        {
          message:
            `package 'sourcepkg' uses unsupported Node source-phase import './module.wasm' in ${entry} ` +
            `(the embedded engine has no source-phase/WebAssembly module implementation; ` +
            `dependency chain: sourcepkg)`,
        },
      ]);
    },
  );

  test("dynamic source-phase imports fail explicitly instead of reaching the embedded parser", () => {
    const packageDir = join(appDir, "node_modules", "dynamic-sourcepkg");
    const packageJson = join(packageDir, "package.json");
    const entry = join(packageDir, "index.js");
    const builder = new NpmGraphBuilder(
      hostOf(
        {
          [packageJson]: JSON.stringify({
            name: "dynamic-sourcepkg",
            type: "module",
            exports: "./index.js",
          }),
          [entry]:
            'export function load() { return import.source("./module.wasm"); }',
        },
        [packageDir],
      ),
    );

    builder.addImport(mainFile, "dynamic-sourcepkg");
    expect(builder.finish().errors).toEqual([
      {
        message:
          `package 'dynamic-sourcepkg' uses unsupported Node dynamic source-phase import ` +
          `'./module.wasm' in ${entry} (the embedded engine has no source-phase/WebAssembly ` +
          `module implementation; dependency chain: dynamic-sourcepkg)`,
      },
    ]);
  });

  test("an outer package type does not cross a node_modules boundary", () => {
    const packageJson = join(appDir, "package.json");
    const entry = join(appDir, "node_modules", "unscoped", "index.js");
    const files = {
      [packageJson]: JSON.stringify({ type: "module" }),
      [entry]: "module.exports = 1;",
    };
    const builder = new NpmGraphBuilder(hostOf(files));
    const key = builder.addFileImport(
      mainFile,
      "./node_modules/unscoped/index.js",
    );
    expect(key).not.toBeNull();
    expect(builder.moduleFormatOf(key!)).toBe("cjs");
  });
});

describe("Node 24 typeless-package warnings", () => {
  test("a syntax-detected workspace .js carries Node's runtime warning", () => {
    const workspaceDir = join(appDir, "workspace", "typeless");
    const packageJson = join(workspaceDir, "package.json");
    const entry = join(workspaceDir, "index.js");
    const builder = new NpmGraphBuilder(
      hostOf({
        [packageJson]: JSON.stringify({ name: "typeless" }),
        [entry]: "export const value = 42;",
      }),
    );

    expect(builder.addFileImport(mainFile, "./workspace/typeless/index.js")).toBe(entry);
    expect(builder.finish().modules).toContainEqual({
      key: entry,
      source: "export const value = 42;",
      format: "esm",
      typelessPackageJson: packageJson,
      typelessWarning:
        `Module type of ${pathToFileURL(entry).href} is not specified and it doesn't parse as CommonJS.\n` +
        `Reparsing as ES module because module syntax was detected. This incurs a performance overhead.\n` +
        `To eliminate this warning, add "type": "module" to ${packageJson}.`,
    });
  });

  test("the same typeless source is silent at a physical node_modules path", () => {
    const packageDir = join(appDir, "node_modules", "typeless");
    const packageJson = join(packageDir, "package.json");
    const entry = join(packageDir, "index.js");
    const builder = new NpmGraphBuilder(
      hostOf({
        [packageJson]: JSON.stringify({ name: "typeless" }),
        [entry]: "export const value = 42;",
      }),
    );

    expect(builder.addFileImport(mainFile, "./node_modules/typeless/index.js")).toBe(entry);
    expect(builder.finish().modules).toEqual([
      {
        key: entry,
        source: "export const value = 42;",
        format: "esm",
      },
    ]);
  });
});

describe("module-field format overrides", () => {
  const packageDir = join(appDir, "node_modules", "pkg");
  const packageJson = join(packageDir, "package.json");
  const moduleEntry = join(packageDir, "index.js");
  const mainEntry = join(packageDir, "index.cjs");
  const files = {
    [packageJson]: JSON.stringify({
      name: "pkg",
      module: "./index.js",
      main: "./index.cjs",
    }),
    [moduleEntry]: "globalThis.loaded = true;",
    [mainEntry]: "module.exports = true;",
  };
  const directories = [packageDir];

  test("a late bare import refreshes an entry first reached as a file", () => {
    const builder = new NpmGraphBuilder(hostOf(files, directories));
    expect(
      builder.addFileImport(mainFile, "./node_modules/pkg/index.js"),
    ).toBe(moduleEntry);
    expect(builder.moduleFormatOf(moduleEntry)).toBe("cjs");

    builder.addImport(mainFile, "pkg");
    expect(builder.moduleFormatOf(moduleEntry)).toBe("esm");
  });

  test("the final format is independent of discovery order", () => {
    const builder = new NpmGraphBuilder(hostOf(files, directories));
    builder.addImport(mainFile, "pkg");
    expect(
      builder.addFileImport(mainFile, "./node_modules/pkg/index.js"),
    ).toBe(moduleEntry);
    expect(builder.moduleFormatOf(moduleEntry)).toBe("esm");
  });

  test("a late module-field override clears syntax-detection warning metadata", () => {
    const workspaceDir = join(appDir, "workspace", "pkg");
    const workspacePackageJson = join(workspaceDir, "package.json");
    const workspaceEntry = join(workspaceDir, "index.js");
    const linkedDir = join(appDir, "node_modules", "pkg");
    const linkedEntry = join(linkedDir, "index.js");
    const source = "export const value = 1;";
    const workspaceFiles = {
      [workspacePackageJson]: JSON.stringify({
        name: "pkg",
        module: "./index.js",
      }),
      [workspaceEntry]: source,
      [linkedEntry]: source,
    };
    const realpaths = {
      [linkedDir]: workspaceDir,
      [linkedEntry]: workspaceEntry,
    };

    const fileFirst = new NpmGraphBuilder(
      hostOf(workspaceFiles, [linkedDir], realpaths),
    );
    fileFirst.addFileImport(mainFile, "./node_modules/pkg/index.js");
    fileFirst.addImport(mainFile, "pkg");

    const bareFirst = new NpmGraphBuilder(
      hostOf(workspaceFiles, [linkedDir], realpaths),
    );
    bareFirst.addImport(mainFile, "pkg");
    bareFirst.addFileImport(mainFile, "./node_modules/pkg/index.js");

    const fileFirstModules = fileFirst.finish().modules;
    expect(fileFirstModules).toEqual(bareFirst.finish().modules);
    expect(fileFirstModules).toEqual([
      {
        key: workspaceEntry,
        source,
        format: "esm",
      },
    ]);
  });
});
