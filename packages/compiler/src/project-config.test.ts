import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseProjectConfig, readProjectConfig } from "./project-config.js";

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

test("readProjectConfig reads the nearest package.json like parseProjectConfig", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-project-config-"));
  try {
    const manifests = [
      '{ "name": "app", "type": "module" }',
      '{ "name": "app", "\\u0073criptc": { "packages": { "encoding": "unloaded" } } }',
      '{ "name": "app", "scriptc": { "packages": { "encoding": "unloaded", "x": "bogus" } } }',
    ];
    manifests.forEach((text, i) => {
      const dir = join(root, `p${i}`, "src");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, `p${i}`, "package.json"), text);
      const read = readProjectConfig(join(dir, "main.ts"));
      const parsed = parseProjectConfig(join(root, `p${i}`, "package.json"), text);
      expect(read.manifest).toBe(parsed.manifest);
      expect(read.manifestText).toBe(text);
      expect([...read.packages]).toEqual([...parsed.packages]);
      expect(read.nodeIslands).toEqual(parsed.nodeIslands);
      expect(read.diagnostics).toEqual(parsed.diagnostics);
    });
    expect(
      readProjectConfig(join(root, "p1", "src", "main.ts")).packages.get("encoding")?.unloaded,
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    shapes: true,
    run: "node",
    evaluate: "lazy",
    share: "duplicate",
    marshal: "copy",
    schedule: "lockstep",
  });
});

