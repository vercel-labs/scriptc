import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import type { IrNodeIslandModules } from "../ir/ir.js";
import {
  buildLoadPlan,
  IslandTreeModel,
  LOAD_PLAN_PATH,
  planGroupOf,
  planNodeIslandLoads,
  usesRequireIndirectly,
} from "./load-plan.js";
import { moduleTokens, readNodeIslandModules } from "./modules.js";

type Tree = Pick<IrNodeIslandModules, "files" | "links">;

/** A tree of the given files (path → text) and links (path → target). */
function tree(
  files: Record<string, string>,
  links: Record<string, string> = {},
): { tree: Tree; read: (path: string) => string | null } {
  return {
    tree: {
      files: Object.keys(files)
        .sort()
        .map((path) => ({ path, size: 0, sha256: "" })),
      links: Object.entries(links).map(([path, target]) => ({ path, target })),
    },
    read: (path) => files[path] ?? null,
  };
}

interface Decoded {
  /** `parent → specifier → require target, import target (an ES module)`. */
  answers: Map<string, Map<string, { require?: string; import?: string }>>;
  files: Set<string>;
}

/** A plan's bytes as the bootstrap reads them. */
function decode(bytes: Uint8Array): Decoded {
  const text = Buffer.from(bytes);
  const end = text.indexOf(10);
  const header = JSON.parse(text.toString("utf8", 0, end)) as {
    v: number;
    groups: [string, number, number][];
  };
  expect(header.v).toBe(1);
  const answers: Decoded["answers"] = new Map();
  const files = new Set<string>();
  for (const [directory, offset, length] of header.groups) {
    const document = JSON.parse(
      text.toString("utf8", end + 1 + offset, end + 1 + offset + length),
    ) as { files: string[]; extern: string[]; requests: (string | number)[][] };
    const prefix = directory === "" ? "" : `${directory}/`;
    const target = (id: number): string =>
      id < document.files.length
        ? prefix + document.files[id]!
        : document.extern[id - document.files.length]!;
    document.files.forEach((file, id) => {
      files.add(prefix + file);
      const triples = document.requests[id]!;
      const bySpecifier = new Map<string, { require?: string; import?: string }>();
      for (let k = 0; k < triples.length; k += 3) {
        const required = triples[k + 1] as number;
        const imported = triples[k + 2] as number;
        bySpecifier.set(triples[k] as string, {
          ...(required < 0 ? {} : { require: target(required) }),
          ...(imported < 0 ? {} : { import: target(imported) }),
        });
      }
      answers.set(prefix + file, bySpecifier);
    });
  }
  return { answers, files };
}

function plan(files: Record<string, string>, links: Record<string, string> = {}): Decoded {
  const input = tree(files, links);
  const built = buildLoadPlan(input.tree, input.read);
  expect(built).not.toBeNull();
  return decode(built!.bytes);
}

