import { expect, test } from "vitest";
import { buildUnitSummary, classNumbering, summaryText } from "./summary.js";
import type { UnitNode, UnitObservation } from "./types.js";

test("class numbering is the backend's preorder and only redeclared methods take slots", () => {
  const numbering = classNumbering([
    { name: "A", methods: ["go", "stay"] },
    { name: "B", base: "A", methods: ["go"] },
    { name: "C", base: "A" },
    { name: "D", methods: ["go"] },
  ]);
  expect(numbering.get("A")).toEqual({ id: 0, slots: ["go"] });
  expect(numbering.get("B")).toEqual({ id: 1, slots: [] });
  expect(numbering.get("C")).toEqual({ id: 2, slots: [] });
  // D is a second root: preorder continues after A's subtree.
  expect(numbering.get("D")).toEqual({ id: 3, slots: [] });
});

const node: UnitNode = {
  id: "lib@1.0.0",
  name: "lib",
  version: "1.0.0",
  app: false,
  files: ["a.ts", "b.ts"],
  dependencies: [],
  mergedFrom: ["lib@1.0.0"],
};

function observation(): UnitObservation {
  return {
    entry: "/app/main.ts",
    files: [
      {
        file: "/app/node_modules/lib/a.ts",
        relative: "a.ts",
        packageName: "lib",
        packageVersion: "1.0.0",
        packageRoot: "/app/node_modules/lib",
        digest: "1".repeat(64),
      },
      {
        file: "/app/node_modules/lib/b.ts",
        relative: "b.ts",
        packageName: "lib",
        packageVersion: "1.0.0",
        packageRoot: "/app/node_modules/lib",
        digest: "2".repeat(64),
      },
      {
        file: "/app/main.ts",
        relative: "main.ts",
        packageName: "app",
        packageVersion: "1.0.0",
        packageRoot: "/app",
        digest: "3".repeat(64),
      },
    ],
    edges: [],
    lowering: {
      declarations: [
        {
          file: "/app/node_modules/lib/a.ts",
          module: "a.ts",
          name: "f",
          kind: "function",
          facts: "{}",
        },
        { file: "/app/main.ts", module: "main.ts", name: "main", kind: "function", facts: "{}" },
      ],
      exports: [
        { file: "/app/node_modules/lib/a.ts", module: "a.ts", names: ["f"] },
        { file: "/app/main.ts", module: "main.ts", names: [] },
      ],
      generics: {
        functions: [
          { file: "/app/node_modules/lib/a.ts", module: "a.ts", name: "id", qualified: "%m1.id" },
        ],
        classes: [],
        demands: [
          {
            kind: "function",
            generic: "%m1.id",
            instance: "%m1.id%0",
            ownerModule: "main.ts",
            ownerFile: "/app/main.ts",
          },
        ],
      },
      inits: [
        { file: "/app/main.ts", module: "main.ts", name: "%init.0" },
        { file: "/app/node_modules/lib/a.ts", module: "a.ts", name: "%init.1" },
      ],
      facts: { "reads-exit-code": { value: "false", setByOwnFiles: "unobserved" } },
    },
    classes: [
      { file: "/app/node_modules/lib/a.ts", name: "%m1.A", id: 0, slots: ["go"] },
      { file: "/app/main.ts", name: "B", id: 1, slots: [] },
    ],
    runtimeFeatures: { intl: false },
  };
}

const unitOfFile = (file: string): string | null =>
  file === "/app/main.ts"
    ? "app@1.0.0"
    : file.startsWith("/app/node_modules/lib/")
      ? "lib@1.0.0"
      : null;
const libMembers = new Set(["/app/node_modules/lib/a.ts", "/app/node_modules/lib/b.ts"]);

