import { expect, test } from "vitest";
import { scriptcConditionFirst, scriptcConditionManifest } from "./scriptc-condition.js";

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
