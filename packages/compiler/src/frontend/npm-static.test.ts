import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setFrontendIslands } from "../node-islands/boundary.js";
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

test("a typed island package's shipped JS never reaches the checker under --npm-static", async () => {
  // The flag's maxNodeModuleJsDepth admits node_modules JS the flagless build
  // never types, and a real file SHADOWS the ambient `declare module`
  // declarations that type an island (highlight.js: lib/core.js typed by
  // JSDoc instead of types/index.d.ts, which cascades into the importing
  // program). A TYPED island's declarations are its whole surface, so its
  // runtime files stay out; declarations stay in. An UNTYPED island has no
  // declaration to shadow and keeps the any-surface stub.
  const dir = await mkdtemp("/tmp/scriptc-npm-static-island-");
  try {
    const typed = join(dir, "node_modules", "islanded");
    const untyped = join(dir, "node_modules", "plainisl");
    await mkdir(join(typed, "lib"), { recursive: true });
    await mkdir(join(typed, "types"), { recursive: true });
    await mkdir(join(untyped, "lib"), { recursive: true });
    await writeFile(
      join(typed, "package.json"),
      JSON.stringify({ name: "islanded", types: "./types/index.d.ts" }),
    );
    await writeFile(join(typed, "lib", "core.js"), "module.exports = {};\n");
    await writeFile(join(typed, "types", "index.d.ts"), "declare const x: {}; export = x;\n");
    await writeFile(join(untyped, "package.json"), JSON.stringify({ name: "plainisl" }));
    await writeFile(join(untyped, "lib", "core.js"), "module.exports = {};\n");
    // The load keeps islands OUT of the flag's name list; the shadow's island
    // rule is what keeps their JS out of the checker.
    setNpmStaticPackages(["opted"]);
    setFrontendIslands(new Set(["islanded", "plainisl"]));
    const shadow = npmStaticFsShadow({} as FrontendServices);
    expect(shadow).not.toBeNull();
    const hide = shadow === null ? null : shadow.hideFile;
    expect(hide?.(`${typed}/lib/core.js`)).toBe(true);
    expect(hide?.(`${dir.replaceAll("/", "\\")}\\node_modules\\islanded\\index.cjs`)).toBe(true);
    // The declarations are what types the island: they stay.
    expect(hide?.(`${typed}/types/index.d.ts`)).toBe(false);
    // An untyped island keeps the shadow's existing any-surface stub.
    expect(hide?.(`${untyped}/lib/core.js`)).toBe(false);
    // A package that is not an island keeps the ordinary shadow rules.
    expect(hide?.(join(dir, "node_modules", "opted", "lib", "core.js"))).toBe(false);
    // Files outside node_modules are untouched by the island rule.
    expect(hide?.(join(dir, "src", "islanded.js"))).toBe(false);
  } finally {
    setFrontendIslands(new Set());
    setNpmStaticPackages([]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a typed package's undeclared subpath keeps the flagless any surface", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-shadow-");
  try {
    const hidden = join(dir, "node_modules", "hiddenlang");
    await mkdir(join(hidden, "lib", "languages"), { recursive: true });
    await mkdir(join(hidden, "types"), { recursive: true });
    await writeFile(
      join(hidden, "package.json"),
      '{"name":"hiddenlang","types":"types/index.d.ts","main":"lib/core.js"}',
    );
    // highlight.js 10 ships ONE package .d.ts and types the language
    // subpaths from an ambient block inside it. That block never answers a
    // specifier the resolver answered with the JavaScript file itself.
    await writeFile(
      join(hidden, "types", "index.d.ts"),
      'declare module "hiddenlang/lib/languages/*" { export default function(hljs?: Api): Lang; }\n',
    );
    await writeFile(join(hidden, "lib", "core.js"), "module.exports = { register() {} };\n");
    const php = join(hidden, "lib", "languages", "php.js");
    await writeFile(
      php,
      "/** @param {Api} hljs */\nfunction php(hljs) { return {}; }\nmodule.exports = php;\n",
    );
    setNpmStaticPackages(["opted"]);
    try {
      const shadow = npmStaticFsShadow({} as FrontendServices)!;
      // Inferred, the JSDoc-required `hljs` disagrees with the declaration's
      // optional one — a program-level SC0001 no package caused. The
      // flagless build never types this file, so the import is `any`.
      expect(shadow.readFile(php)).toContain("module.exports = (() => { let u; return u; })();");
      // A sibling declaration types this very file: it keeps its own text.
      await writeFile(
        join(hidden, "lib", "core.d.ts"),
        "export declare function register(): void;\n",
      );
      expect(shadow.readFile(join(hidden, "lib", "core.js"))).toBeUndefined();
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

test("an ES module package's JavaScript keeps its own text", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-shadow-esm-");
  try {
    const esm = join(dir, "node_modules", "esmkit");
    await mkdir(join(esm, "lib"), { recursive: true });
    await writeFile(
      join(esm, "package.json"),
      '{"name":"esmkit","type":"module","types":"index.d.ts","main":"lib/core.js"}',
    );
    await writeFile(join(esm, "index.d.ts"), "export declare function register(): void;\n");
    const core = join(esm, "lib", "core.js");
    await writeFile(core, "export function register() {}\n");
    setNpmStaticPackages(["opted"]);
    try {
      // The any-surface stub is CommonJS-shaped, so an ES module file must
      // keep its text: a stubbed `module.exports` would erase its exports.
      expect(npmStaticFsShadow({} as FrontendServices)!.readFile(core)).toBeUndefined();
    } finally {
      setNpmStaticPackages([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
