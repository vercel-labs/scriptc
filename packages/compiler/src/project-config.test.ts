import { expect, test } from "vitest";
import { parseProjectConfig } from "./project-config.js";

const manifest = "/project/package.json";

function config(scriptc: unknown) {
  return parseProjectConfig(manifest, JSON.stringify({ name: "app", scriptc }, null, 2));
}

test("a package.json without a scriptc key has the default configuration", () => {
  const c = parseProjectConfig(manifest, '{ "name": "app" }');
  expect(c.diagnostics).toEqual([]);
  expect(c.packages.size).toBe(0);
  expect(c.nodeIslands).toEqual({
    auto: true,
    modules: [],
    node: null,
    nodeVersion: null,
    packaging: "embedded",
    speculativeStart: false,
  });
  expect(parseProjectConfig(manifest, "{ not json").diagnostics).toEqual([]);
});

test("package settings: strings and objects", () => {
  const c = config({
    packages: {
      encoding: "unloaded",
      "dd-trace": "node",
      "hot-shots": "native",
      semver: "auto",
      "proper-lockfile": { run: "node", evaluate: "lazy", share: "duplicate" },
    },
  });
  expect(c.diagnostics).toEqual([]);
  expect(c.packages.get("encoding")?.unloaded).toBe(true);
  expect(c.packages.get("dd-trace")?.run).toBe("node");
  expect(c.packages.get("hot-shots")?.run).toBe("native");
  expect(c.packages.get("semver")?.run).toBe("auto");
  expect(c.packages.get("proper-lockfile")).toEqual({
    unloaded: false,
    run: "node",
    evaluate: "lazy",
    share: "duplicate",
    marshal: "copy",
    schedule: "lockstep",
  });
});

test("nodeIslands settings", () => {
  const c = config({
    nodeIslands: {
      auto: false,
      modules: ["src/plugins/*.ts"],
      node: "/usr/local/bin/node",
      nodeVersion: ">=24.13.1",
      packaging: "beside",
      speculativeStart: true,
    },
    wasm: ["build/a.wasm", 3],
  });
  expect(c.diagnostics).toEqual([]);
  expect(c.nodeIslands).toEqual({
    auto: false,
    modules: ["src/plugins/*.ts"],
    node: "/usr/local/bin/node",
    nodeVersion: ">=24.13.1",
    packaging: "beside",
    speculativeStart: true,
  });
  // scriptc.wasm keeps its lenient reading.
  expect(c.wasm).toEqual(["/project/build/a.wasm"]);
});

test("unknown keys and values are SC8004, located at the key", () => {
  const text = JSON.stringify(
    {
      name: "app",
      scriptc: {
        packages: {
          encoding: "unloded",
          debug: { run: "node", evaluate: "later", color: true },
          ms: 3,
        },
        nodeIslands: { auto: "yes", mode: "auto", modules: "src/x.ts", packaging: "zip" },
      },
    },
    null,
    2,
  );
  const c = parseProjectConfig(manifest, text);
  expect(c.diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["SC8004", `package.json 'scriptc.packages.encoding' has the unknown value "unloded"`],
    ["SC8004", `package.json 'scriptc.packages.debug.evaluate' has the unknown value "later"`],
    ["SC8004", "package.json 'scriptc.packages.debug.color' is not a known package setting"],
    ["SC8004", "package.json 'scriptc.packages.ms' must be a string or an object, not 3"],
    ["SC8004", `package.json 'scriptc.nodeIslands.auto' must be true or false, not "yes"`],
    ["SC8004", "package.json 'scriptc.nodeIslands.mode' is not a known Node island setting"],
    [
      "SC8004",
      `package.json 'scriptc.nodeIslands.modules' must be an array of module paths or globs, not "src/x.ts"`,
    ],
    ["SC8004", `package.json 'scriptc.nodeIslands.packaging' has the unknown value "zip"`],
  ]);
  // Locations point at the offending key inside the scriptc object.
  const at = (i: number) => text.slice(c.diagnostics[i]!.loc.start).split(":")[0];
  expect(at(0)).toBe('"encoding"');
  expect(at(1)).toBe('"evaluate"');
  expect(at(5)).toBe('"mode"');
  for (const d of c.diagnostics) expect(d.loc.file).toBe(manifest);
  // Invalid entries are not applied; valid siblings are.
  expect(c.packages.has("encoding")).toBe(false);
  expect(c.packages.has("debug")).toBe(false);
  expect(c.nodeIslands.auto).toBe(true);
});

test("a non-object packages or nodeIslands value is SC8004", () => {
  expect(config({ packages: ["a"] }).diagnostics.map((d) => d.message)).toEqual([
    "package.json 'scriptc.packages' must be an object mapping package names to settings, not an array",
  ]);
  expect(config({ nodeIslands: true }).diagnostics.map((d) => d.message)).toEqual([
    "package.json 'scriptc.nodeIslands' must be an object, not true",
  ]);
  // Other keys of the scriptc object belong to other readers.
  expect(config({ somethingElse: 1 }).diagnostics).toEqual([]);
});

test("package setting keys named like Object.prototype members are unknown settings", () => {
  const c = config({ packages: { debug: { constructor: "node", toString: "node" } } });
  expect(c.diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["SC8004", "package.json 'scriptc.packages.debug.constructor' is not a known package setting"],
    ["SC8004", "package.json 'scriptc.packages.debug.toString' is not a known package setting"],
  ]);
  expect(c.packages.has("debug")).toBe(false);
});