describe("the tree as Node sees it", () => {
  test("paths join inside the tree and never above it", () => {
    expect(IslandTreeModel.join("a/b", "./c.js")).toBe("a/b/c.js");
    expect(IslandTreeModel.join("a/b", "../c/")).toBe("a/c");
    expect(IslandTreeModel.join("a", "..")).toBe("");
    expect(IslandTreeModel.join("a", "../..")).toBeNull();
    expect(IslandTreeModel.join("", "./x")).toBe("x");
  });

  test("links are followed, a link out of the tree is unknown", () => {
    const model = new IslandTreeModel({
      files: [{ path: "store/pkg/index.js", size: 0, sha256: "" }],
      links: [
        { path: "node_modules/pkg", target: "../store/pkg" },
        { path: "node_modules/out", target: "../../elsewhere" },
        { path: "loop/a", target: "b" },
        { path: "loop/b", target: "a" },
      ],
    });
    expect(model.realpath("node_modules/pkg/index.js")).toBe("store/pkg/index.js");
    expect(model.stat("node_modules/pkg/index.js")).toBe("file");
    expect(model.stat("node_modules/pkg")).toBe("directory");
    expect(model.stat("node_modules/pkg/missing.js")).toBe("none");
    expect(model.stat("node_modules/out/x.js")).toBe("unknown");
    expect(model.stat("loop/a/x.js")).toBe("unknown");
    expect(model.stat("")).toBe("directory");
  });

  test("a package's directory groups its files", () => {
    expect(planGroupOf("node_modules/pkg/lib/a.js")).toBe("node_modules/pkg");
    expect(planGroupOf("node_modules/@scope/pkg/a.js")).toBe("node_modules/@scope/pkg");
    expect(planGroupOf("node_modules/a/node_modules/b/x.js")).toBe("node_modules/a/node_modules/b");
    expect(planGroupOf("node_modules/.pnpm/a@1/node_modules/a/x.js")).toBe(
      "node_modules/.pnpm/a@1/node_modules/a",
    );
    expect(planGroupOf("src/main.js")).toBe("");
    // A file that sits in node_modules itself belongs to no package.
    expect(planGroupOf("node_modules/loose.js")).toBe("");
    expect(planGroupOf("node_modules/@scope/loose.js")).toBe("");
  });
});

describe("a module that uses require other than by calling it", () => {
  const indirect = (text: string): boolean => usesRequireIndirectly(moduleTokens(text));
  test("calls, tests and members of other objects are direct", () => {
    expect(indirect(`const a = require("./a"); module.require("./b");`)).toBe(false);
    expect(indirect(`if (typeof require !== "undefined" && require.main === module) run();`)).toBe(
      false,
    );
    expect(indirect(`const o = { require: 1 }; delete require.cache[k];`)).toBe(false);
  });
  test("resolve, aliases and created requires are not", () => {
    expect(indirect(`require.resolve("./a", { paths: [dir] });`)).toBe(true);
    expect(indirect(`const r = require; r("./a");`)).toBe(true);
    expect(indirect(`load(require);`)).toBe(true);
    expect(indirect(`const req = createRequire(import.meta.url);`)).toBe(true);
    expect(indirect(`require.extensions[".x"] = f;`)).toBe(true);
  });
});

