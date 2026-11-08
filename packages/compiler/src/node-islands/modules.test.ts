import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { clearVirtualSources, setVirtualSource } from "../frontend/input-tracker.js";
import {
  ModuleSpecifierScans,
  NodeIslandModuleCollector,
  namedDataPaths,
  nodeIslandManifest,
  readNodeIslandModules,
  requireModuleSpecifiers,
  scanModuleSpecifiers,
} from "./modules.js";

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-island-modules-")));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("data paths a module names", () => {
  test("string literals, and consecutive literal arguments joined", () => {
    const names = namedDataPaths(`
      const a = readFileSync(join(here, "fallback", "payload.txt"));
      const b = "assets/config.json";
      const c = resolve(__dirname, "x", base, "y");
      // "comment.txt"
      const d = \`\${dir}/template.txt\`;
    `);
    expect([...names.keys()].sort()).toEqual([
      "assets/config.json",
      "fallback",
      "fallback/payload.txt",
      "payload.txt",
      "x",
      "y",
    ]);
  });
});

describe("module specifiers in JavaScript", () => {
  test("string-literal loads in every form", () => {
    const scan = scanModuleSpecifiers(`
      const a = require("./a");
      const b = require.resolve('./b.json');
      import c from "c";
      import * as d from "d/sub";
      import { e } from "./e.mjs";
      import "./side";
      export * from "./f";
      export { g } from "./g";
      const h = await import("./h.js");
      const require2 = createRequire(import.meta.url);
      const j = require2("./j.cjs");
      const k = require2.resolve("k");
      const i = import.meta.resolve("i");
      import.meta.url;
      obj.require("x");
      const t = \`\${require("./t")}\`;
    `);
    expect(scan.specifiers).toEqual([
      "./a",
      "./b.json",
      "c",
      "d/sub",
      "./e.mjs",
      "./side",
      "./f",
      "./g",
      "./h.js",
      "./j.cjs",
      "k",
      "i",
      "./t",
    ]);
    expect(scan.computed).toEqual([]);
  });

  test("comments, strings and regular expressions hide nothing and invent nothing", () => {
    const scan = scanModuleSpecifiers(`
      // require("./commented")
      /* import x from "./block" */
      const s = "require('./in-string')";
      const r = /require\\("\\.\\/in-regex"\\)/g;
      const q = a / b / c;
      const real = require("./real");
    `);
    expect(scan.specifiers).toEqual(["./real"]);
    expect(scan.computed).toEqual([]);
  });

  test("a program module's syntactically bounded loads name every value", () => {
    expect(
      scanModuleSpecifiers(
        `
        const flag = Math.random() > 0.5;
        require(flag ? "./c.js" : "./d.js");
        require("./a/" + "x.js");
        require(("./b" + ".js"));
        require(("./x" + ".js") || "./g.js");
        require(("." + "/h.js") ?? "./i.js");
      `,
        undefined,
        { bounds: true },
      ),
    ).toEqual({
      specifiers: [
        "./c.js",
        "./d.js",
        "./a/x.js",
        "./b.js",
        "./x.js",
        "./g.js",
        "./h.js",
        "./i.js",
      ],
      computed: [],
    });
  });

  test("a bounded scan still reports the loads it cannot bound", () => {
    const forms = (text: string) =>
      scanModuleSpecifiers(text, undefined, { bounds: true }).computed.map((c) => c.form);
    expect(forms("require('./a/' + name)")).toEqual(["require() with a computed specifier"]);
    expect(forms("import(`./x/${y}`)")).toEqual(["import() with a computed specifier"]);
    expect(forms("require(flag ? './a.js' : name)")).toEqual([
      "require() with a computed specifier",
    ]);
    // The scan reads literals only: a bound the frontend's const analysis
    // proves (a `process.env` branch, a no-span template) is not one here.
    expect(forms("require(process.env.SCRIPTC_M ?? './e.js')")).toEqual([
      "require() with a computed specifier",
    ]);
    expect(forms("require(`./g.js`)")).toEqual(["require() with a computed specifier"]);
    // `+` binds tighter than `||`, so this concatenates the union as a whole:
    // no flat chain names its values (parenthesized, it would bound).
    expect(forms("require('./a.js' || './b' + '.js')")).toEqual([
      "require() with a computed specifier",
    ]);
    expect(
      scanModuleSpecifiers("require(('./a.js' || './b') + '.js')", undefined, { bounds: true }),
    ).toEqual({
      specifiers: ["./a.js.js", "./b.js"],
      computed: [],
    });
  });

  test("without bounds a computed load is neither bound nor traced", () => {
    expect(scanModuleSpecifiers('require("./a/" + "x.js")')).toEqual({
      specifiers: [],
      computed: [{ at: 0, form: "require() with a computed specifier" }],
    });
  });

  test("type-only import and export declarations name no runtime module", () => {
    const text = `
      import type { A } from "./a.ts";
      import type B from "./b.ts";
      import type * as c from "./c.ts";
      import type d = require("./d.ts");
      export type { E } from "./e.ts";
      export type * from "./f.ts";
      import type from "./value.ts";
      import type, { K } from "./value2.ts";
      import { type G, h } from "./g.ts";
      import { type I } from "./i.ts";
      export { type J } from "./j.ts";
    `;
    // Node's type stripper erases `import type` / `export type` whole. The
    // `type` modifier inside a value import's or export's name list keeps
    // its statement, which loads the module.
    expect(scanModuleSpecifiers(text).specifiers).toEqual([
      "./value.ts",
      "./value2.ts",
      "./g.ts",
      "./i.ts",
      "./j.ts",
    ]);
    expect(scanModuleSpecifiers(text).computed).toEqual([]);
  });

  test("computed loads are reported", () => {
    const forms = (text: string) => scanModuleSpecifiers(text).computed.map((c) => c.form);
    expect(forms("require(name)")).toEqual(["require() with a computed specifier"]);
    expect(forms("require('./a' + b)")).toEqual(["require() with a computed specifier"]);
    expect(forms("import(`./x/${y}`)")).toEqual(["import() with a computed specifier"]);
    expect(forms("import.meta.resolve(name)")).toEqual([
      "import.meta.resolve() with a computed specifier",
    ]);
    expect(forms("const r = require; r('./a')")).toEqual(["require as a value"]);
    expect(forms("createRequire(import.meta.url)('./a')")).toEqual([
      "a require() from createRequire()",
    ]);
    expect(forms("const req = createRequire(import.meta.url); req(name)")).toEqual([
      "require() with a computed specifier",
    ]);
    expect(forms("const req = createRequire(import.meta.url); use(req)")).toEqual([
      "require as a value",
    ]);
    expect(forms("function require(x) {} typeof require")).toEqual([]);
  });

  test("a shared scan answers for the text it was scanned from, and no other", () => {
    const scans = new ModuleSpecifierScans();
    const first = scans.of("/pkg/index.js", 'require("zoo");');
    expect(first.specifiers).toEqual(["zoo"]);
    // The same file with the same text is not scanned again.
    expect(scans.of("/pkg/index.js", 'require("zoo");')).toBe(first);
    // The file's text changed: the answer is the new text's.
    expect(scans.of("/pkg/index.js", 'require("yak");').specifiers).toEqual(["yak"]);
    // Another file with the first text has an answer of its own.
    expect(scans.of("/pkg/other.js", 'require("zoo");').specifiers).toEqual(["zoo"]);
  });
});

