import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  NodeIslandModuleCollector,
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
      scanModuleSpecifiers(text, { bounds: true }).computed.map((c) => c.form);
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
    expect(scanModuleSpecifiers("require(('./a.js' || './b') + '.js')", { bounds: true })).toEqual({
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

  test("the manifest names relative paths only, and the data is checked against it", () => {
    const root = project({ "main.ts": "", "m.cjs": "exports.f = () => 1;" });
    const collector = new NodeIslandModuleCollector();
    collector.add(join(root, "main.ts"), "./m.cjs");
    const tree = collector.tree()!;
    expect(nodeIslandManifest(tree)).not.toContain(root);
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