describe("what the plan answers", () => {
  test("require: the file, then extensions, then a directory's index", () => {
    const { answers } = plan({
      "node_modules/pkg/package.json": "{}",
      "node_modules/pkg/index.js": `
        require("./a"); require("./a.js"); require("./both"); require("./dir");
        require("./dir/"); require("./data"); require("./addon"); require("./exact.txt");
        require("."); require("./"); require("./missing"); require("./lib/../a");
      `,
      "node_modules/pkg/a.js": "",
      "node_modules/pkg/both.js": "",
      "node_modules/pkg/both/index.js": "",
      "node_modules/pkg/dir/index.js": "",
      "node_modules/pkg/data.json": "{}",
      "node_modules/pkg/addon.node": "",
      "node_modules/pkg/exact.txt": "",
      "node_modules/pkg/lib/x.js": "",
    });
    const from = answers.get("node_modules/pkg/index.js")!;
    const required = (specifier: string): string | undefined => from.get(specifier)?.require;
    expect(required("./a")).toBe("node_modules/pkg/a.js");
    expect(required("./a.js")).toBe("node_modules/pkg/a.js");
    // A file wins over a directory of the same name.
    expect(required("./both")).toBe("node_modules/pkg/both.js");
    expect(required("./dir")).toBe("node_modules/pkg/dir/index.js");
    expect(required("./dir/")).toBe("node_modules/pkg/dir/index.js");
    expect(required("./data")).toBe("node_modules/pkg/data.json");
    expect(required("./addon")).toBe("node_modules/pkg/addon.node");
    expect(required("./exact.txt")).toBe("node_modules/pkg/exact.txt");
    // The package's own directory: its package.json names no main.
    expect(required(".")).toBe("node_modules/pkg/index.js");
    expect(required("./")).toBe("node_modules/pkg/index.js");
    expect(required("./missing")).toBeUndefined();
    expect(required("./lib/../a")).toBe("node_modules/pkg/a.js");
  });

  test("require: a directory whose package.json names a main is Node's", () => {
    const { answers } = plan({
      "node_modules/pkg/index.js": `require("./with-main"); require("./broken"); require("./plain");`,
      "node_modules/pkg/with-main/package.json": `{"main":"lib.js"}`,
      "node_modules/pkg/with-main/lib.js": "",
      "node_modules/pkg/with-main/index.js": "",
      "node_modules/pkg/broken/package.json": `{ not json`,
      "node_modules/pkg/broken/index.js": "",
      "node_modules/pkg/plain/package.json": `{"type":"commonjs"}`,
      "node_modules/pkg/plain/index.js": "",
    });
    const from = answers.get("node_modules/pkg/index.js")!;
    expect(from.get("./with-main")).toBeUndefined();
    expect(from.get("./broken")).toBeUndefined();
    expect(from.get("./plain")?.require).toBe("node_modules/pkg/plain/index.js");
  });

  test("import: the file itself, with the format its name or its package decides", () => {
    const { answers } = plan({
      "node_modules/esm/package.json": `{"type":"module"}`,
      "node_modules/esm/index.js": `
        import "./a.js"; import "./b.mjs"; import "./c.cjs"; import "./a";
        import "./dir"; import "./cjs/x.js"; import "./typeless/y.js"; import "./data.json";
        import "./broken/z.js";
      `,
      "node_modules/esm/a.js": "",
      "node_modules/esm/b.mjs": "",
      "node_modules/esm/c.cjs": "",
      "node_modules/esm/dir/index.js": "",
      "node_modules/esm/cjs/package.json": `{"type":"commonjs"}`,
      "node_modules/esm/cjs/x.js": "",
      "node_modules/esm/typeless/package.json": `{}`,
      "node_modules/esm/typeless/y.js": "",
      "node_modules/esm/broken/package.json": `[]`,
      "node_modules/esm/broken/z.js": "",
      "node_modules/esm/data.json": "{}",
    });
    const from = answers.get("node_modules/esm/index.js")!;
    expect(from.get("./a.js")?.import).toBe("node_modules/esm/a.js");
    expect(from.get("./b.mjs")?.import).toBe("node_modules/esm/b.mjs");
    // CommonJS imported from ES code goes through Node's own resolver.
    expect(from.get("./c.cjs")?.import).toBeUndefined();
    expect(from.get("./c.cjs")?.require).toBe("node_modules/esm/c.cjs");
    // No extension is added and no directory is opened under import.
    expect(from.get("./a")?.import).toBeUndefined();
    expect(from.get("./dir")?.import).toBeUndefined();
    expect(from.get("./cjs/x.js")?.import).toBeUndefined();
    // Node detects the format of a .js file whose package declares none.
    expect(from.get("./typeless/y.js")?.import).toBeUndefined();
    expect(from.get("./typeless/y.js")?.require).toBe("node_modules/esm/typeless/y.js");
    expect(from.get("./broken/z.js")?.import).toBeUndefined();
    expect(from.get("./data.json")?.import).toBeUndefined();
  });

  test("import: a package scope that leaves the tree or stops at node_modules is Node's", () => {
    const { answers } = plan({
      "src/main.mjs": `import "./loose.js"; import "./util.mjs";`,
      "src/loose.js": "",
      "src/util.mjs": "",
      "node_modules/@scope/pkg/index.mjs": `import "../side.js";`,
      "node_modules/@scope/side.js": "",
    });
    const main = answers.get("src/main.mjs")!;
    expect(main.get("./loose.js")?.import).toBeUndefined();
    expect(main.get("./util.mjs")?.import).toBe("src/util.mjs");
    expect(answers.get("node_modules/@scope/pkg/index.mjs")!.get("../side.js")?.import).toBe(
      undefined,
    );
  });

  test("links between package directories resolve to real paths", () => {
    const { answers, files } = plan(
      {
        "node_modules/.store/dep@1/node_modules/dep/index.js": `require("./lib/a");`,
        "node_modules/.store/dep@1/node_modules/dep/lib/a.js": `require("../../other/x");`,
        "node_modules/.store/other@2/node_modules/other/x.js": "",
      },
      {
        "node_modules/dep": ".store/dep@1/node_modules/dep",
        "node_modules/.store/dep@1/node_modules/other": "../../other@2/node_modules/other",
      },
    );
    expect(files.has("node_modules/.store/dep@1/node_modules/dep/index.js")).toBe(true);
    expect(
      answers.get("node_modules/.store/dep@1/node_modules/dep/lib/a.js")!.get("../../other/x")
        ?.require,
    ).toBe("node_modules/.store/other@2/node_modules/other/x.js");
  });

  test("what is left to Node", () => {
    const input = tree({
      "node_modules/pkg/index.js": `
        require("dep"); require("node:fs"); require("fs"); require("/abs/x.js");
        require("./we ird"); require("./a%20b.js"); require("./a//b.js"); require("../../../out");
        require("./a");
      `,
      "node_modules/pkg/we ird.js": `require("./a");`,
      "node_modules/pkg/a.js": `const r = require.resolve("./b"); require("./b");`,
      "node_modules/pkg/b.js": "",
      "node_modules/pkg/types.d.ts": `import "./a";`,
    });
    const built = buildLoadPlan(input.tree, input.read)!;
    const { answers, files } = decode(built.bytes);
    // A path pathToFileURL would escape is not a plan file, nor a declaration file.
    expect([...files].sort()).toEqual([
      "node_modules/pkg/a.js",
      "node_modules/pkg/b.js",
      "node_modules/pkg/index.js",
    ]);
    const index = answers.get("node_modules/pkg/index.js")!;
    expect([...index.keys()]).toEqual(["./a"]);
    // require.resolve can carry `paths`: the module's requires are Node's.
    expect(answers.get("node_modules/pkg/a.js")!.get("./b")?.require).toBeUndefined();
    // Package names, built-ins and absolute paths are Node's without a count.
    const left = built.groups[0]!.left;
    expect([...left.keys()].sort()).toEqual([
      "a path that leaves the shipped tree",
      "a specifier with characters outside the plain set",
      "the module uses require other than by calling it",
    ]);
    expect(left.get("a specifier with characters outside the plain set")).toBe(3);
    expect(left.get("a path that leaves the shipped tree")).toBe(1);
    expect(left.get("the module uses require other than by calling it")).toBe(1);
    expect(built.groups[0]!.answered).toBe(1);
  });

  test("a tree with no module file has no plan", () => {
    const input = tree({ "node_modules/pkg/data.json": "{}", "node_modules/pkg/we ird.js": "" });
    expect(buildLoadPlan(input.tree, input.read)).toBeNull();
  });
});

