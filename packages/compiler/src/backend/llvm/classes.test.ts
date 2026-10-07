import { expect, test } from "vitest";
import type { IrModule } from "../../ir/ir.js";
import { buildClassGraph, classMembershipIntervals, emitClassMembershipHelper } from "./classes.js";

const loc = { file: "class-membership.ts", start: 0, end: 1 };

function graph() {
  const classes = [
    { name: "Root" },
    { name: "Pair", base: "Root" },
    { name: "Flipped", base: "Pair" },
    { name: "PairNumber", base: "Pair", genericOf: "Pair" },
    { name: "FlippedNumber", base: "PairNumber", genericOf: "Flipped" },
    { name: "Child", base: "FlippedNumber" },
    { name: "Other", base: "PairNumber" },
    { name: "PairString", base: "Pair", genericOf: "Pair" },
    { name: "FlippedString", base: "PairString", genericOf: "Flipped" },
  ];
  const mod: IrModule = {
    irVersion: 13,
    sourceFile: loc.file,
    entry: "main",
    functions: [],
    classes: classes.map((cls) => ({ ...cls, fields: [], methods: [], loc })),
  };
  return buildClassGraph(mod, new Map());
}

test("nominal family ranges include specialized descendants without admitting intervening classes", () => {
  const classes = graph();
  const contains = (target: string, member: string) =>
    classMembershipIntervals(classes, target).some(
      (range) => range.pre <= classes.get(member)!.pre && classes.get(member)!.pre <= range.post,
    );
  for (const member of ["Flipped", "FlippedNumber", "FlippedString", "Child"])
    expect(contains("Flipped", member), member).toBe(true);
  for (const member of ["Root", "Pair", "PairNumber", "PairString", "Other"])
    expect(contains("Flipped", member), member).toBe(false);
  expect(classes.get("FlippedNumber")!.base!.def.name).toBe("PairNumber");
  expect(classes.get("FlippedNumber")!.root.def.name).toBe("Root");
  expect(classMembershipIntervals(classes, "Flipped")).toHaveLength(3);
});

test.each(["i32", "i64"])(
  "class-value membership keeps disjoint family ranges on %s targets",
  (size) => {
    const classes = graph();
    const helper = emitClassMembershipHelper(classes, size).join("\n");
    expect(helper).toContain(`switch ${size} %pre`);
    expect(helper).toContain(`icmp uge ${size} %value`);
    expect(helper).toContain("label %ordinary");
    expect(helper).toContain("or i1");
    const ordinary: IrModule = {
      irVersion: 13,
      sourceFile: loc.file,
      entry: "main",
      functions: [],
      classes: [
        { name: "Base", fields: [], methods: [], loc },
        { name: "Child", base: "Base", fields: [], methods: [], loc },
      ],
    };
    expect(emitClassMembershipHelper(buildClassGraph(ordinary, new Map()), size)).toEqual([]);
  },
);