describe("the collected module tree", () => {
  test("a relative module and what it loads; missing modules are not shipped", () => {
    const root = project({
      "src/main.ts": "",
      "src/math.cjs":
        "module.exports = require('./util');\ntry { require('./optional'); } catch {}",
      "src/util.js": "exports.x = require('../data.json');",
      "data.json": "{}",
      "src/unused.js": "",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./math.cjs")).toBeNull();
    expect(collector.add(join(root, "src/main.ts"), "./does-not-exist.cjs")).toBeNull();
    expect(collector.add(join(root, "src/main.ts"), "node:fs")).toBeNull();
    const tree = collector.tree()!;
    expect(tree.root).toBe(root);
    expect(tree.files.map((f) => f.path)).toEqual(["data.json", "src/math.cjs", "src/util.js"]);
    expect(NodeIslandModuleCollector.callerPath(tree, join(root, "src/main.ts"))).toBe(
      "src/main.ts",
    );
  });

  test("a module of the program ships with the package.json that scopes it", () => {
    const root = project({
      "package.json": JSON.stringify({ type: "module" }),
      "src/main.ts": "",
      "src/esm.js": "export const x = 1;",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./esm.js")).toBeNull();
    expect(collector.tree()!.files.map((f) => f.path)).toEqual(["package.json", "src/esm.js"]);
  });

  test("a computed load in a module of the program is refused", () => {
    const root = project({ "main.ts": "", "dyn.cjs": "module.exports = require(process.env.X);" });
    const problem = new NodeIslandModuleCollector().add(join(root, "main.ts"), "./dyn.cjs");
    expect(problem).toBe(
      `${join(root, "dyn.cjs")}:1 loads a module through require() with a computed specifier; a module that runs in a Node island loads modules by string-literal specifiers only`,
    );
  });

  // Node's type stripping erases a `import type`/`export type` clause whole, so
  // the module it names never loads, while `import { type I } from "./i.ts"`
  // keeps its statement and does load the module for its side effects.
  test("a type-only clause loads nothing, and a default binding named type does", () => {
    const scan = scanModuleSpecifiers(`
      import type { A } from "./a.ts";
      import type B from "./b.ts";
      import type * as C from "./c.ts";
      export type { D } from "./d.ts";
      export type * from "./e.ts";
      import type F = require("./f.ts");
      import type from "./g.ts";
      import type, { H } from "./h.ts";
      import { type I } from "./i.ts";
    `);
    expect(scan.specifiers).toEqual(["./g.ts", "./h.ts", "./i.ts"]);
    expect(scan.computed).toEqual([]);
  });

  // Without a `;` the clause ends where the next statement begins, and the
  // runtime loads after it still load: an exported type alias or a type-only
  // import-equals must not swallow them, nor a type-only import written
  // across lines lose the specifier it names.
  test("a semicolonless type-only clause ends at the next statement", () => {
    const scan = scanModuleSpecifiers(`
      export type Alpha = string
      import { a } from "./runtime.ts";
      import type Beta = require("./types.ts")
      const b = require("./more.ts");
      export type Gamma = { g: string }
      const c = require(name);
      export type Delta =
        | { d: string }
        | string;
      const e = require("./last.ts");
      import type {
        F,
        G,
      } from "./only-types.ts"
      const h = require("./after-braces.ts");
      export type Epsilon = Map<
        string,
        number
      >
      const i = require("./after-generics.ts");
    `);
    expect(scan.specifiers).toEqual([
      "./runtime.ts",
      "./more.ts",
      "./last.ts",
      "./after-braces.ts",
      "./after-generics.ts",
    ]);
    expect(scan.computed.map((c) => c.form)).toEqual(["require() with a computed specifier"]);
  });

  // A statement can begin with `typeof`, so the guard after a semicolonless
  // type clause is runtime code: the loads it makes still load, and a
  // computed one is still refused. A type query inside the clause keeps it
  // open and names no load.
  test("a typeof guard after a semicolonless type clause still loads", () => {
    const scan = scanModuleSpecifiers(`
      export type Alpha = string
      typeof require === "function" && require("./guarded.ts");
      export type Beta = { b: string }
      typeof require !== "undefined" && require(name);
      export type Gamma =
        typeof require
      const d = require("./after-typeof.ts");
      export type Delta = keyof
        typeof require
      const e = require("./after-keyof.ts");
    `);
    expect(scan.specifiers).toEqual(["./guarded.ts", "./after-typeof.ts", "./after-keyof.ts"]);
    expect(scan.computed.map((c) => c.form)).toEqual(["require() with a computed specifier"]);
  });

  test("a type-only import of a module with a computed load is not refused", () => {
    const root = project({
      "src/main.ts": "",
      "src/loader.ts": 'import type { Env } from "./env.ts";\nconst x: Env = {};\nexport { x };',
      "src/env.ts":
        "type DynamicImport = (specifier: string) => Promise<unknown>;\nconst load: DynamicImport = (specifier) => import(specifier);\nexport type Env = typeof load;\n",
      "src/reexport.ts": 'export type { Env } from "./env.ts";',
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./loader.ts")).toBeNull();
    expect(collector.add(join(root, "src/main.ts"), "./reexport.ts")).toBeNull();
    // The program's module ships; the module its type-only clause names does not.
    expect(collector.tree()!.files.map((f) => f.path)).toEqual(["loader.ts", "reexport.ts"]);
  });

  test("a package ships whole, with its dependencies, but not its nested node_modules", () => {
    const root = project({
      "main.ts": "",
      "node_modules/pkg/package.json": JSON.stringify({ dependencies: { dep: "1", absent: "1" } }),
      "node_modules/pkg/index.js": "module.exports = require(process.env.ANYTHING_GOES);",
      "node_modules/pkg/lib/extra.json": "{}",
      "node_modules/pkg/node_modules/.bin/x": "",
      "node_modules/dep/package.json": "{}",
      "node_modules/dep/index.js": "",
      "node_modules/other/index.js": "",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "main.ts"), "pkg/lib/extra.json")).toBeNull();
    expect(collector.tree()!.files.map((f) => f.path)).toEqual([
      "node_modules/dep/index.js",
      "node_modules/dep/package.json",
      "node_modules/pkg/index.js",
      "node_modules/pkg/lib/extra.json",
      "node_modules/pkg/package.json",
    ]);
  });

  test("a source the compiler synthesized beside a package's files is not shipped", () => {
    // A package compiled natively gets generated declarations in the
    // compiler's file shadow; an island that depends on the package ships
    // its directory, which lists them, and they are on no disk.
    const root = project({
      "main.ts": "",
      "node_modules/pkg/package.json": JSON.stringify({ dependencies: { dep: "1" } }),
      "node_modules/pkg/index.js": "module.exports = require('dep');",
      "node_modules/dep/package.json": "{}",
      "node_modules/dep/index.js": "module.exports = 1;",
    });
    setVirtualSource(join(root, "node_modules/dep/index.scriptc-types.d.ts"), "export type T = 1;");
    try {
      const collector = new NodeIslandModuleCollector();
      expect(collector.add(join(root, "main.ts"), "pkg")).toBeNull();
      const tree = collector.tree()!;
      expect(tree.files.map((f) => f.path)).toEqual([
        "node_modules/dep/index.js",
        "node_modules/dep/package.json",
        "node_modules/pkg/index.js",
        "node_modules/pkg/package.json",
      ]);
      expect(readNodeIslandModules(tree)).toBeInstanceOf(Uint8Array);
    } finally {
      clearVirtualSources();
    }
  });

  test("packages a package loads without declaring them ship too", () => {
    const root = project({
      "main.ts": "",
      "node_modules/bridge/package.json": JSON.stringify({
        type: "module",
        imports: { "#mapped": { node: "mapped", default: "./local.js" } },
      }),
      "node_modules/bridge/index.js":
        'import { a } from "zoo";\nexport const b = () => import("zoo/extra.js");',
      "node_modules/bridge/index.d.ts": 'import type { T } from "typesonly";',
      "node_modules/zoo/package.json": "{}",
      "node_modules/zoo/index.js": "exports.a = 1;",
      "node_modules/zoo/extra.js": "",
      "node_modules/typesonly/index.d.ts": "",
      "node_modules/mapped/index.js": "",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.addLoaded(join(root, "node_modules/bridge/index.js"))).toBeNull();
    // The root stays above node_modules, where Node looks for packages.
    expect(collector.tree()!.files.map((f) => f.path)).toEqual([
      "node_modules/bridge/index.d.ts",
      "node_modules/bridge/index.js",
      "node_modules/bridge/package.json",
      "node_modules/mapped/index.js",
      "node_modules/zoo/extra.js",
      "node_modules/zoo/index.js",
      "node_modules/zoo/package.json",
    ]);
  });

  test("collectors that share their scans build the same tree as one that does not", () => {
    const root = project({
      "main.ts": "",
      "node_modules/bridge/package.json": "{}",
      "node_modules/bridge/index.js": 'const zoo = require("zoo");\nmodule.exports = zoo;',
      "node_modules/zoo/package.json": "{}",
      "node_modules/zoo/index.js": "exports.a = 1;",
    });
    const paths = (collector: NodeIslandModuleCollector): string[] => {
      expect(collector.addLoaded(join(root, "node_modules/bridge/index.js"))).toBeNull();
      return collector.tree()!.files.map((f) => f.path);
    };
    const alone = paths(new NodeIslandModuleCollector());
    const scans = new ModuleSpecifierScans();
    // Two passes of one round: the second collector reads the first's scans.
    expect(paths(new NodeIslandModuleCollector(scans))).toEqual(alone);
    expect(paths(new NodeIslandModuleCollector(scans))).toEqual(alone);
    expect(alone).toContain("node_modules/zoo/index.js");
  });

  test("type-only imports ship nothing and are not traced", () => {
    const root = project({
      "main.ts":
        'import type { T } from "./types.ts";\nimport "./shared.ts";\nexport const t: T = 0;\n',
      "types.ts": 'import type { U } from "./other.ts";\nexport type T = U;\n',
      // Node never loads this file, so its computed load is not a problem.
      "other.ts":
        "const load = (specifier: string) => import(specifier);\nexport type U = number;\n",
      "shared.ts": "export const y = 1;\n",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.addLoaded(join(root, "main.ts"))).toBeNull();
    expect(collector.tree()!.files.map((f) => f.path)).toEqual(["main.ts", "shared.ts"]);
  });

  test("pnpm's links between package directories stay links inside the tree", () => {
    const root = project({
      "app/main.ts": "",
      "app/node_modules/.pnpm/a@1/node_modules/a/package.json": JSON.stringify({
        dependencies: { b: "1" },
      }),
      "app/node_modules/.pnpm/a@1/node_modules/a/index.js": "",
      "app/node_modules/.pnpm/b@1/node_modules/b/index.js": "",
    });
    symlinkSync(".pnpm/a@1/node_modules/a", join(root, "app/node_modules/a"));
    symlinkSync(
      "../../b@1/node_modules/b",
      join(root, "app/node_modules/.pnpm/a@1/node_modules/b"),
    );
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "app/main.ts"), "a")).toBeNull();
    const tree = collector.tree()!;
    expect(tree.root).toBe(join(root, "app"));
    expect(tree.links).toEqual([
      { path: "node_modules/.pnpm/a@1/node_modules/b", target: "../../b@1/node_modules/b" },
      { path: "node_modules/a", target: ".pnpm/a@1/node_modules/a" },
    ]);
    expect(tree.files.map((f) => f.path)).toEqual([
      "node_modules/.pnpm/a@1/node_modules/a/index.js",
      "node_modules/.pnpm/a@1/node_modules/a/package.json",
      "node_modules/.pnpm/b@1/node_modules/b/index.js",
    ]);
  });

  test("a require through a linked directory keeps the link in the tree", () => {
    const root = project({
      "src/main.ts": "",
      "src/entry.cjs": "module.exports = require('./lib/x.cjs');",
      "shared/x.cjs": "exports.x = 1;",
    });
    symlinkSync("../shared", join(root, "src/lib"));
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./entry.cjs")).toBeNull();
    const tree = collector.tree()!;
    expect(tree.links).toEqual([{ path: "src/lib", target: "../shared" }]);
    expect(tree.files.map((f) => f.path)).toEqual(["shared/x.cjs", "src/entry.cjs"]);
  });

  test("an absolute specifier names the shipped file relative to its caller", () => {
    const root = project({ "src/main.ts": "", "lib/m.cjs": "" });
    const collector = new NodeIslandModuleCollector();
    const target = collector.resolvedPath(join(root, "src/main.ts"), join(root, "lib/m.cjs"))!;
    expect(target).toBe(join(root, "lib/m.cjs"));
    expect(NodeIslandModuleCollector.relativeSpecifier(join(root, "src/main.ts"), target)).toBe(
      "../lib/m.cjs",
    );
    expect(
      NodeIslandModuleCollector.relativeSpecifier(join(root, "main.ts"), join(root, "m.cjs")),
    ).toBe("./m.cjs");
  });

  test("built-in modules alone ship no tree", () => {
    const root = project({ "main.ts": "" });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "main.ts"), "os")).toBeNull();
    expect(collector.tree()).toBeNull();
    expect(NodeIslandModuleCollector.callerPath(null, join(root, "main.ts"))).toBe("main.ts");
  });

  test("a data file the module names beside itself ships with it", () => {
    const root = project({
      "src/main.ts": "",
      "src/loader.ts": [
        'import { join } from "node:path";',
        'const here = "/x";',
        'const fallback = join(here, "fallback", "payload.txt");',
      ].join("\n"),
      "src/fallback/payload.txt": "from the fallback path\n",
      "src/unrelated.txt": "not named by the module\n",
      "src/helper.ts": "export const h = 1;",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./loader.ts")).toBeNull();
    const paths = collector.tree()!.files.map((file) => file.path);
    expect(paths).toContain("fallback/payload.txt");
    expect(paths).not.toContain("unrelated.txt");
    expect(paths).not.toContain("helper.ts");
  });

  test("named data stays inside the module's directory: links out of it are not followed", () => {
    const outside = project({ "secrets/config.json": "{}", "token.txt": "secret\n" });
    const root = project({
      "src/main.ts": "",
      "src/loader.ts":
        'const names = ["linked/config.json", "data/token.txt", "data/payload.txt", "data/loop/data/payload.txt"];',
      "src/data/payload.txt": "shipped\n",
    });
    symlinkSync(join(outside, "secrets"), join(root, "src/linked"), "dir");
    symlinkSync(join(outside, "token.txt"), join(root, "src/data/token.txt"));
    // A link back up the tree must not loop the walk.
    symlinkSync(join(root, "src"), join(root, "src/data/loop"), "dir");
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./loader.ts")).toBeNull();
    const paths = collector.tree()!.files.map((file) => file.path);
    expect(paths).toContain("data/payload.txt");
    expect(paths.filter((path) => path.endsWith("config.json"))).toEqual([]);
    expect(paths.filter((path) => path.endsWith("token.txt"))).toEqual([]);
    expect(paths.filter((path) => path.includes("loop"))).toEqual([]);
  });

  test("only the exact path a module names ships, never a file of the same name elsewhere", () => {
    const outside = project({ "outside.txt": "private\n" });
    const root = project({
      "src/main.ts": "",
      "src/loader.cjs": [
        'const fs = require("node:fs");',
        'const config = fs.readFileSync(__dirname + "/" + "assets/config.json");',
        'const up = "../notes.txt";',
        `const away = "${join(outside, "outside.txt")}";`,
        'const deps = "node_modules/dep/config.json";',
      ].join("\n"),
      "src/assets/config.json": "{}",
      "src/private/config.json": '{ "token": "secret" }',
      "src/config.json": '{ "token": "secret" }',
      "src/node_modules/dep/config.json": "{}",
      "notes.txt": "beside the source directory\n",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./loader.cjs")).toBeNull();
    const paths = collector.tree()!.files.map((file) => file.path);
    expect(paths.filter((path) => !path.endsWith(".cjs"))).toEqual(["assets/config.json"]);
  });

  test("a joined data path ships even when another directory has a file of that name", () => {
    const root = project({
      "src/main.ts": "",
      "src/loader.cjs":
        'const { join } = require("node:path");\nrequire("node:fs").readFileSync(join(__dirname, "fallback", "payload.txt"));\n',
      "src/a-other/payload.txt": "not named by the module\n",
      "src/fallback/payload.txt": "shipped\n",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./loader.cjs")).toBeNull();
    const paths = collector.tree()!.files.map((file) => file.path);
    expect(paths).toContain("fallback/payload.txt");
    expect(paths).not.toContain("a-other/payload.txt");
  });

  test("a named file that is only elsewhere in the module's directory is a build error", () => {
    const root = project({
      "src/main.ts": "",
      "src/loader.cjs":
        'const fs = require("node:fs");\nfs.readFileSync(__dirname + "/config.json");\n',
      "src/private/config.json": '{ "token": "secret" }',
    });
    const collector = new NodeIslandModuleCollector();
    const problem = collector.add(join(root, "src/main.ts"), "./loader.cjs");
    expect(problem).toBe(
      `${join(root, "src/loader.cjs")}:2 names the file 'config.json', which is not at that path beside the module; the build ships a module's data files by their exact path, so 'private/config.json' does not ship with the Node island. Name the file by its path relative to the module ('private/config.json')`,
    );
    expect(collector.isDataFileProblem(problem!)).toBe(true);
    expect(collector.tree()!.files.map((file) => file.path)).not.toContain("private/config.json");
  });

  test("the manifest names relative paths only, and the data is checked against it", () => {
    const root = project({ "main.ts": "", "m.cjs": "exports.f = () => 1;" });
    const collector = new NodeIslandModuleCollector();
    collector.add(join(root, "main.ts"), "./m.cjs");
    const tree = collector.tree()!;
    const manifest = nodeIslandManifest(tree);
    expect(manifest).not.toContain(root);
    // The tree's name is the digest of its files and links, first in the
    // text, in the one form the runtime reads without a JSON parser.
    const { tree: name, ...rest } = JSON.parse(manifest) as { tree: string };
    expect(name).toBe(createHash("sha256").update(JSON.stringify(rest)).digest("hex"));
    expect(manifest.startsWith(`{"tree":"${name}","files":[["m.cjs",20,"`)).toBe(true);
    expect(manifest.endsWith(`"]],"links":[]}`)).toBe(true);
    expect(readNodeIslandModules(tree)).toEqual(new TextEncoder().encode("exports.f = () => 1;"));
    writeFileSync(join(root, "m.cjs"), "exports.f = () => 2;");
    expect(readNodeIslandModules(tree)).toBe(`${join(root, "m.cjs")} changed during the build`);
  });
});

describe("modules the program provides", () => {
  test("a shared program module ships as a placeholder, not its source", () => {
    const source = "// internal pricing rules\nexport const margin = 0.37;\n";
    const root = project({
      "src/main.ts": "",
      "src/pricing.ts": source,
      "src/plugin.mjs": "export const x = 1;",
    });
    const collector = new NodeIslandModuleCollector();
    expect(collector.add(join(root, "src/main.ts"), "./plugin.mjs")).toBeNull();
    collector.addProvided(join(root, "src/pricing.ts"));
    const tree = collector.tree()!;
    const entry = tree.files.find((f) => f.path.endsWith("pricing.ts"))!;
    expect(entry.placeholder).toBe(true);
    const data = readNodeIslandModules(tree);
    if (typeof data === "string") throw new Error(data);
    const shipped = new TextDecoder().decode(data);
    expect(shipped).not.toContain("internal pricing rules");
    expect(shipped).not.toContain("margin");
    expect(shipped).toContain("export const x = 1;");
  });

  test("island code that imports a provided module ships neither its source nor its imports", () => {
    const root = project({
      "src/main.ts": "",
      "src/plugin.mjs": 'import { y } from "./shared.mjs";\nexport const z = y;',
      "src/shared.mjs": 'import { secret } from "./internal.mjs";\nexport const y = secret;',
      "src/internal.mjs": "export const secret = 42;",
    });
    const collector = new NodeIslandModuleCollector();
    collector.addProvided(join(root, "src/shared.mjs"));
    expect(collector.add(join(root, "src/main.ts"), "./plugin.mjs")).toBeNull();
    const files = collector.tree()!.files;
    expect(files.find((f) => f.path.endsWith("shared.mjs"))!.placeholder).toBe(true);
    expect(files.some((f) => f.path.endsWith("internal.mjs"))).toBe(false);
  });

  test("requireModule specifiers come from code, not comments or strings", () => {
    expect(
      requireModuleSpecifiers(`
        // requireModule("./commented.mjs")
        /* requireModule("./block.mjs") */
        const s = 'requireModule("./in-string.mjs")';
        const t = \`requireModule("./in-template.mjs")\`;
        const p = requireModule("./plugin.mjs");
      `),
    ).toEqual(["./plugin.mjs"]);
  });
});