/* ── against Node's own resolver ──────────────────────────────────────── */

/** A tree on disk that exercises every rule, and some the plan leaves. */
function diskTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-load-plan-")));
  const files: Record<string, string> = {
    "package.json": `{"type":"module"}`,
    "src/main.js": `import "./util.js"; import "./lib/deep.mjs"; import "../node_modules/esm/a.js";`,
    "src/util.js": `import "./main.js";`,
    "src/lib/deep.mjs": `import "../util.js"; import "./missing.js";`,
    "src/legacy.cjs": `require("./util"); require("./lib"); require("../package.json"); require("./legacy.cjs");`,
    "src/lib/index.js": "",
    "node_modules/cjs/package.json": `{"name":"cjs","main":"index.js"}`,
    "node_modules/cjs/index.js": `
      require("./a"); require("./a.js"); require("./both"); require("./both/"); require("./dir");
      require("./data"); require("./exact.txt"); require("."); require("./"); require("..");
      require("./with-main"); require("./no-main"); require("./missing"); require("./lib/../a");
      require("./a.b"); require("./json-first"); require("./only-json-index"); require("./bin");
      require("./dir/index"); require("./typed/t.js"); require("./x.mjs"); require("./x.cjs");
    `,
    "node_modules/cjs/a.js": `require("./index"); require("./dir/../both.js");`,
    "node_modules/cjs/a.b.js": "",
    "node_modules/cjs/both.js": "",
    "node_modules/cjs/both/index.js": "",
    "node_modules/cjs/dir/index.js": `require(".."); require("../a"); require("./");`,
    "node_modules/cjs/data.json": "{}",
    "node_modules/cjs/exact.txt": "",
    "node_modules/cjs/with-main/package.json": `{"main":"./entry.js"}`,
    "node_modules/cjs/with-main/entry.js": "",
    "node_modules/cjs/with-main/index.js": "",
    "node_modules/cjs/no-main/package.json": `{"name":"inner"}`,
    "node_modules/cjs/no-main/index.js": "",
    "node_modules/cjs/json-first.json": "{}",
    "node_modules/cjs/json-first/index.js": "",
    "node_modules/cjs/only-json-index/index.json": "{}",
    "node_modules/cjs/bin": "",
    "node_modules/cjs/bin.js": "",
    "node_modules/cjs/typed/package.json": `{"type":"module"}`,
    "node_modules/cjs/typed/t.js": "",
    "node_modules/cjs/x.mjs": "",
    "node_modules/cjs/x.cjs": "",
    "node_modules/esm/package.json": `{"name":"esm","type":"module","exports":"./index.js"}`,
    "node_modules/esm/index.js": `
      import "./a.js"; import "./b.mjs"; import "./c.cjs"; import "./a"; import "./dir";
      import "./dir/"; import "./cjs/x.js"; import "./typeless/y.js"; import "./data.json";
      import "./dir/index.js"; import "./a.b.js"; import "./.hidden.js"; import "../esm/a.js";
      import "./nested/node_modules/inner/i.js"; import "./missing.js";
    `,
    "node_modules/esm/a.js": `import "./index.js"; import "./b.mjs";`,
    "node_modules/esm/a.b.js": "",
    "node_modules/esm/.hidden.js": "",
    "node_modules/esm/b.mjs": `import "./dir/index.js";`,
    "node_modules/esm/c.cjs": `require("./cjs/x"); require("./typeless/y");`,
    "node_modules/esm/dir/index.js": `import "../a.js";`,
    "node_modules/esm/cjs/package.json": `{"type":"commonjs"}`,
    "node_modules/esm/cjs/x.js": "",
    "node_modules/esm/typeless/package.json": `{}`,
    "node_modules/esm/typeless/y.js": "",
    "node_modules/esm/data.json": "{}",
    "node_modules/esm/nested/node_modules/inner/package.json": `{"type":"module"}`,
    "node_modules/esm/nested/node_modules/inner/i.js": `import "../../../a.js";`,
    "node_modules/typeless/index.js": `require("./lib/x"); require("./lib");`,
    "node_modules/typeless/lib/x.js": "",
    "node_modules/typeless/lib/index.js": "",
    "node_modules/typeless/entry.mjs": `import "./lib/x.js"; import "./lib/m.mjs";`,
    "node_modules/typeless/lib/m.mjs": "",
    "node_modules/@scope/pkg/package.json": `{"type":"module"}`,
    "node_modules/@scope/pkg/index.js": `import "./sub/s.js"; import "../side.js"; import "../../cjs/x.mjs";`,
    "node_modules/@scope/pkg/sub/s.js": "",
    "node_modules/@scope/side.js": "",
    "node_modules/.store/dep@1/node_modules/dep/package.json": `{"type":"commonjs"}`,
    "node_modules/.store/dep@1/node_modules/dep/index.js": `require("./lib/a"); require("../other/x"); require("../other");`,
    "node_modules/.store/dep@1/node_modules/dep/lib/a.js": `require("../../other/x.js");`,
    "node_modules/.store/dep@1/node_modules/dep/m.mjs": `import "../other/x.js"; import "./lib/a.js";`,
    "node_modules/.store/other@2/node_modules/other/package.json": `{"type":"commonjs"}`,
    "node_modules/.store/other@2/node_modules/other/x.js": "",
    "node_modules/.store/other@2/node_modules/other/index.js": "",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  symlinkSync(".store/dep@1/node_modules/dep", join(root, "node_modules/dep"));
  symlinkSync(
    "../../other@2/node_modules/other",
    join(root, "node_modules/.store/dep@1/node_modules/other"),
  );
  return root;
}