test("a unit's summary holds only its files, with demands attributed to their units", () => {
  const summary = buildUnitSummary(node, observation(), libMembers, unitOfFile);
  expect(summary.schema).toBe("scriptc.unit-summary.v0");
  expect(summary.unit.id).toBe("lib@1.0.0");
  // The unit's graph dependencies are the meta entry's, not the summary's:
  // a summary is a function of the unit's own content.
  expect("dependencies" in summary.unit).toBe(false);
  expect(summary.files).toEqual(["a.ts", "b.ts"]);
  expect(summary.declarations.map((declaration) => declaration.name)).toEqual(["f"]);
  expect(summary.exports).toEqual({ "a.ts": ["f"] });
  expect(summary.generics.functions[0]!.demanded).toEqual([
    { instance: "%m1.id%0", by: "app@1.0.0", byModule: "main.ts" },
  ]);
  expect(summary.classes).toEqual([{ module: "a.ts", name: "%m1.A", id: 0, slots: ["go"] }]);
  expect(summary.inits.map((init) => init.module).sort()).toEqual(["a.ts"]);
  expect(summary.runtimeFeatures.scope).toBe("program-wide");
  expect(Object.keys(summary.facts)).toEqual(["reads-exit-code"]);
});

test("the summary's canonical text is stable across key order", () => {
  const first = buildUnitSummary(node, observation(), libMembers, unitOfFile);
  const second = buildUnitSummary(node, observation(), libMembers, unitOfFile);
  expect(summaryText(first)).toBe(summaryText(second));
});

test("two packages that both contain index.ts keep their own declarations and exports", () => {
  const x = "/app/node_modules/x/index.ts";
  const y = "/app/node_modules/y/index.ts";
  const observation: UnitObservation = {
    entry: "/app/main.ts",
    files: [
      {
        file: x,
        relative: "index.ts",
        packageName: "x",
        packageVersion: "1.0.0",
        packageRoot: "/app/node_modules/x",
        digest: "1".repeat(64),
      },
      {
        file: y,
        relative: "index.ts",
        packageName: "y",
        packageVersion: "1.0.0",
        packageRoot: "/app/node_modules/y",
        digest: "2".repeat(64),
      },
    ],
    edges: [],
    lowering: {
      declarations: [
        { file: x, module: "index.ts", name: "fx", kind: "function", facts: "{}" },
        { file: y, module: "index.ts", name: "fy", kind: "function", facts: "{}" },
      ],
      exports: [
        { file: x, module: "index.ts", names: ["fx"] },
        { file: y, module: "index.ts", names: ["fy"] },
      ],
      generics: { functions: [], classes: [], demands: [] },
      inits: [
        { file: x, module: "index.ts", name: "%init.1" },
        { file: y, module: "index.ts", name: "%init.2" },
      ],
      facts: {},
    },
    classes: [],
    runtimeFeatures: { intl: false },
  };
  const xNode: UnitNode = {
    id: "x@1.0.0",
    name: "x",
    version: "1.0.0",
    app: false,
    files: ["index.ts"],
    dependencies: [],
    mergedFrom: ["x@1.0.0"],
  };
  const yNode: UnitNode = { ...xNode, id: "y@1.0.0", name: "y" };
  const byFile = (file: string): string | null =>
    file === x ? "x@1.0.0" : file === y ? "y@1.0.0" : null;
  const xs = buildUnitSummary(xNode, observation, new Set([x]), byFile);
  const ys = buildUnitSummary(yNode, observation, new Set([y]), byFile);
  expect(xs.declarations.map((declaration) => declaration.name)).toEqual(["fx"]);
  expect(xs.exports).toEqual({ "index.ts": ["fx"] });
  expect(xs.inits).toEqual([{ module: "index.ts", name: "%init.1" }]);
  expect(ys.declarations.map((declaration) => declaration.name)).toEqual(["fy"]);
  expect(ys.exports).toEqual({ "index.ts": ["fy"] });
  expect(ys.inits).toEqual([{ module: "index.ts", name: "%init.2" }]);
});