test("shapes: false turns off the shape overlay for one package", () => {
  const c = config({
    packages: {
      zod: { shapes: false },
      effect: { shapes: true, run: "native" },
      ms: { shapes: "no" },
    },
  });
  expect(c.packages.get("zod")?.shapes).toBe(false);
  expect(c.packages.get("zod")?.run).toBe("auto");
  expect(c.packages.get("effect")?.shapes).toBe(true);
  expect(c.packages.get("effect")?.run).toBe("native");
  expect(c.packages.has("ms")).toBe(false);
  expect(c.diagnostics.map((d) => d.message)).toEqual([
    `package.json 'scriptc.packages.ms.shapes' must be true or false, not "no"`,
  ]);
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

test("typePatches: entries keyed by package and range", () => {
  const c = config({
    typePatches: {
      "commander@^15.0.0": { declarations: { "HelpContext.helpWidth": "| undefined" } },
      "@scope/lib@1.x || 2.x": {
        declarations: { "Options.name": "string | null" },
        note: "https://example.invalid/issue/1",
      },
    },
  });
  expect(c.diagnostics).toEqual([]);
  expect(
    c.typePatches.map(({ key, pkg, range, declarations }) => ({
      key,
      pkg,
      range,
      declarations: declarations.map((d) => [d.selector, d.type]),
    })),
  ).toEqual([
    {
      key: "commander@^15.0.0",
      pkg: "commander",
      range: "^15.0.0",
      declarations: [["HelpContext.helpWidth", "| undefined"]],
    },
    {
      key: "@scope/lib@1.x || 2.x",
      pkg: "@scope/lib",
      range: "1.x || 2.x",
      declarations: [["Options.name", "string | null"]],
    },
  ]);
  expect(c.typePatches[0]!.declarations[0]!.offset).toBeGreaterThan(0);
});

test("typePatches: malformed keys, ranges, selectors and types are SC8004", () => {
  const c = config({
    typePatches: {
      commander: { declarations: { "A.b": "| undefined" } },
      "ms@^banana": { declarations: {} },
      "@types/node@*": { declarations: {} },
      "typescript@5": { declarations: {} },
      "lib@^1.0.0": {
        declarations: {
          "1bad": "| undefined",
          "A.b": 3,
          "A.c": "string\nnumber",
          "A.d": "| undefined",
        },
        patches: {},
      },
      "other@^1.0.0": [],
    },
  });
  expect(c.diagnostics.every((d) => d.code === "SC8004")).toBe(true);
  expect(c.diagnostics.map((d) => d.message)).toEqual([
    "package.json 'scriptc.typePatches.commander' must name a package and a version range",
    `package.json 'scriptc.typePatches.ms@^banana' has the version range "^banana", which is not a semver range`,
    "package.json 'scriptc.typePatches.@types/node@*' patches @types/node, whose declarations ship with scriptc or TypeScript",
    "package.json 'scriptc.typePatches.typescript@5' patches typescript, whose declarations ship with scriptc or TypeScript",
    "package.json 'scriptc.typePatches.lib@^1.0.0.patches' is not a known type patch setting",
    "package.json 'scriptc.typePatches.lib@^1.0.0.declarations.1bad' is not a selector: it must start with a declared name, 'export=' or 'default'",
    "package.json 'scriptc.typePatches.lib@^1.0.0.declarations.A.b' must map to a type string, not 3",
    "package.json 'scriptc.typePatches.lib@^1.0.0.declarations.A.c' has a type that must be one line",
    "package.json 'scriptc.typePatches.other@^1.0.0' must be an object, not an array",
  ]);
  // The valid selector of an entry with an unknown key is dropped with it;
  // entries with only bad selectors keep their valid ones.
  expect(c.typePatches).toEqual([]);
  const partial = config({
    typePatches: {
      "lib@^1.0.0": { declarations: { "1bad": "| undefined", "A.d": "| undefined" } },
    },
  });
  expect(partial.typePatches[0]!.declarations.map((d) => d.selector)).toEqual(["A.d"]);
});

test("typePatches: files and types name local declaration files", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-project-config-"));
  try {
    mkdirSync(join(root, "patches"));
    writeFileSync(join(root, "patches", "entry.d.ts"), "export {};\n");
    const text = JSON.stringify({
      scriptc: {
        typePatches: {
          "lib@^1.0.0": {
            files: {
              "dist/entry.d.ts": "./patches/entry.d.ts",
              "@types/lib/index.d.ts": "patches/entry.d.ts",
              "dist/index.js": "./patches/entry.d.ts",
              "../outside.d.ts": "./patches/entry.d.ts",
              "dist/other.d.ts": "./patches/missing.d.ts",
            },
            types: "./patches/entry.d.ts",
          },
          "other@^1.0.0": { types: "./patches/entry.ts" },
        },
      },
    });
    const c = parseProjectConfig(join(root, "package.json"), text);
    expect(c.diagnostics.map((d) => d.message)).toEqual([
      "package.json 'scriptc.typePatches.lib@^1.0.0.files.dist/index.js' must name a declaration file inside the package",
      "package.json 'scriptc.typePatches.lib@^1.0.0.files.../outside.d.ts' must name a declaration file inside the package",
      `package.json 'scriptc.typePatches.lib@^1.0.0.files.dist/other.d.ts' names "./patches/missing.d.ts", which does not exist`,
      `package.json 'scriptc.typePatches.other@^1.0.0.types' names "./patches/entry.ts", which is not a declaration file`,
    ]);
    const entry = c.typePatches.find((e) => e.pkg === "lib")!;
    expect([...entry.files]).toEqual([
      ["dist/entry.d.ts", join(root, "patches/entry.d.ts")],
      ["@types/lib/index.d.ts", join(root, "patches/entry.d.ts")],
    ]);
    expect(entry.types).toBe(join(root, "patches/entry.d.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readProjectConfig checks local type patch files again for an unchanged package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-project-config-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scriptc: { typePatches: { "lib@^1.0.0": { types: "./lib.d.ts" } } } }),
    );
    const entry = join(root, "main.ts");
    const missing = readProjectConfig(entry);
    expect(missing.diagnostics.map((d) => d.message)).toEqual([
      `package.json 'scriptc.typePatches.lib@^1.0.0.types' names "./lib.d.ts", which does not exist`,
    ]);
    expect(readProjectConfig(entry)).toBe(missing);
    writeFileSync(join(root, "lib.d.ts"), "export {};\n");
    const created = readProjectConfig(entry);
    expect(created.diagnostics).toEqual([]);
    expect(created.typePatches[0]!.types).toBe(join(root, "lib.d.ts"));
    expect(readProjectConfig(entry)).toBe(created);
    rmSync(join(root, "lib.d.ts"));
    expect(readProjectConfig(entry).diagnostics.map((d) => d.code)).toEqual(["SC8004"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