function treeOnDisk(root: string): Tree {
  const files: Tree["files"] = [];
  const links: Tree["links"] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const at = relative(root, path);
      if (info.isSymbolicLink()) links.push({ path: at, target: readlinkSync(path) });
      else if (info.isDirectory()) walk(path);
      else files.push({ path: at, size: info.size, sha256: "" });
    }
  };
  walk(root);
  return { files, links };
}

/** Asks Node's default resolver, in a process of its own, what each
 * `[parent, specifier]` resolves to under `require` and under `import`. */
const ASK = `
const { createRequire, registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const fs = require("node:fs");
const [root, input, output] = process.argv.slice(2);
const questions = JSON.parse(fs.readFileSync(input, "utf8"));
const answers = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "scriptc:ask") return nextResolve(specifier, context);
    for (const [parent, request] of questions) {
      const file = root + "/" + parent;
      const answer = { parent, request };
      try {
        answer.require = createRequire(file).resolve(request);
      } catch (error) {
        answer.requireError = error.code;
      }
      try {
        const found = nextResolve(request, { ...context, parentURL: pathToFileURL(file).href });
        answer.import = found.url;
        answer.format = found.format ?? null;
      } catch (error) {
        answer.importError = error.code;
      }
      answers.push(answer);
    }
    return { url: "node:path", shortCircuit: true };
  },
});
import("scriptc:ask").then(() => {
  fs.writeFileSync(output, JSON.stringify({ answers, rootUrl: pathToFileURL(root + "/").href }));
});
`;

