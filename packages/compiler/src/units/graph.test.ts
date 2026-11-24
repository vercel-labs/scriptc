import { expect, test } from "vitest";
import { buildUnitGraph } from "./graph.js";
import type { UnitFileInput, UnitObservationInput } from "./types.js";

function file(
  file: string,
  packageName: string | null,
  packageVersion: string | null,
  packageRoot: string | null,
  relative: string,
  digest = "0".repeat(64),
): UnitFileInput {
  return { file, relative, packageName, packageVersion, packageRoot, digest };
}

const app: UnitFileInput = file("/app/main.ts", "app", "1.0.0", "/app", "main.ts");
const lib: UnitFileInput = file(
  "/app/node_modules/lib/index.ts",
  "lib",
  "2.0.0",
  "/app/node_modules/lib",
  "index.ts",
);

test("units are packages, dependencies first, the entry's package marked app", () => {
  const input: UnitObservationInput = {
    entry: app.file,
    files: [app, lib],
    edges: [{ from: app.file, to: lib.file }],
  };
  const graph = buildUnitGraph(input);
  expect(graph.units.map((unit) => unit.id)).toEqual(["lib@2.0.0", "app@1.0.0"]);
  expect(graph.units[0]!.app).toBe(false);
  expect(graph.units[0]!.files).toEqual(["index.ts"]);
  expect(graph.units[1]!.app).toBe(true);
  expect(graph.units[1]!.dependencies).toEqual(["lib@2.0.0"]);
  expect(graph.stats).toEqual({ files: 2, units: 2, edges: 1, mergedUnits: 0 });
});

test("a dependency cycle merges its strongly connected component", () => {
  const a = file("/app/node_modules/a/index.ts", "a", "1.0.0", "/app/node_modules/a", "index.ts");
  const b = file("/app/node_modules/b/index.ts", "b", "1.0.0", "/app/node_modules/b", "index.ts");
  const input: UnitObservationInput = {
    entry: app.file,
    files: [app, a, b],
    edges: [
      { from: app.file, to: a.file },
      { from: a.file, to: b.file },
      { from: b.file, to: a.file },
    ],
  };
  const graph = buildUnitGraph(input);
  expect(graph.units.map((unit) => unit.id)).toEqual(["a@1.0.0+b@1.0.0", "app@1.0.0"]);
  expect(graph.sccMerges).toEqual([{ id: "a@1.0.0+b@1.0.0", members: ["a@1.0.0", "b@1.0.0"] }]);
  expect(graph.units[0]!.mergedFrom).toEqual(["a@1.0.0", "b@1.0.0"]);
  expect(graph.units[0]!.files).toEqual(["index.ts"]);
  expect(graph.units[1]!.dependencies).toEqual(["a@1.0.0+b@1.0.0"]);
});

test("two copies of one version stay distinct without an absolute path", () => {
  const copyA = file(
    "/app/node_modules/x/index.ts",
    "x",
    "1.0.0",
    "/app/node_modules/x",
    "index.ts",
  );
  const copyB = file(
    "/app/node_modules/a/node_modules/x/index.ts",
    "x",
    "1.0.0",
    "/app/node_modules/a/node_modules/x",
    "index.ts",
  );
  const graph = buildUnitGraph({
    entry: app.file,
    files: [app, copyA, copyB],
    edges: [
      { from: app.file, to: copyA.file },
      { from: copyA.file, to: copyB.file },
    ],
  });
  const ids = graph.units.map((unit) => unit.id);
  expect(ids).toHaveLength(3);
  expect(ids.filter((id) => id.startsWith("x@1.0.0"))).toHaveLength(2);
  expect(ids.some((id) => id.includes("/"))).toBe(false);
});

test("the app's own copy never takes a dependency's plain id", () => {
  const appCopy = file(
    "/app/node_modules/self/index.ts",
    "self",
    "1.0.0",
    "/app/node_modules/self",
    "index.ts",
  );
  const depCopy = file(
    "/app/node_modules/dep/node_modules/self/index.ts",
    "self",
    "1.0.0",
    "/app/node_modules/dep/node_modules/self",
    "index.ts",
  );
  const graph = buildUnitGraph({
    entry: appCopy.file,
    files: [appCopy, depCopy],
    edges: [{ from: appCopy.file, to: depCopy.file }],
  });
  expect(graph.units[0]!.id).toBe("self@1.0.0");
  expect(graph.units[0]!.app).toBe(false);
  expect(graph.units[1]!.app).toBe(true);
  expect(graph.units[1]!.id).toMatch(/^self@1\.0\.0#/);
});

test("the same input gives the same graph", () => {
  const input: UnitObservationInput = {
    entry: app.file,
    files: [app, lib],
    edges: [
      { from: app.file, to: lib.file },
      { from: lib.file, to: app.file },
    ],
  };
  expect(buildUnitGraph(input)).toEqual(buildUnitGraph(structuredClone(input)));
});
