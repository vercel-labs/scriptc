import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  npmStaticFsShadow,
  npmStaticIneligibleReason,
  npmStaticTransformPkgJson,
  setNpmStaticPackages,
} from "./npm-static.js";
import type { FrontendServices } from "./services.js";
import { closeSourceParser, parseSourceFile } from "./ts7/source-parser-node.js";

afterAll(closeSourceParser);

/** The parser half of FrontendServices the shadow's declaration reading uses. */
function testServices(): FrontendServices {
  return { parse: parseSourceFile } as unknown as FrontendServices;
}

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

test("a typed package's ambient-declared subpath is typed from the declaration", async () => {
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
    // specifier the resolver answered with the JavaScript file itself, so the
    // declaration's optional `hljs` meets the source's required one
    // (a program-level SC0001 no package caused) unless the declared type is
    // projected onto the file.
    await writeFile(
      join(hidden, "types", "index.d.ts"),
      [
        "type Api = { register(name: string, fn: LanguageFn): void };",
        "type Lang = { name: string };",
        "type LanguageDetail = Lang & { extra: number };",
        "type LanguageFn = (api?: Api) => Lang;",
        'declare module "hiddenlang/lib/languages/*" { export default function(hljs?: Api): LanguageDetail; }',
        "",
      ].join("\n"),
    );
    await writeFile(join(hidden, "lib", "core.js"), "module.exports = { register() {} };\n");
    const php = join(hidden, "lib", "languages", "php.js");
    const phpText =
      "/** @param {Api} hljs */\nfunction php(hljs) { return { name: 'php' }; }\nmodule.exports = php;\n";
    await writeFile(php, phpText);
    setNpmStaticPackages(["opted"]);
    try {
      const shadow = npmStaticFsShadow(testServices())!;
      // The body, its offsets and every other byte survive: only the
      // declared export type is added.
      expect(shadow.readFile(php)).toBe(
        phpText.replace(
          "module.exports = php;",
          "module.exports = /** @type {(hljs?: Api) => LanguageDetail} */ (php);",
        ),
      );
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

test("an unspellable declared type keeps the flagless any surface", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-shadow-unspellable-");
  try {
    const pkg = join(dir, "node_modules", "modtypes");
    await mkdir(join(pkg, "lib"), { recursive: true });
    await mkdir(join(pkg, "types"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      '{"name":"modtypes","types":"types/index.d.ts","main":"lib/core.js"}',
    );
    // A MODULE declaration file: the names its blocks use are not globals,
    // so the type cannot be spelled in the JavaScript.
    await writeFile(
      join(pkg, "types", "index.d.ts"),
      'export interface Api { register(fn: LanguageFn): void }\nimport type { LanguageFn } from "./lang.js";\ndeclare module "modtypes/lib/*" { export default function(hljs?: Api): Api; }\n',
    );
    const thing = join(pkg, "lib", "thing.js");
    await writeFile(thing, "function fn(hljs) { return {}; }\nmodule.exports = fn;\n");
    setNpmStaticPackages(["opted"]);
    try {
      expect(npmStaticFsShadow(testServices())!.readFile(thing)).toContain(
        "module.exports = (() => { let u; return u; })();",
      );
    } finally {
      setNpmStaticPackages([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an augmentation in a module declaration file is never projected", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-shadow-module-");
  try {
    // Both entries are MODULES without an import or export STATEMENT: one
    // exports an interface, the other has an import-equals. A global-script
    // test that looks for import/export statements only misses both, and the
    // ambient block's `Api` — module-local, or an augmentation of a module
    // this package never loads at that specifier — lands in the JavaScript's
    // unrelated global scope.
    const exported = join(dir, "node_modules", "exportonly");
    await mkdir(join(exported, "lib"), { recursive: true });
    await mkdir(join(exported, "types"), { recursive: true });
    await writeFile(
      join(exported, "package.json"),
      '{"name":"exportonly","types":"types/index.d.ts","main":"lib/core.js"}',
    );
    await writeFile(
      join(exported, "types", "index.d.ts"),
      'export interface Api { register(name: string): void }\ndeclare module "exportonly/lib/*" { export default function(api?: Api): Api; }\n',
    );
    const exportedFile = join(exported, "lib", "thing.js");
    await writeFile(exportedFile, "function fn(api) { return api; }\nmodule.exports = fn;\n");
    const required = join(dir, "node_modules", "importeq");
    await mkdir(join(required, "lib"), { recursive: true });
    await mkdir(join(required, "types"), { recursive: true });
    await writeFile(
      join(required, "package.json"),
      '{"name":"importeq","types":"types/index.d.ts","main":"lib/core.js"}',
    );
    await writeFile(
      join(required, "types", "index.d.ts"),
      'declare class Api { register(name: string): void }\nimport helper = require("./helper.js");\ndeclare module "importeq/lib/*" { export default function(api?: Api): Api; }\n',
    );
    const requiredFile = join(required, "lib", "thing.js");
    await writeFile(requiredFile, "function fn(api) { return api; }\nmodule.exports = fn;\n");
    setNpmStaticPackages(["opted"]);
    try {
      const shadow = npmStaticFsShadow(testServices())!;
      // Both files keep the implicit-any surface the flag gives an
      // unprojected file; neither carries the module-local `Api`.
      for (const file of [exportedFile, requiredFile]) {
        expect(shadow.readFile(file)).toBe("module.exports = (() => { let u; return u; })();\n");
      }
    } finally {
      setNpmStaticPackages([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every declared overload of an ambient default export is projected", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-shadow-overloads-");
  try {
    const pkg = join(dir, "node_modules", "overloaded");
    await mkdir(join(pkg, "lib"), { recursive: true });
    await mkdir(join(pkg, "types"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      '{"name":"overloaded","types":"types/index.d.ts","main":"lib/core.js"}',
    );
    // The declaration accepts a call with the language name and one without
    // it. Projecting only the first signature made the two-argument form a
    // program type error, which the package could do nothing about.
    await writeFile(
      join(pkg, "types", "index.d.ts"),
      [
        "type Api = { register(name: string, fn: LanguageFn): void };",
        "type Lang = { name: string };",
        "type LanguageDetail = Lang & { extra: number };",
        "type LanguageFn = (api?: Api) => Lang;",
        'declare module "overloaded/lib/*" {',
        "  export default function(hljs?: Api): LanguageDetail;",
        "  export default function(hljs: Api, name: string): LanguageDetail;",
        "}",
        "",
      ].join("\n"),
    );
    const lang = join(pkg, "lib", "lang.js");
    const langText =
      "/** @param {Api} hljs */\nfunction lang(hljs, name) { return { name: name ?? 'php' }; }\nmodule.exports = lang;\n";
    await writeFile(lang, langText);
    setNpmStaticPackages(["opted"]);
    try {
      expect(npmStaticFsShadow(testServices())!.readFile(lang)).toBe(
        langText.replace(
          "module.exports = lang;",
          "module.exports = /** @type {((hljs?: Api) => LanguageDetail) & ((hljs: Api, name: string) => LanguageDetail)} */ (lang);",
        ),
      );
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
      [
        "type Api = { register(name: string): void };",
        "type Lang = { name: string };",
        'declare module "islandlang/lib/languages/*" { export default function(hljs?: Api): Lang; }',
        "",
      ].join("\n"),
    );
    const php = join(island, "lib", "languages", "php.js");
    await writeFile(
      php,
      "/** @param {Api} hljs */\nfunction php(hljs) { return {}; }\nmodule.exports = php;\n",
    );
    const { setFrontendIslands } = await import("../node-islands/boundary.js");
    // The island package is opted in (its declaration entry types the
    // program) but its bodies run in Node: inference would only add the
    // declared/inferred mix, so its undeclared subpath keeps the implicit-any
    // surface.
    setNpmStaticPackages(["islandlang"]);
    setFrontendIslands(new Set(["islandlang"]));
    try {
      // Opted in, its declaration entry is hidden from the program, so the
      // declared type names nothing and the subpath keeps the implicit-any
      // surface.
      expect(npmStaticFsShadow(testServices())!.readFile(php)).toContain(
        "module.exports = (() => { let u; return u; })();",
      );
    } finally {
      setFrontendIslands(new Set());
      setNpmStaticPackages([]);
    }
    // A package that is NOT judged an island keeps its inferred JavaScript.
    setNpmStaticPackages(["islandlang"]);
    try {
      expect(npmStaticFsShadow(testServices())!.readFile(php)).toBeUndefined();
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
      expect(npmStaticFsShadow(testServices())!.readFile(core)).toBeUndefined();
    } finally {
      setNpmStaticPackages([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
