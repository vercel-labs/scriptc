import { describe, expect, test } from "vitest";
import { BOOL, F64, NULL_T, STRING, UNDEFINED_T, typeEquals, typeKey } from "../../ir/ir.js";
import type { IrRecordShape, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";
import { planUnionRetag, buildUnionRetag, planRecordUnionWrap } from "./union-retag.js";
import type { UnionRetagArm } from "./union-retag.js";
import type { WidthLift } from "./width-lift.js";

const loc: SrcLoc = { file: "retag.ts", start: 0, end: 1 };
const record = (shapeId: string): IrType => ({ kind: "record", shapeId });

function fixture(
  fieldType: IrType = STRING,
  values: (string | number | boolean)[] = ["left", "right"],
) {
  const shapes: IrRecordShape[] = [
    {
      id: "r0",
      fields: [
        { name: "kind", type: fieldType },
        { name: "left", type: F64 },
        { name: "right", type: F64 },
      ],
    },
    {
      id: "r1",
      fields: [
        { name: "kind", type: fieldType },
        { name: "left", type: F64 },
      ],
    },
    {
      id: "r2",
      fields: [
        { name: "kind", type: fieldType },
        { name: "right", type: F64 },
      ],
    },
  ];
  const from: IrUnionDef = {
    id: "u0",
    arms: [record("r0"), UNDEFINED_T],
    discriminant: { field: "kind", cases: [{ tag: 0, values }] },
  };
  const to: IrUnionDef = {
    id: "u1",
    arms: [record("r1"), record("r2"), UNDEFINED_T],
    discriminant: {
      field: "kind",
      cases: [
        { tag: 0, values: [values[0]!] },
        { tag: 1, values: [values[1]!] },
      ],
    },
  };
  const shapeOf = (id: string) => shapes.find((shape) => shape.id === id);
  const lift = (source: IrType, target: IrType): WidthLift | null => {
    if (typeEquals(source, target)) return { how: "copy" };
    if (source.kind === "record" && target.kind === "record") {
      const src = shapeOf(source.shapeId),
        dst = shapeOf(target.shapeId);
      if (
        src &&
        dst &&
        dst.fields.every((field) =>
          src.fields.some((old) => old.name === field.name && typeEquals(old.type, field.type)),
        )
      ) {
        return { how: "width" };
      }
    }
    if (target.kind === "union") {
      const candidates = to.arms
        .map((arm, tag) => ({ arm, tag }))
        .filter(({ arm }) => lift(source, arm) !== null);
      if (candidates.length === 1)
        return { how: "liftWrap", tag: candidates[0]!.tag, arm: candidates[0]!.arm };
    }
    return null;
  };
  const plan = (trappable?: ReadonlySet<number>) =>
    planUnionRetag(from, to, shapeOf, lift, trappable);
  return { from, to, shapes, shapeOf, lift, plan };
}

function split(plan: UnionRetagArm[] | null) {
  expect(plan).not.toBeNull();
  const first = plan![0]!;
  if (first.kind !== "discriminant") throw new Error("expected discriminant plan");
  return first;
}

describe("record conversion with shared layouts", () => {
  test.each([
    [STRING, ["binary", "logical"]],
    [F64, [0, 1]],
    [BOOL, [false, true]],
  ] as [IrType, (string | number | boolean)[]][])(
    "selects %j variants by their value",
    (type, values) => {
      const f = fixture(type, values);
      f.shapes[2]!.fields = f.shapes[1]!.fields.slice();
      expect(planRecordUnionWrap(f.shapes[1]!, f.to, f.shapeOf)).toEqual({
        field: "kind",
        fieldType: type,
        routes: [
          { tag: 0, lift: { how: "copy" }, values: [values[0]] },
          { tag: 1, lift: { how: "width" }, values: [values[1]] },
        ],
      });
      // Re-read registry definitions: a later field incompatibility must
      // invalidate a previously possible shared-layout conversion.
      f.shapes[2]!.fields = [
        { name: "kind", type },
        { name: "left", type: STRING },
      ];
      expect(planRecordUnionWrap(f.shapes[1]!, f.to, f.shapeOf)).toBeNull();
    },
  );

  test("requires unambiguous literal ownership and matching field order", () => {
    const f = fixture();
    f.shapes[2]!.fields = f.shapes[1]!.fields.slice();
    f.to.discriminant!.cases[1]!.values = ["left"];
    expect(planRecordUnionWrap(f.shapes[1]!, f.to, f.shapeOf)).toBeNull();
    f.to.discriminant!.cases[1]!.values = ["right"];
    f.shapes[2]!.fields.reverse();
    expect(planRecordUnionWrap(f.shapes[1]!, f.to, f.shapeOf)).toBeNull();
  });
});

describe("union conversion planning", () => {
  test("matches large unions in source order, including duplicate destination arms", () => {
    const arms: IrType[] = Array.from({ length: 48 }, (_, index) => record(`r${index}`));
    const from: IrUnionDef = { id: "large-from", arms };
    const to: IrUnionDef = {
      id: "large-to",
      arms: [record("r7"), ...arms.slice().reverse(), record("r7")],
    };
    const plan = planUnionRetag(
      from,
      to,
      () => undefined,
      () => null,
    );
    expect(plan).toEqual(
      arms.map((source) => ({
        kind: "direct",
        route: {
          tag: to.arms.findIndex((arm) => typeEquals(arm, source)),
          lift: { how: "copy" },
          values: [],
        },
      })),
    );
    to.arms = to.arms.filter((arm) => !typeEquals(arm, arms[11]!));
    expect(
      planUnionRetag(
        from,
        to,
        () => undefined,
        () => null,
      ),
    ).toBeNull();
    expect(
      planUnionRetag(
        from,
        to,
        () => undefined,
        () => null,
        new Set([11]),
      )?.[11],
    ).toEqual({ kind: "trap" });
  });

  test("checks exact ABI equality within type-key collisions", () => {
    const fixed: IrType = { kind: "func", params: [STRING], ret: F64 };
    const withArguments: IrType = { kind: "func", params: [STRING], ret: F64, argumentsAll: true };
    expect(typeKey(fixed)).toBe(typeKey(withArguments));
    expect(typeEquals(fixed, withArguments)).toBe(false);
    const padding: IrType[] = Array.from({ length: 12 }, (_, index) => record(`r${index}`));
    const from: IrUnionDef = { id: "collision-from", arms: [fixed, withArguments, ...padding] };
    const to: IrUnionDef = { id: "collision-to", arms: [withArguments, fixed, ...padding] };
    expect(
      planUnionRetag(
        from,
        to,
        () => undefined,
        () => null,
      )?.slice(0, 2),
    ).toEqual([
      { kind: "direct", route: { tag: 1, lift: { how: "copy" }, values: [] } },
      { kind: "direct", route: { tag: 0, lift: { how: "copy" }, values: [] } },
    ]);
    to.arms.splice(1, 1);
    expect(
      planUnionRetag(
        from,
        to,
        () => undefined,
        () => null,
      ),
    ).toBeNull();
  });

  test("splits one source layout by semantic kind", () => {
    const f = fixture();
    const arm = split(f.plan());
    expect(arm.field).toBe("kind");
    expect(arm.fieldType).toEqual(STRING);
    expect(arm.routes).toEqual([
      { tag: 0, lift: { how: "width" }, values: ["left"] },
      { tag: 1, lift: { how: "width" }, values: ["right"] },
    ]);
    expect(f.plan()![1]).toEqual({
      kind: "direct",
      route: { tag: 2, lift: { how: "copy" }, values: [] },
    });
  });

  test.each([
    [F64, [0, -1]],
    [F64, [1.5, 2.5]],
    [BOOL, [false, true]],
    [STRING, ["constructor", "__proto__"]],
    [STRING, ["\u0000", '"\\\n']],
  ] as [IrType, (string | number | boolean)[]][])(
    "supports literal comparisons for %j",
    (type, values) => {
      const f = fixture(type, values);
      expect(split(f.plan()).routes.map((route) => route.values)).toEqual([
        [values[0]],
        [values[1]],
      ]);
    },
  );

  test("uses semantic routes even when an exact storage arm exists", () => {
    const f = fixture();
    f.to.arms[0] = record("r0");
    const arm = split(f.plan());
    expect(arm.routes.map((route) => route.lift.how)).toEqual(["copy", "width"]);
    expect(arm.routes.map((route) => route.tag)).toEqual([0, 1]);
  });

  test("retains exact storage when narrowing omits literal cases", () => {
    const f = fixture();
    f.to.arms[1] = record("r0");
    f.to.discriminant!.cases[0]!.values = ["other"];
    f.to.discriminant!.cases[1]!.values = ["left"];
    expect(f.plan()![0]).toEqual({
      kind: "direct",
      route: { tag: 1, lift: { how: "copy" }, values: ["left", "right"] },
    });
  });

  test("combines omitted literal identity with explicit width routes", () => {
    const f = fixture();
    f.to.arms[0] = record("r0");
    f.from.discriminant!.cases[0]!.values.push("omitted");
    expect(split(f.plan()).routes).toEqual([
      { tag: 0, lift: { how: "copy" }, values: ["left", "omitted"] },
      { tag: 1, lift: { how: "width" }, values: ["right"] },
    ]);
  });

  test("coalesces several literals targeting the same layout", () => {
    const f = fixture();
    f.from.discriminant!.cases[0]!.values.push("middle", "middle");
    f.to.discriminant!.cases[0]!.values.push("middle");
    expect(split(f.plan()).routes[0]!.values).toEqual(["left", "middle"]);
  });

  test("does not dispatch when all semantic cases select one destination", () => {
    const f = fixture();
    f.to.discriminant!.cases[0]!.values.push("right");
    f.to.discriminant!.cases[1]!.values = ["unused"];
    expect(f.plan()![0]).toEqual({
      kind: "direct",
      route: { tag: 0, lift: { how: "width" }, values: ["left", "right"] },
    });
  });

  test("refuses a missing destination literal even when a structural choice exists", () => {
    const f = fixture();
    f.to.discriminant!.cases[1]!.values = ["other"];
    expect(f.plan()).toBeNull();
  });

  test("validates every selected layout before succeeding", () => {
    const f = fixture();
    const calls: string[] = [];
    expect(
      planUnionRetag(f.from, f.to, f.shapeOf, (source, target) => {
        if (target.kind !== "record") return null;
        calls.push(target.shapeId);
        return target.shapeId === "r2" ? null : f.lift(source, target);
      }),
    ).toBeNull();
    expect(calls).toEqual(["r1", "r2"]);
  });

  test("declines when any destination payload field is incompatible", () => {
    const f = fixture();
    f.shapes[2]!.fields[1]!.type = STRING;
    expect(f.plan()).toBeNull();
  });

  test("does not retain a successful partial plan after a later rejection", () => {
    const f = fixture();
    f.shapes[2]!.fields[1]!.type = STRING;
    expect(f.plan()).toBeNull();
    f.shapes[2]!.fields[1]!.type = F64;
    expect(split(f.plan()).routes).toHaveLength(2);
    f.shapes[1]!.fields[1]!.type = STRING;
    expect(f.plan()).toBeNull();
  });

  test("does not infer a discriminator from only one union", () => {
    const f = fixture();
    delete f.to.discriminant;
    expect(f.plan()).toBeNull();
    f.to.arms.splice(1, 1);
    expect(f.plan()![0]!.kind).toBe("direct");
  });

  test("keeps ambiguous unannotated structural conversions refused", () => {
    const f = fixture();
    delete f.from.discriminant;
    delete f.to.discriminant;
    expect(f.plan()).toBeNull();
  });

  test("does not match differently named discriminants", () => {
    const f = fixture();
    f.to.discriminant!.field = "mode";
    expect(f.plan()).toBeNull();
  });

  test("preserves exact arms without metadata", () => {
    const f = fixture();
    delete f.from.discriminant;
    delete f.to.discriminant;
    f.to.arms[1] = record("r0");
    expect(f.plan()![0]).toEqual({
      kind: "direct",
      route: { tag: 1, lift: { how: "copy" }, values: [] },
    });
  });

  test("stranded units trap and matching units retain their destination tags", () => {
    const f = fixture();
    f.from.arms.push(NULL_T);
    expect(f.plan()!.at(-1)).toEqual({ kind: "trap" });
    f.to.arms.push(NULL_T);
    expect(f.plan()!.at(-1)).toEqual({
      kind: "direct",
      route: { tag: 3, lift: { how: "copy" }, values: [] },
    });
  });

  test("stranded non-unit arms require site-specific checker evidence", () => {
    const f = fixture();
    f.from.arms.push(F64);
    expect(f.plan()).toBeNull();
    expect(f.plan(new Set([2]))!.at(-1)).toEqual({ kind: "trap" });
    expect(f.plan()).toBeNull();
  });

  test("does not plan a width helper for a record the checker proved absent", () => {
    const f = fixture();
    let calls = 0;
    const plan = planUnionRetag(
      f.from,
      f.to,
      f.shapeOf,
      (src, dst) => {
        calls++;
        return f.lift(src, dst);
      },
      new Set([0]),
    );
    expect(plan![0]).toEqual({ kind: "trap" });
    expect(calls).toBe(0);
  });

  test("site evidence does not discard exact payload representations", () => {
    const f = fixture();
    f.from.arms.push(F64);
    f.to.arms.push(F64);
    expect(f.plan(new Set([2]))!.at(-1)).toEqual({
      kind: "direct",
      route: { tag: 3, lift: { how: "copy" }, values: [] },
    });
  });

  test.each([
    ["1", 1, F64],
    ["true", true, BOOL],
  ] as [string, number | boolean, IrType][])(
    "distinguishes %s from a scalar discriminator with the same spelling",
    (text, scalar, scalarType) => {
      const f = fixture();
      const other: IrRecordShape = {
        id: "r3",
        fields: [
          { name: "kind", type: scalarType },
          { name: "left", type: F64 },
          { name: "right", type: F64 },
        ],
      };
      f.shapes.push(other);
      f.shapes[2]!.fields[0]!.type = scalarType;
      f.from.arms = [record("r0"), record("r3"), UNDEFINED_T];
      f.from.discriminant!.cases = [
        { tag: 0, values: [text] },
        { tag: 1, values: [scalar] },
      ];
      f.to.discriminant!.cases = [
        { tag: 0, values: [text] },
        { tag: 1, values: [scalar] },
      ];
      const plan = f.plan();
      expect(plan).not.toBeNull();
      expect(plan![0]).toEqual({
        kind: "direct",
        route: { tag: 0, lift: { how: "width" }, values: [text] },
      });
      expect(plan![1]).toEqual({
        kind: "direct",
        route: { tag: 1, lift: { how: "width" }, values: [scalar] },
      });
    },
  );

  test("rejects ambiguous source ownership before asking for payload conversions", () => {
    const f = fixture();
    f.from.arms.unshift(record("r1"));
    f.from.discriminant!.cases[0]!.tag = 1;
    f.from.discriminant!.cases.push({ tag: 0, values: ["left"] });
    let calls = 0;
    const plan = planUnionRetag(f.from, f.to, f.shapeOf, (src, dst) => {
      calls++;
      return f.lift(src, dst);
    });
    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });

  test("reserved implementation fields cannot become user discriminants", () => {
    const f = fixture();
    for (const shape of f.shapes) shape.fields[0]!.name = "%kind";
    f.from.discriminant!.field = "%kind";
    f.to.discriminant!.field = "%kind";
    expect(f.plan()).toBeNull();
  });

  test("keeps input metadata unchanged and plans independent", () => {
    const f = fixture();
    const before = JSON.stringify([f.from, f.to, f.shapes]);
    const first = split(f.plan());
    first.routes[0]!.values.push("mutated");
    expect(split(f.plan()).routes[0]!.values).toEqual(["left"]);
    expect(JSON.stringify([f.from, f.to, f.shapes])).toBe(before);
  });
});

describe("discriminator metadata validation", () => {
  for (const side of ["from", "to"] as const) {
    test(`${side}: refuses incomplete coverage of record arms`, () => {
      const f = fixture();
      f[side].discriminant!.cases.pop();
      expect(f.plan()).toBeNull();
    });
    test(`${side}: refuses a duplicate tag`, () => {
      const f = fixture();
      f[side].discriminant!.cases.push(f[side].discriminant!.cases[0]!);
      expect(f.plan()).toBeNull();
    });
    test(`${side}: refuses an empty literal set`, () => {
      const f = fixture();
      f[side].discriminant!.cases[0]!.values = [];
      expect(f.plan()).toBeNull();
    });
    test(`${side}: refuses a literal with the wrong primitive type`, () => {
      const f = fixture();
      f[side].discriminant!.cases[0]!.values = [1];
      expect(f.plan()).toBeNull();
    });
    test(`${side}: refuses a missing shape`, () => {
      const f = fixture();
      expect(
        planUnionRetag(
          f.from,
          f.to,
          (id) => (id === (side === "from" ? "r0" : "r1") ? undefined : f.shapeOf(id)),
          f.lift,
        ),
      ).toBeNull();
    });
    for (const tag of [-1, 0.5, 99, Number.NaN]) {
      test(`${side}: refuses invalid tag ${tag}`, () => {
        const f = fixture();
        f[side].discriminant!.cases[0]!.tag = tag;
        expect(f.plan()).toBeNull();
      });
    }
    for (const literal of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      test(`${side}: refuses non-finite literal ${literal}`, () => {
        const f = fixture(F64, [1, 2]);
        f[side].discriminant!.cases[0]!.values[0] = literal;
        expect(f.plan()).toBeNull();
      });
    }
  }

  test("refuses competing destination owners", () => {
    const f = fixture();
    f.to.discriminant!.cases[1]!.values.push("left");
    expect(f.plan()).toBeNull();
  });

  for (const shapeIndex of [0, 1]) {
    test(`refuses optional or dynamic field in shape ${shapeIndex}`, () => {
      const f = fixture();
      f.shapes[shapeIndex]!.fields[0]!.type = { kind: "dyn" };
      expect(f.plan()).toBeNull();
    });
    test(`refuses tuple representation in shape ${shapeIndex}`, () => {
      const f = fixture();
      f.shapes[shapeIndex]!.tuple = true;
      expect(f.plan()).toBeNull();
    });
    for (const accessor of ["get", "set"]) {
      test(`refuses ${accessor} accessor in shape ${shapeIndex}`, () => {
        const f = fixture();
        f.shapes[shapeIndex]!.fields.push({
          name: `%${accessor}:kind`,
          type: { kind: "func", params: [], ret: STRING },
        });
        expect(f.plan()).toBeNull();
      });
    }
  }
});

describe("retag IR construction", () => {
  test.each([
    [STRING, ["left", "right"], "strEq"],
    [F64, [0, 1], "bin"],
    [BOOL, [false, true], "bin"],
  ] as const)("reads %j discriminator with its source layout", (fieldType, values, comparison) => {
    const f = fixture(fieldType, [...values]);
    const uses: { how: string; src: IrType; dst: IrType }[] = [];
    const fn = buildUnionRetag(
      "retag",
      f.from,
      f.to,
      f.plan()!,
      loc,
      (lift, value, dst) => {
        uses.push({ how: lift.how, src: value.type, dst });
        return { kind: "varRef", localId: "converted", type: dst, loc };
      },
      () => "source",
    );
    const branch = fn.body[0]!;
    if (branch.kind !== "if") throw new Error("missing source tag branch");
    expect(branch.cond.kind).toBe("unionIsTag");
    const read = branch.then[0]!;
    if (read.kind !== "varDecl" || read.init?.kind !== "recordGet")
      throw new Error("missing field capture");
    expect(read.init.shapeId).toBe("r0");
    expect(read.init.type).toEqual(fieldType);
    for (const item of branch.then.slice(1, 3)) {
      if (item.kind !== "if") throw new Error("missing literal dispatch");
      expect(item.cond.kind).toBe(comparison);
      const returned = item.then[0]!;
      if (returned.kind !== "return" || returned.value?.kind !== "unionWrap")
        throw new Error("missing destination wrap");
      expect(returned.value.unionId).toBe("u1");
    }
    expect(uses).toEqual([
      { how: "width", src: record("r0"), dst: record("r1") },
      { how: "width", src: record("r0"), dst: record("r2") },
      { how: "copy", src: UNDEFINED_T, dst: UNDEFINED_T },
    ]);
    expect(branch.then.at(-1)?.kind).toBe("throw");
    expect(fn.body.at(-1)?.kind).toBe("throw");
    expect(fn.locals.filter((local) => local.name === "kind")).toHaveLength(1);
  });

  test("emits a catchable TypeError for a stranded arm", () => {
    const f = fixture();
    f.from.arms.push(NULL_T);
    const fn = buildUnionRetag(
      "retag",
      f.from,
      f.to,
      f.plan()!,
      loc,
      (_, value) => value,
      () => "source",
    );
    const branch = fn.body[2]!;
    if (branch.kind !== "if") throw new Error("missing trap branch");
    const thrown = branch.then[0]!;
    if (thrown.kind !== "throw" || thrown.value.kind !== "libCall")
      throw new Error("missing TypeError");
    expect(thrown.value.type).toEqual({ kind: "object", className: "%TypeError" });
    expect(thrown.value.args[0]).toMatchObject({
      value: expect.stringContaining("null is not representable"),
    });
  });

  test("keeps the input when every arm has the same tag and type", () => {
    const from: IrUnionDef = { id: "narrow", arms: [record("r0"), UNDEFINED_T] };
    const to: IrUnionDef = { id: "wide", arms: [record("r0"), UNDEFINED_T, F64] };
    const lifts: string[] = [];
    const fn = buildUnionRetag(
      "retag",
      from,
      to,
      planUnionRetag(
        from,
        to,
        () => undefined,
        () => null,
      )!,
      loc,
      (lift, value) => {
        lifts.push(lift.how);
        return value;
      },
      () => "source",
    );
    expect(lifts).toEqual([]);
    expect(fn.body).toHaveLength(1);
    const returned = fn.body[0]!;
    if (returned.kind !== "return" || returned.value?.kind !== "unionRetype")
      throw new Error("missing retype");
    expect(returned.value).toMatchObject({ fromId: "narrow", unionId: "wide", tags: [0, 1] });
    expect(returned.value.value).toMatchObject({ kind: "varRef", localId: "u.0" });
  });

  test("tests identity arms together and rebuilds renumbered arms", () => {
    const from: IrUnionDef = { id: "narrow", arms: [record("r0"), STRING, UNDEFINED_T] };
    const to: IrUnionDef = { id: "wide", arms: [record("r0"), F64, UNDEFINED_T, STRING] };
    const plan = planUnionRetag(
      from,
      to,
      () => undefined,
      () => null,
    )!;
    const lifts: string[] = [];
    const fn = buildUnionRetag(
      "retag",
      from,
      to,
      plan,
      loc,
      (lift, value) => {
        lifts.push(`${lift.how}:${value.type.kind}`);
        return value;
      },
      () => "source",
    );
    expect(lifts).toEqual(["copy:string"]);
    const shared = fn.body[0]!;
    if (shared.kind !== "if" || shared.cond.kind !== "logical")
      throw new Error("missing grouped identity test");
    expect(shared.cond.left).toMatchObject({ kind: "unionIsTag", tag: 0 });
    expect(shared.cond.right).toMatchObject({ kind: "unionIsTag", tag: 2 });
    expect(shared.then[0]).toMatchObject({
      kind: "return",
      value: { kind: "unionRetype", tags: [0, 2] },
    });
    const rebuilt = fn.body[1]!;
    if (rebuilt.kind !== "if") throw new Error("missing renumbered arm");
    expect(rebuilt.cond).toMatchObject({ kind: "unionIsTag", tag: 1 });
    expect(rebuilt.then[0]).toMatchObject({
      kind: "return",
      value: { kind: "unionWrap", unionId: "wide", tag: 3 },
    });
    expect(fn.body).toHaveLength(3);
    expect(fn.body.at(-1)?.kind).toBe("throw");
  });

  test("refuses an incomplete build plan", () => {
    const f = fixture();
    expect(() =>
      buildUnionRetag(
        "broken",
        f.from,
        f.to,
        [],
        loc,
        (_, value) => value,
        () => "",
      ),
    ).toThrow("incomplete union retag plan");
  });
});

test("only a proven uninhabited arm can bypass an incompatible payload conversion", () => {
  const from: IrUnionDef = { id: "u0", arms: [record("ok"), record("numberError")] };
  const to: IrUnionDef = { id: "u1", arms: [record("ok"), record("stringError")] };
  const plan = () =>
    planUnionRetag(
      from,
      to,
      () => undefined,
      () => null,
    );
  expect(plan()).toBeNull();
  from.uninhabited = [1];
  expect(plan()).toEqual([
    { kind: "direct", route: { tag: 0, lift: { how: "copy" }, values: [] } },
    { kind: "trap" },
  ]);
});
