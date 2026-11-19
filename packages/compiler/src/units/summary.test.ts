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
    pins: {
      functions: [
        { module: "a.ts", name: "f" },
        { module: "main.ts", name: "main" },
      ],
    },
    lowering: {
      declarations: [
        { module: "a.ts", name: "f", kind: "function", facts: "{}" },
        { module: "main.ts", name: "main", kind: "function", facts: "{}" },
      ],
      exports: [
        { module: "a.ts", names: ["f"] },
        { module: "main.ts", names: [] },
      ],
      generics: {
        functions: [{ module: "a.ts", name: "id", qualified: "%m1.id" }],
        classes: [],
        demands: [
          { kind: "function", generic: "%m1.id", instance: "%m1.id%0", ownerModule: "main.ts" },
        ],
      },
      inits: [
        { module: "main.ts", name: "%init.0" },
        { module: "a.ts", name: "%init.1" },
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

test("a unit's summary holds only its modules, with demands attributed to their units", () => {
  const summary = buildUnitSummary(node, observation(), (module) =>
    module === "main.ts"
      ? "app@1.0.0"
      : module === "a.ts" || module === "b.ts"
        ? "lib@1.0.0"
        : null,
  );
  expect(summary.schema).toBe("scriptc.unit-summary.v1");
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
  // The pins name the functions this unit defines and its classes' ids.
  expect(summary.pins.functions).toEqual(["f"]);
  expect(summary.pins.classes).toEqual([{ name: "%m1.A", id: 0 }]);
  expect(summary.runtimeFeatures.scope).toBe("program-wide");
  expect(Object.keys(summary.facts)).toEqual(["reads-exit-code"]);
});

test("the summary's canonical text is stable across key order", () => {
  const first = buildUnitSummary(node, observation(), () => "lib@1.0.0");
  const second = buildUnitSummary(node, observation(), () => "lib@1.0.0");
  expect(summaryText(first)).toBe(summaryText(second));
});
