/* How a `--node-island` value is read (readNodeIslandMark): a package name is
 * a package whatever it looks like, a value spelled as a path is a path, and
 * a bare value that could be either is decided by what exists. `--native`
 * and the project's `scriptc.packages` take package names only, and
 * `scriptc.nodeIslands.modules` paths only. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseProjectConfig } from "../project-config.js";
import {
  isMarkedUserModule,
  nodeIslandPolicy,
  readNodeIslandMark,
  type NodeIslandMark,
} from "./policy.js";

/** A project on disk:
 *
 *   app/main.ts                              the entry module
 *   app/widget.js                            a file named like the package
 *   app/legacy.js, app/src/old.cjs           files no package is named like
 *   app/node_modules/widget.js               a package named like a file
 *   app/node_modules/@acme/table.json        a scoped one
 *   app/node_modules/plain                   a package with an ordinary name
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-island-policy-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const app = join(root, "app");
const entry = join(app, "main.ts");
for (const name of ["widget.js", "@acme/table.json", "plain"]) {
  mkdirSync(join(app, "node_modules", name), { recursive: true });
  writeFileSync(join(app, "node_modules", name, "package.json"), JSON.stringify({ name }));
}
mkdirSync(join(app, "src"));
for (const file of ["main.ts", "widget.js", "legacy.js", "src/old.cjs"])
  writeFileSync(join(app, file), "");

const read = (value: string): NodeIslandMark => readNodeIslandMark(value, entry, app);
const asPackage = (value: string, name: string, why: "name" | "installed" = "name") => ({
  kind: "package",
  value,
  name,
  file: resolve(app, value),
  why,
});
const asPath = (value: string, why: "explicit" | "glob" | "node-modules" | "file") => ({
  kind: "path",
  value,
  pattern: resolve(app, value),
  why,
});

describe("readNodeIslandMark", () => {
  test.each([
    ["chalk", "chalk"],
    // Names that end like a module file, or carry a dot.
    ["highlight.js", "highlight.js"],
    ["loader.mjs", "loader.mjs"],
    ["loader.cjs", "loader.cjs"],
    ["types.ts", "types.ts"],
    ["view.tsx", "view.tsx"],
    ["data.json", "data.json"],
    ["socket.io", "socket.io"],
    // Scoped names, with and without a dotted tail.
    ["@scope/pkg", "@scope/pkg"],
    ["@scope/pkg.js", "@scope/pkg.js"],
    ["@acme/table.json", "@acme/table.json"],
    // A subpath names its package: the package is what runs in an island.
    ["highlight.js/", "highlight.js"],
    ["highlight.js/lib/core", "highlight.js"],
    ["highlight.js/lib/index.js", "highlight.js"],
    ["@scope/pkg.js/dist/index.mjs", "@scope/pkg.js"],
    ["plain/index.js", "plain"],
  ])("%s is the package %s", (value, name) => {
    expect(read(value)).toEqual(asPackage(value, name));
  });

  test.each(["./widget.js", "./legacy.js", "./missing.js", "../other/file.js", ".hidden.js"])(
    "%s is a path: it starts with a dot",
    (value) => {
      expect(read(value)).toEqual(asPath(value, "explicit"));
    },
  );

  test("an absolute value is a path", () => {
    const file = join(app, "widget.js");
    expect(read(file)).toEqual({ kind: "path", value: file, pattern: file, why: "explicit" });
  });

  test.each(["src/*.ts", "**/*.js", "./src/**", "node_modules/widget.js/**", "*.js"])(
    "%s is a glob",
    (value) => {
      expect(read(value)).toEqual(asPath(value, "glob"));
    },
  );

  test.each(["node_modules/widget.js", "node_modules/widget.js/index.js", "node_modules/absent"])(
    "%s is a path: no package is named node_modules",
    (value) => {
      expect(read(value)).toEqual(asPath(value, "node-modules"));
    },
  );

  test.each(["legacy.js", "src/old.cjs", "main.ts"])(
    "%s is a path: the file exists and no package has the name",
    (value) => {
      expect(read(value)).toEqual(asPath(value, "file"));
    },
  );

  test("a directory is not a file: src stays a package name", () => {
    expect(read("src")).toEqual(asPackage("src", "src"));
  });

  test("a name that is both a file and a package is the package, and ./ names the file", () => {
    expect(read("widget.js")).toEqual(asPackage("widget.js", "widget.js", "installed"));
    expect(read("./widget.js")).toEqual(asPath("./widget.js", "explicit"));
  });

  test("the package is looked up from the entry module, as its imports are", () => {
    // From an entry outside the project no node_modules holds widget.js, so
    // the existing file is what the value names.
    const outside = join(root, "elsewhere", "main.ts");
    expect(readNodeIslandMark("widget.js", outside, app)).toEqual(asPath("widget.js", "file"));
    // A nested entry finds the package in a node_modules above it.
    const nested = join(app, "src", "deep", "main.ts");
    expect(readNodeIslandMark("widget.js", nested, app)).toEqual(
      asPackage("widget.js", "widget.js", "installed"),
    );
  });
});

describe("nodeIslandPolicy", () => {
  const config = (scriptc: unknown) =>
    parseProjectConfig(join(app, "package.json"), JSON.stringify({ scriptc }));
  const none = config({});

  test("--node-island values land as package marks or module patterns", () => {
    const cwd = process.cwd();
    const policy = nodeIslandPolicy(
      none,
      { islands: ["highlight.js", "@acme/table.json/index.js", "./local.js", "lib/*.js"] },
      entry,
    );
    expect([...policy.forcedNode]).toEqual([
      ["highlight.js", "cli"],
      ["@acme/table.json", "cli"],
    ]);
    expect([...policy.packageMarks.keys()]).toEqual(["highlight.js", "@acme/table.json"]);
    expect(policy.userModules.map((m) => [m.pattern, m.source, m.mark?.why])).toEqual([
      [join(cwd, "local.js"), "cli", "explicit"],
      [join(cwd, "lib/*.js"), "cli", "glob"],
    ]);
    expect(isMarkedUserModule(policy, join(cwd, "highlight.js"))).toBe(null);
    expect(isMarkedUserModule(policy, join(cwd, "local.js"))).toBe("cli");
  });

  test("--native takes package names: a name that looks like a file is a package", () => {
    const policy = nodeIslandPolicy(none, { native: ["widget.js", "@acme/table.json"] }, entry);
    expect([...policy.forcedNative]).toEqual([
      ["widget.js", "cli"],
      ["@acme/table.json", "cli"],
    ]);
    expect(policy.userModules).toEqual([]);
  });

  test("a package marked both ways keeps its mark, so the build can refuse the pair", () => {
    const policy = nodeIslandPolicy(
      none,
      { islands: ["highlight.js/lib/core"], native: ["highlight.js"] },
      entry,
    );
    expect([...policy.forcedNode]).toEqual([]);
    expect([...policy.forcedNative]).toEqual([["highlight.js", "cli"]]);
    expect(policy.packageMarks.get("highlight.js")?.value).toBe("highlight.js/lib/core");
  });

  test("scriptc.packages names packages and scriptc.nodeIslands.modules names paths", () => {
    const policy = nodeIslandPolicy(
      config({
        packages: { "widget.js": "node", "socket.io": "native" },
        nodeIslands: { modules: ["widget.js", "src/*.cjs"] },
      }),
      undefined,
      entry,
    );
    expect([...policy.forcedNode]).toEqual([["widget.js", "config"]]);
    expect([...policy.forcedNative]).toEqual([["socket.io", "config"]]);
    expect(policy.packageMarks.size).toBe(0);
    // A configured module is a path beside the package.json, whatever
    // packages are installed.
    expect(policy.userModules).toEqual([
      { pattern: join(app, "widget.js"), source: "config" },
      { pattern: join(app, "src/*.cjs"), source: "config" },
    ]);
    expect(isMarkedUserModule(policy, join(app, "widget.js"))).toBe("config");
    expect(isMarkedUserModule(policy, join(app, "src/old.cjs"))).toBe("config");
  });
});
