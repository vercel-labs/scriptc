import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  npmStaticFsShadow,
  npmStaticIneligibleReason,
  npmStaticTransformPkgJson,
  setNpmStaticPackages,
} from "./npm-static.js";
import type { FrontendServices } from "./services.js";

test("an unreadable runtime entry is an eligibility refusal", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-unreadable-");
  try {
    const root = join(dir, "node_modules", "example");
    expect(npmStaticIneligibleReason("example", `${root}/index.d.ts`, `${root}/index.js`)).toBe(
      `its runtime entry ${root}/index.js cannot be read`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hoisted node condition leaves no types claim behind", () => {
  // uuid 14: the node object carries its own "types" key. Left in place,
  // tsgo maps the hidden declaration to its same-stem browser build.
  const pkg: Record<string, unknown> = {
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        node: { types: "./dist/index.d.ts", default: "./dist-node/index.js" },
        default: "./dist/index.js",
      },
      "./package.json": "./package.json",
    },
  };
  npmStaticTransformPkgJson(pkg);
  expect(pkg).toEqual({
    exports: {
      ".": { default: "./dist-node/index.js" },
      "./package.json": "./package.json",
    },
  });
});

test("the shadow leaves a package that is not opted in as it is", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-shadow-");
  try {
    const hidden = join(dir, "node_modules", "hiddenlang");
    await mkdir(join(hidden, "lib", "languages"), { recursive: true });
    await mkdir(join(hidden, "types"), { recursive: true });
    const manifest = join(hidden, "package.json");
    await writeFile(
      manifest,
      '{"name":"hiddenlang","types":"types/index.d.ts","main":"lib/core.js"}',
    );
    // highlight.js 10 ships ONE package .d.ts and types the language
    // subpaths from an ambient block inside it. That block answers a
    // specifier only while the JavaScript file itself stays out of the
    // program, which it does: no file of a package that is not opted in is
    // a program root.
    const declarations = join(hidden, "types", "index.d.ts");
    await writeFile(
      declarations,
      'declare module "hiddenlang/lib/languages/*" { export default function(hljs?: Api): Lang; }\n',
    );
    const core = join(hidden, "lib", "core.js");
    await writeFile(core, "module.exports = { register() {} };\n");
    const php = join(hidden, "lib", "languages", "php.js");
    await writeFile(
      php,
      "/** @param {Api} hljs */\nfunction php(hljs) { return {}; }\nmodule.exports = php;\n",
    );
    // An ES module package, the same way.
    const esm = join(dir, "node_modules", "esmkit");
    await mkdir(join(esm, "lib"), { recursive: true });
    await writeFile(
      join(esm, "package.json"),
      '{"name":"esmkit","type":"module","types":"index.d.ts","main":"lib/core.js"}',
    );
    const esmCore = join(esm, "lib", "core.js");
    await writeFile(esmCore, "export function register() {}\n");
    setNpmStaticPackages(["opted"]);
    try {
      const shadow = npmStaticFsShadow({} as FrontendServices)!;
      for (const file of [php, core, manifest, declarations, esmCore]) {
        expect(shadow.readFile(file)).toBeUndefined();
        expect(shadow.hideFile(file)).toBe(false);
      }
    } finally {
      setNpmStaticPackages([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an island package is typed by its declarations, not by its JavaScript", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-shadow-island-");
  try {
    const island = join(dir, "node_modules", "islandlang");
    await mkdir(join(island, "lib", "languages"), { recursive: true });
    await mkdir(join(island, "types"), { recursive: true });
    await writeFile(
      join(island, "package.json"),
      '{"name":"islandlang","types":"types/index.d.ts","main":"lib/core.js"}',
    );
    await writeFile(
      join(island, "types", "index.d.ts"),
      'declare module "islandlang/lib/languages/*" { export default function(hljs?: Api): Lang; }\n',
    );
    const php = join(island, "lib", "languages", "php.js");
    await writeFile(php, "/** @param {Api} hljs */\nmodule.exports = function php(hljs) {};\n");
    const { setFrontendIslands } = await import("../node-islands/boundary.js");
    // The island package is opted in (its declaration entry types the
    // program) but its bodies run in Node: inference would only add the
    // declared/inferred mix, so its undeclared subpath keeps the implicit-any
    // surface.
    setNpmStaticPackages(["islandlang"]);
    setFrontendIslands(new Set(["islandlang"]));
    try {
      expect(npmStaticFsShadow({} as FrontendServices)!.readFile(php)).toContain(
        "module.exports = (() => { let u; return u; })();",
      );
    } finally {
      setFrontendIslands(new Set());
      setNpmStaticPackages([]);
    }
    // A package that is NOT judged an island keeps its inferred JavaScript.
    setNpmStaticPackages(["islandlang"]);
    try {
      expect(npmStaticFsShadow({} as FrontendServices)!.readFile(php)).toBeUndefined();
    } finally {
      setNpmStaticPackages([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
