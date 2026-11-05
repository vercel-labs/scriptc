import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  fallbackDtsPath,
  fallbackModulePath,
  fallbackModulesNamedIn,
} from "../src/frontend/dts-paths.js";

const moduleDirectory = join(dirname(fallbackDtsPath()), "node-fallback");
const declaredModules = (text: string): string[] =>
  [...text.matchAll(/^declare module "([^"]+)" \{/gm)].map((m) => m[1]!);

test("every fallback module file declares the specifiers that map to it, and only those", () => {
  const files = readdirSync(moduleDirectory).filter((name) => name.endsWith(".d.ts"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(join(moduleDirectory, file), "utf8");
    const declared = declaredModules(text);
    expect(declared.length, file).toBeGreaterThan(0);
    for (const specifier of declared) expect(basename(fallbackModulePath(specifier)!)).toBe(file);
    // Every reference names another module file.
    for (const [, reference] of text.matchAll(/^\/\/\/ <reference path="\.\/([^"]+)" \/>$/gm))
      expect(existsSync(join(moduleDirectory, reference!)), `${file} -> ${reference}`).toBe(true);
  }
});

test("the core fallback file declares no module that has a file of its own", () => {
  for (const specifier of declaredModules(readFileSync(fallbackDtsPath(), "utf8")))
    expect(fallbackModulePath(specifier), specifier).toBeNull();
});

test("a module named in a string literal selects its file, under either spelling", () => {
  const files = fallbackModulesNamedIn(
    `import { readFileSync } from "node:fs";\nconst os = require('os');\ntype T = import(\`node:stream/web\`);\nconst label = "not-a-module";`,
  ).map((file) => basename(file));
  expect(files.sort()).toEqual(["fs.d.ts", "os.d.ts", "stream-web.d.ts"]);
  expect(fallbackModulesNamedIn('console.log("hi")')).toEqual([]);
  // Module names with digits.
  expect(
    fallbackModulesNamedIn(`require("http2"); import("node:v8");`).map((file) => basename(file)),
  ).toEqual(["http2.d.ts", "v8.d.ts"]);
});
