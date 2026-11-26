import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configurePreferredConditions,
  scriptcConditionFirst,
  scriptcConditionManifest,
} from "./scriptc-condition.js";

test("the scriptc entry leads, behind a types entry where types is matched", () => {
  const entries: [string, unknown][] = [
    ["node", "./node.js"],
    ["default", "./default.js"],
    ["types", "./index.d.ts"],
    ["scriptc", "./scriptc.js"],
  ];
  expect(scriptcConditionFirst(entries, true).map(([key]) => key)).toEqual([
    "types",
    "scriptc",
    "node",
    "default",
  ]);
  expect(scriptcConditionFirst(entries, false).map(([key]) => key)).toEqual([
    "scriptc",
    "node",
    "default",
    "types",
  ]);
  const without: [string, unknown][] = [["default", "./default.js"]];
  expect(scriptcConditionFirst(without, true)).toBe(without);
});

test("the served manifest answers the scriptc target under the checker's keys", () => {
  const served = scriptcConditionManifest(
    JSON.stringify({
      name: "adapter-app",
      scriptc: { packages: {} },
      exports: {
        ".": { default: "./index.js", scriptc: "./adapter.js", types: "./index.d.ts" },
        "./sub": { scriptc: { import: "./sub.mjs", require: "./sub.cjs" }, default: "./x.js" },
        "./plain": "./plain.js",
      },
      imports: { "#impl": { default: "./a.js", scriptc: "./b.js" } },
    }),
  );
  expect(served).not.toBeNull();
  const doc = JSON.parse(served!) as Record<string, Record<string, unknown>>;
  expect(Object.entries(doc["exports"]!["."] as object)).toEqual([
    ["types", "./index.d.ts"],
    ["scriptc", "./adapter.js"],
    ["import", "./adapter.js"],
    ["require", "./adapter.js"],
    ["default", "./adapter.js"],
  ]);
  const nested = { import: "./sub.mjs", require: "./sub.cjs" };
  expect(doc["exports"]!["./sub"]).toEqual({
    scriptc: nested,
    import: nested,
    require: nested,
    default: nested,
  });
  expect(doc["exports"]!["./plain"]).toBe("./plain.js");
  expect(Object.keys(doc["imports"]!["#impl"] as object)).toEqual([
    "scriptc",
    "import",
    "require",
    "default",
  ]);
  // The project configuration key is not a condition and stays as written.
  expect(doc["scriptc"]).toEqual({ packages: {} });
});

test("a manifest without a scriptc condition is served as written", () => {
  expect(scriptcConditionManifest('{"exports":{".":{"default":"./a.js"}}}')).toBeNull();
  expect(scriptcConditionManifest('{"scriptc":{"packages":{}},"exports":"./a.js"}')).toBeNull();
  expect(scriptcConditionManifest('{"exports": {"scriptc": ')).toBeNull();
});

test("a configured condition supplies the scriptc branch of the package it names", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-preferred-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scriptc: { packages: { rxjs: { conditions: ["module", "es2015"] } } } }),
    );
    configurePreferredConditions(join(dir, "main.ts"));
    const rxjs = {
      name: "rxjs",
      exports: {
        ".": {
          types: "./index.d.ts",
          node: "./cjs.js",
          require: "./cjs.js",
          es2015: "./esm.js",
          default: "./esm5.js",
        },
        "./sub": { scriptc: "./own.js", es2015: "./sub-esm.js", default: "./sub.js" },
        "./plain": "./plain.js",
      },
    };
    const served = JSON.parse(scriptcConditionManifest(JSON.stringify(rxjs))!) as {
      exports: Record<string, unknown>;
    };
    // The first listed condition the object has answers under the
    // checker's keys, behind types.
    expect(served.exports["."]).toEqual({
      types: "./index.d.ts",
      scriptc: "./esm.js",
      import: "./esm.js",
      require: "./esm.js",
      default: "./esm.js",
      node: "./cjs.js",
      es2015: "./esm.js",
    });
    // A branch the package publishes itself is kept.
    expect((served.exports["./sub"] as Record<string, unknown>)["scriptc"]).toBe("./own.js");
    expect(served.exports["./plain"]).toBe("./plain.js");
    // Another package is served as written.
    const other = { name: "other", exports: { ".": rxjs.exports["."] } };
    expect(scriptcConditionManifest(JSON.stringify(other))).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    configurePreferredConditions(join(tmpdir(), "no-project", "main.ts"));
  }
});