describe("the plan against Node's resolver", () => {
  const hooks = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === "function";
  test.skipIf(!hooks)("every answer is Node's, and Node finds nothing the plan refused", () => {
    const root = diskTree();
    const onDisk = treeOnDisk(root);
    const built = buildLoadPlan(onDisk, (path) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    })!;
    const { answers } = decode(built.bytes);
    const questions: [string, string][] = [];
    for (const [parent, bySpecifier] of answers)
      for (const specifier of bySpecifier.keys()) questions.push([parent, specifier]);
    expect(questions.length).toBeGreaterThan(60);
    const work = mkdtempSync(join(tmpdir(), "scriptc-load-plan-ask-"));
    writeFileSync(join(work, "ask.cjs"), ASK);
    writeFileSync(join(work, "in.json"), JSON.stringify(questions));
    execFileSync(
      process.execPath,
      [join(work, "ask.cjs"), root, join(work, "in.json"), join(work, "out.json")],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NODE_OPTIONS: "" } },
    );
    const asked = JSON.parse(readFileSync(join(work, "out.json"), "utf8")) as {
      rootUrl: string;
      answers: {
        parent: string;
        request: string;
        require?: string;
        import?: string;
        format?: string | null;
      }[];
    };
    let required = 0;
    let imported = 0;
    for (const node of asked.answers) {
      const mine = answers.get(node.parent)!.get(node.request)!;
      const where = `${node.request} from ${node.parent}`;
      if (mine.require !== undefined) {
        expect(node.require, where).toBe(join(root, mine.require));
        required++;
      }
      if (mine.import !== undefined) {
        // The bootstrap appends the tree path to the root's URL.
        expect(node.import, where).toBe(asked.rootUrl + mine.import);
        expect(node.format, where).toBe("module");
        imported++;
      }
    }
    expect(required).toBeGreaterThan(40);
    expect(imported).toBeGreaterThan(20);
  });

  test.skipIf(!hooks)("what the plan leaves, by case", () => {
    const root = diskTree();
    const onDisk = treeOnDisk(root);
    const built = buildLoadPlan(onDisk, (path) => readFileSync(join(root, path), "utf8"))!;
    const { answers } = decode(built.bytes);
    const cjs = answers.get("node_modules/cjs/index.js")!;
    expect(cjs.get("./with-main")).toBeUndefined();
    expect(cjs.get("./missing")).toBeUndefined();
    // The package's own directory has a package.json with a main.
    expect(cjs.get(".")).toBeUndefined();
    expect(cjs.get("./json-first")?.require).toBe("node_modules/cjs/json-first.json");
    expect(cjs.get("./bin")?.require).toBe("node_modules/cjs/bin");
    const esm = answers.get("node_modules/esm/index.js")!;
    // A leading dot is part of the name: the extension is the last one.
    expect(esm.get("./.hidden.js")?.import).toBe("node_modules/esm/.hidden.js");
    expect(esm.get("./c.cjs")?.import).toBeUndefined();
    expect(esm.get("./cjs/x.js")?.import).toBeUndefined();
    expect(esm.get("./typeless/y.js")?.import).toBeUndefined();
    expect(esm.get("./nested/node_modules/inner/i.js")?.import).toBe(
      "node_modules/esm/nested/node_modules/inner/i.js",
    );
    // Through a link: the real path of the other package.
    expect(
      answers.get("node_modules/.store/dep@1/node_modules/dep/index.js")!.get("../other/x")
        ?.require,
    ).toBe("node_modules/.store/other@2/node_modules/other/x.js");
  });
});

describe("the plan in the tree", () => {
  test("its entry joins the manifest and its bytes ship with the files", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-load-plan-tree-")));
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules/pkg/index.js"), `require("./a");`);
    writeFileSync(join(root, "node_modules/pkg/a.js"), "");
    const sha = (path: string): { path: string; size: number; sha256: string } => {
      const bytes = readFileSync(join(root, path));
      return {
        path,
        size: bytes.length,
        sha256: createHashOf(bytes),
      };
    };
    const modules: IrNodeIslandModules = {
      root,
      files: [sha("node_modules/pkg/a.js"), sha("node_modules/pkg/index.js")],
      links: [],
    };
    const generated = planNodeIslandLoads(modules);
    expect(modules.files.map((file) => file.path)).toEqual([
      LOAD_PLAN_PATH,
      "node_modules/pkg/a.js",
      "node_modules/pkg/index.js",
    ]);
    const data = readNodeIslandModules(modules, generated);
    expect(typeof data).not.toBe("string");
    expect((data as Uint8Array).length).toBe(modules.files.reduce((n, file) => n + file.size, 0));
    // Planning the same tree again replaces the entry.
    const again = planNodeIslandLoads(modules);
    expect(modules.files.filter((file) => file.path === LOAD_PLAN_PATH).length).toBe(1);
    expect(Buffer.from(again.get(LOAD_PLAN_PATH)!).equals(generated.get(LOAD_PLAN_PATH)!)).toBe(
      true,
    );
  });

  test("a tree that already has a file at the plan's path ships without a plan", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-load-plan-taken-")));
    mkdirSync(join(root, ".scriptc"), { recursive: true });
    writeFileSync(join(root, LOAD_PLAN_PATH), "theirs");
    writeFileSync(join(root, "main.cjs"), `require("./x");`);
    const modules: IrNodeIslandModules = {
      root,
      files: [
        { path: LOAD_PLAN_PATH, size: 6, sha256: createHashOf(Buffer.from("theirs")) },
        { path: "main.cjs", size: 15, sha256: "" },
      ],
      links: [],
    };
    expect(planNodeIslandLoads(modules).size).toBe(0);
    expect(modules.files.length).toBe(2);
  });
});

function createHashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
