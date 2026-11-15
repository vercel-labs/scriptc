import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
} from "../../ir/ir.js";
import { ClassDynamicDispatch, classPropertiesHelper } from "./class-dynamic-dispatch.js";
import { classValueSlot } from "../../ir/class-key-index.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";

const loc = { file: "dispatch.ts", start: 0, end: 1 };
const variable = (localId: string): IrExpr => ({ kind: "varRef", localId, type: DYN, loc });
const literal = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const statement = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  params: [],
  returnType: VOID,
  locals: [],
  body,
  loc,
});
/** The class key of a table branch, whether the branch sits in the chain or
 * in a dispatch case. */
function branchKey(stmt: IrStmt | undefined): string | null {
  if (stmt?.kind !== "if" || stmt.cond.kind !== "libCall") return null;
  const key = stmt.cond.fn === "dyn.typedRefIs" ? stmt.cond.args[1] : undefined;
  return key?.kind === "strLit" ? key.value : null;
}
function context() {
  const liftedFns: IrFunction[] = [];
  const lowerer = {
    shapes: new Map(),
    unions: new Map(),
    classes: new Map(),
    liftedFns,
    liftedFnNamed: (name: string | undefined) => liftedFns.find((fn) => fn.name === name),
    shareHelper: () => {},
    subclassLinks: 0,
    constructedClassCount: () => -1,
    diags: [],
    prototypeMethodAccesses: new Map(),
    protocolDispatches: new Map(),
    classMethodValueSelections: new Map(),
    isSubclassOf: () => false,
    nodeAtLoc: () => null,
  } as unknown as Lowerer;
  const boxed = fn("box", [
    statement({
      kind: "dynFrom",
      value: {
        kind: "varRef",
        localId: "instance",
        type: { kind: "object", className: "Widget" },
        loc,
      },
      type: DYN,
      loc,
    }),
  ]);
  return { lowerer, liftedFns, boxed };
}

test("preserves typed function bodies when other functions box classes", () => {
  const { lowerer, boxed } = context();
  const body: IrStmt[] = [
    { kind: "block", body: [statement({ kind: "numLit", value: 1, type: F64, loc })], loc },
  ];
  const typed = fn("typed", body);
  const boxBody = boxed.body;
  const dispatch = new ClassDynamicDispatch();
  expect(dispatch.process(lowerer, [boxed, typed])).toBe(true);
  expect(typed.body).toBe(body);
  expect(boxed.body).toBe(boxBody);
  expect(dispatch.process(lowerer, [boxed, typed])).toBe(false);
  expect(typed.body).toBe(body);
});

test.each([
  "named read",
  "computed read",
  "named write",
  "computed string write",
  "computed dynamic write",
])("rewrites a nested %s", (kind) => {
  const { lowerer, boxed, liftedFns } = context();
  const read = kind.endsWith("read");
  const computed = kind.startsWith("computed");
  const dynamicKey = kind === "computed dynamic write";
  const key = computed
    ? { kind: "varRef" as const, localId: "key", type: dynamicKey ? DYN : STRING, loc }
    : literal("name");
  const operation: IrExpr = read
    ? { kind: "dynKeyGet", value: variable("receiver"), key, type: DYN, loc }
    : {
        kind: "libCall",
        fn: dynamicKey ? "dyn.keySetComputed" : "dyn.keySet",
        args: [variable("receiver"), key, variable("stored")],
        type: VOID,
        loc,
      };
  const target = fn("target", [{ kind: "block", body: [statement(operation)], loc }]);
  const dispatch = new ClassDynamicDispatch();
  dispatch.process(lowerer, [boxed, target]);
  const block = target.body[0]!;
  if (block.kind !== "block" || block.body[0]?.kind !== "exprStmt")
    throw new Error("missing test body");
  expect(block.body[0].expr).toMatchObject({
    kind: "call",
    callee: expect.stringMatching(/^%dyn\.class\.(property|computed)\./),
  });
  // The bag dispatch and the member helper; reads also use the read-only bags.
  expect(liftedFns).toHaveLength(read ? 4 : 2);
  if (read)
    expect(liftedFns.map((item) => item.name)).toEqual(
      expect.arrayContaining(["%dyn.class.readProperties", "%dyn.class.readPropertiesOrEmpty"]),
    );
  const transformed = target.body;
  expect(dispatch.process(lowerer, [boxed, target, ...liftedFns])).toBe(false);
  expect(target.body).toBe(transformed);
});

test("discovers dispatch sites added during a later reachability pass", () => {
  const { lowerer, boxed } = context();
  const target = fn("target", []);
  const dispatch = new ClassDynamicDispatch();
  dispatch.process(lowerer, [boxed, target]);
  target.body.push(
    statement({
      kind: "dynKeyGet",
      value: variable("receiver"),
      key: literal("name"),
      type: DYN,
      loc,
    }),
  );
  expect(dispatch.process(lowerer, [boxed, target])).toBe(true);
  expect(target.body[0]).toMatchObject({ kind: "exprStmt", expr: { kind: "call" } });
});

test.each(["dyn.reflectGet", "dyn.reflectSet"] as const)(
  "rewrites isolated %s calls and preserves the supplied receiver",
  (operation) => {
    const { lowerer, boxed, liftedFns } = context();
    lowerer.coerceToExpected = (value, type) =>
      value.type.kind === type.kind ? value : { kind: "dynFrom", value, type, loc };
    const args = [
      variable("target"),
      variable("key"),
      ...(operation === "dyn.reflectSet" ? [variable("stored")] : []),
      variable("receiver"),
    ];
    const target = fn("reflect", [
      statement({
        kind: "libCall",
        fn: operation,
        args,
        type: operation === "dyn.reflectSet" ? BOOL : DYN,
        loc,
      }),
    ]);
    const dispatch = new ClassDynamicDispatch();
    expect(dispatch.process(lowerer, [boxed, target])).toBe(true);
    expect(target.body[0]).toMatchObject({
      kind: "exprStmt",
      expr: { kind: "call", callee: expect.stringMatching(/^%dyn\.class\.computed\./), args },
    });
    const helper = liftedFns.find((item) => item.name.startsWith("%dyn.class.computed."))!;
    expect(helper.body.at(-1)).toMatchObject({
      kind: "return",
      value: {
        kind: "libCall",
        fn: operation,
        args: expect.arrayContaining([variable("p.reflectReceiver")]),
      },
    });
    expect(dispatch.process(lowerer, [boxed, target, ...liftedFns])).toBe(false);
  },
);

test("shares method dispatch while preserving source error labels and callback evaluation order", () => {
  const { lowerer, boxed, liftedFns } = context();
  lowerer.classes.set("Widget", {
    def: { name: "Widget", fields: [] },
    fields: new Map(),
    methods: new Map([
      ["work", { params: [{ name: "value", type: DYN, mode: "required" }], ret: DYN }],
    ]),
    base: null,
    subclasses: [],
    decl: null,
  } as unknown as ClassInfo);
  lowerer.classCanBeConstructed = () => true;
  lowerer.isSubclassOf = (left, right) => left === right;
  lowerer.overrideBelow = () => false;
  lowerer.coerceToExpected = (value, type) =>
    value.type.kind === type.kind ? value : { kind: "dynFrom", value, type, loc };
  lowerer.upcastTo = (value) => value;
  lowerer.noteEdge = () => {};
  const invocations = ["left.work", "right.work"].map((calleeName) =>
    statement({
      kind: "dynInvoke",
      recv: variable(calleeName),
      method: "work",
      calleeName,
      args: [{ kind: "call", callee: "argumentEffect", args: [], type: DYN, loc }],
      type: DYN,
      loc,
    }),
  );
  const target = fn("target", invocations);
  new ClassDynamicDispatch().process(lowerer, [boxed, target]);
  const calls = liftedFns.filter((helper) => helper.name.startsWith("%dyn.class.call."));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.at(-1)).toMatchObject({
    kind: "return",
    value: { kind: "dynInvoke", calleeNameValue: { kind: "varRef", localId: "p.calleeName" } },
  });
  target.body.forEach((statement, index) => {
    expect(statement).toMatchObject({
      kind: "exprStmt",
      expr: {
        kind: "seqExpr",
        result: {
          kind: "call",
          callee: calls[0]!.name,
          args: [
            { kind: "varRef" },
            { kind: "call", callee: expect.stringMatching(/^%dyn\.class\.callback\./) },
            { kind: "call", callee: "argumentEffect" },
            { kind: "strLit", value: ["left.work", "right.work"][index] },
          ],
        },
      },
    });
  });
});

test("known class property bags preserve one owned receiver without boxing", () => {
  const { lowerer, liftedFns } = context();
  lowerer.isSubclassOf = () => false;
  const type = { kind: "object", className: "Widget" } as const;
  const info = {
    def: { name: "Widget", fields: [] },
    fields: new Map(),
    methods: new Map(),
    base: null,
    subclasses: [],
  } as unknown as ClassInfo;
  lowerer.classes.set("Widget", info);
  const receiver: IrExpr = { kind: "call", callee: "makeWidget", args: [], type, loc };
  const target = fn("target", [
    statement({
      kind: "call",
      callee: "%dyn.class.properties",
      args: [{ kind: "dynFrom", value: receiver, type: DYN, loc }],
      type: DYN,
      loc,
    }),
  ]);
  const dispatch = new ClassDynamicDispatch();
  expect(dispatch.process(lowerer, [target])).toBe(true);
  expect(target.body).toEqual([
    statement({
      kind: "call",
      callee: "%class.properties:Widget",
      args: [receiver],
      type: DYN,
      loc,
    }),
  ]);
  const helper = liftedFns.find((item) => item.name === "%class.properties:Widget")!;
  expect(helper.params.map((param) => param.type)).toEqual([type]);
  expect(helper.body).toMatchObject([
    {
      kind: "if",
      cond: {
        kind: "dynTest",
        test: "undefined",
        value: { kind: "fieldGet", className: "Widget" },
      },
      then: [{ kind: "fieldSet", obj: { kind: "varRef", type }, value: { kind: "dynObjLit" } }],
    },
    { kind: "return", value: { kind: "fieldGet", className: "Widget" } },
  ]);
  expect(dispatch.process(lowerer, [target, ...liftedFns])).toBe(false);
  // Prototype assignments can appear in a later reachable body. Both
  // lookup paths must then initialize the same inherited property bag.
  info.def.prototypeDataHelper = "%prototype.Widget";
  expect(dispatch.process(lowerer, [target, ...liftedFns])).toBe(true);
  expect(helper.body[0]).toMatchObject({
    then: [
      {
        value: {
          kind: "libCall",
          fn: "dyn.objCreate",
          args: [{ kind: "call", callee: "%prototype.Widget" }],
        },
      },
    ],
  });
  expect(dispatch.process(lowerer, [target, ...liftedFns])).toBe(false);
});

test("unknown receivers keep checked class property dispatch", () => {
  const { lowerer, boxed } = context();
  const expr: IrExpr = {
    kind: "call",
    callee: "%dyn.class.properties",
    args: [variable("value")],
    type: DYN,
    loc,
  };
  const target = fn("target", [statement(expr)]);
  const body = target.body;
  new ClassDynamicDispatch().process(lowerer, [boxed, target]);
  expect(target.body).toBe(body);
});

test("read-only class bags are never stored; a settled prototype bag is made per read", () => {
  for (const prototype of [false, true]) {
    const { lowerer, liftedFns } = context();
    const type = { kind: "object" as const, className: "Widget" };
    const info = {
      def: { name: "Widget", fields: [] },
      fields: new Map(),
      methods: new Map(),
      subclasses: [],
      base: null,
    } as unknown as ClassInfo;
    lowerer.classes.set("Widget", info);
    const target = fn("target", [
      statement({
        kind: "call",
        callee: "%dyn.class.readProperties",
        args: [
          {
            kind: "dynFrom",
            value: { kind: "varRef", localId: "instance", type, loc },
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      }),
    ]);
    const dispatch = new ClassDynamicDispatch();
    expect(dispatch.process(lowerer, [target])).toBe(true);
    const helper = liftedFns.find((item) => item.name === "%class.readProperties:Widget")!;
    expect(helper).toBeDefined();
    if (prototype) {
      info.def.prototypeDataHelper = "%prototype.Widget";
      expect(dispatch.process(lowerer, [target, ...liftedFns])).toBe(true);
    }
    dispatch.finalize();
    if (prototype)
      expect(helper.body[0]).toMatchObject({
        kind: "if",
        then: [{ kind: "return", value: { kind: "libCall", fn: "dyn.objCreate" } }],
      });
    else
      expect(helper.body).toMatchObject([
        { kind: "return", value: { kind: "fieldGet", className: "Widget" } },
      ]);
  }
});

test("the untyped read-only bag selects classes as the bag dispatch does, without storing", () => {
  const { lowerer, liftedFns } = context();
  const type = { kind: "object" as const, className: "Widget" };
  lowerer.classes.set("Widget", {
    def: { name: "Widget", fields: [] },
    fields: new Map(),
    methods: new Map(),
    subclasses: [],
    base: null,
  } as unknown as ClassInfo);
  const read = classPropertiesHelper(lowerer, loc, true);
  const target = fn("target", [
    statement({
      kind: "call",
      callee: "%dyn.class.properties",
      args: [
        {
          kind: "dynFrom",
          value: { kind: "varRef", localId: "instance", type, loc },
          type: DYN,
          loc,
        },
      ],
      type: DYN,
      loc,
    }),
    statement({ kind: "call", callee: read.name, args: [variable("value")], type: DYN, loc }),
  ]);
  const dispatch = new ClassDynamicDispatch();
  expect(dispatch.process(lowerer, [target, ...liftedFns])).toBe(true);
  const bag = liftedFns.find((item) => item.name === "%dyn.class.properties")!;
  dispatch.finalize(lowerer);
  const text = (body: IrStmt[]) => JSON.stringify(body);
  expect(text(bag.body)).toContain('"kind":"fieldSet"');
  expect(text(read.body)).not.toContain('"kind":"fieldSet"');
  expect(text(read.body)).toContain('"className":"Widget","field":"%dynProperties"');
});

test("indexes a class table's branches on the receiver's class key at sixty-four or more classes", () => {
  const { lowerer, liftedFns } = context();
  const names = Array.from({ length: 64 }, (_, i) => `Class${i}`);
  for (const name of names)
    lowerer.classes.set(name, {
      def: { name, fields: [] },
      fields: new Map(),
      methods: new Map(),
      subclasses: [],
      base: null,
    } as unknown as ClassInfo);
  const target = fn(
    "target",
    names.map((name) =>
      statement({
        kind: "call",
        callee: "%dyn.class.properties",
        args: [
          {
            kind: "dynFrom",
            value: {
              kind: "varRef",
              localId: "instance",
              type: { kind: "object", className: name },
              loc,
            },
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      }),
    ),
  );
  const dispatch = new ClassDynamicDispatch();
  expect(dispatch.process(lowerer, [target, ...liftedFns])).toBe(true);
  const bag = liftedFns.find((item) => item.name === "%dyn.class.properties")!;
  dispatch.finalize(lowerer);
  const dispatchSwitch = bag.body.find((stmt) => stmt.kind === "switch");
  expect(dispatchSwitch).toMatchObject({
    kind: "switch",
    disc: { kind: "libCall", fn: "dyn.classHash" },
  });
  if (dispatchSwitch?.kind !== "switch") throw new Error("expected a dispatch switch");
  // The table's first two classes stay in the chain ahead of the switch and
  // hold no case of their own.
  const at = bag.body.indexOf(dispatchSwitch);
  const aheadKeys = bag.body
    .slice(0, at)
    .flatMap((stmt) => (branchKey(stmt) === null ? [] : [branchKey(stmt)]));
  expect(aheadKeys).toHaveLength(2);
  expect(dispatchSwitch.cases).toHaveLength(names.length - 2);
  const hashes = dispatchSwitch.cases.map(({ test }) => JSON.stringify(test));
  expect(new Set(hashes).size).toBe(names.length - 2);
  // Each case keeps its branch, guarded by the branch's own key test.
  const keys = dispatchSwitch.cases.map(({ body }) => {
    const branch = body[0];
    if (branch?.kind !== "if" || branch.cond.kind !== "libCall") return null;
    return branch.cond.fn === "dyn.typedRefIs" ? branch.cond.args[1] : null;
  });
  expect(new Set(keys.map((key) => JSON.stringify(key)))).toEqual(
    new Set(
      names
        .map((name) => `object:${name}`)
        .filter((key) => !aheadKeys.includes(key))
        .map((key) => JSON.stringify(literal(key))),
    ),
  );
});

test("keeps two classes whose keys hash alike in one case, in order", () => {
  const { lowerer, liftedFns } = context();
  const names = [...Array.from({ length: 62 }, (_, i) => `Class${i}`), "AlphaThing", "BravoThing"];
  for (const name of names)
    lowerer.classes.set(name, {
      def: { name, fields: [] },
      fields: new Map(),
      methods: new Map(),
      subclasses: [],
      base: null,
    } as unknown as ClassInfo);
  const target = fn(
    "target",
    names.map((name) =>
      statement({
        kind: "call",
        callee: "%dyn.class.properties",
        args: [
          {
            kind: "dynFrom",
            value: {
              kind: "varRef",
              localId: "instance",
              type: { kind: "object", className: name },
              loc,
            },
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      }),
    ),
  );
  const dispatch = new ClassDynamicDispatch();
  expect(dispatch.process(lowerer, [target, ...liftedFns])).toBe(true);
  const bag = liftedFns.find((item) => item.name === "%dyn.class.properties")!;
  const chainKeys = bag.body.flatMap((stmt) => (branchKey(stmt) === null ? [] : [branchKey(stmt)]));
  dispatch.finalize(lowerer);
  const dispatchSwitch = bag.body.find((stmt) => stmt.kind === "switch");
  if (dispatchSwitch?.kind !== "switch") throw new Error("expected a dispatch switch");
  /* `object:AlphaThing` and `object:BravoThing` have the same length and end
   * in the same four bytes, so the dispatch cannot separate them: one case
   * holds both branches and their own key tests pick between them, which
   * keeps every class reachable. The run's first two classes stay in the
   * chain ahead of the switch and hold no case of their own. */
  expect(dispatchSwitch.cases).toHaveLength(names.length - 3);
  const shared = dispatchSwitch.cases.filter(({ body }) => body.length === 2);
  expect(shared).toHaveLength(1);
  const sharedKeys = shared[0]!.body.map(branchKey);
  const collided = chainKeys.filter(
    (key) => key === "object:AlphaThing" || key === "object:BravoThing",
  );
  expect(sharedKeys).toEqual(collided);
  expect(collided).toHaveLength(2);
});

test("keeps the class chain below sixty-four classes", () => {
  const { lowerer, liftedFns } = context();
  const names = Array.from({ length: 63 }, (_, i) => `Class${i}`);
  for (const name of names)
    lowerer.classes.set(name, {
      def: { name, fields: [] },
      fields: new Map(),
      methods: new Map(),
      subclasses: [],
      base: null,
    } as unknown as ClassInfo);
  const target = fn(
    "target",
    names.map((name) =>
      statement({
        kind: "call",
        callee: "%dyn.class.properties",
        args: [
          {
            kind: "dynFrom",
            value: {
              kind: "varRef",
              localId: "instance",
              type: { kind: "object", className: name },
              loc,
            },
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      }),
    ),
  );
  const dispatch = new ClassDynamicDispatch();
  expect(dispatch.process(lowerer, [target, ...liftedFns])).toBe(true);
  const bag = liftedFns.find((item) => item.name === "%dyn.class.properties")!;
  dispatch.finalize(lowerer);
  expect(bag.body.some((stmt) => stmt.kind === "switch")).toBe(false);
});

test("normalizes base capsules before dispatching each derived member once", () => {
  const { lowerer, liftedFns } = context();
  const base = {
    def: { name: "Base", fields: [{ name: "value", type: F64 }] },
    fields: new Map([["value", F64]]),
    methods: new Map(),
    base: null,
    subclasses: [],
  } as unknown as ClassInfo;
  const child = {
    def: { name: "Child", base: "Base", fields: [{ name: "value", type: F64 }] },
    fields: new Map([["value", F64]]),
    methods: new Map(),
    base,
    subclasses: [],
  } as unknown as ClassInfo;
  base.subclasses.push(child);
  lowerer.classes.set("Base", base);
  lowerer.classes.set("Child", child);
  lowerer.classCanBeConstructed = () => true;
  lowerer.isSubclassOf = (name, parent) => name === "Child" && parent === "Base";
  lowerer.coerceToExpected = (value, type) =>
    type.kind === "dyn" ? { kind: "dynFrom", value, type, loc } : value;
  const boxes = fn(
    "boxes",
    [base, child].map((info) =>
      statement({
        kind: "dynFrom",
        value: {
          kind: "varRef",
          localId: info.def.name,
          type: { kind: "object", className: info.def.name },
          loc,
        },
        type: DYN,
        loc,
      }),
    ),
  );
  const read = fn("read", [
    statement({
      kind: "dynKeyGet",
      value: variable("value"),
      key: literal("value"),
      type: DYN,
      loc,
    }),
  ]);
  new ClassDynamicDispatch().process(lowerer, [boxes, read]);
  const dispatch = liftedFns.find((helper) => helper.name.startsWith("%dyn.class.property."))!;
  expect(dispatch.body[0]).toMatchObject({
    kind: "assign",
    localId: "p.0",
    value: { kind: "call", callee: "%dyn.class.normalize" },
  });
  expect(dispatch.body.filter((statement) => statement.kind === "if")).toHaveLength(2);
  const normalize = liftedFns.find((helper) => helper.name === "%dyn.class.normalize")!;
  // The capsule branch unboxes its receiver once, then tests each subclass.
  expect(normalize.body[0]).toMatchObject({
    kind: "if",
    then: [
      { kind: "varDecl", init: { kind: "dynCheck", type: { kind: "object", className: "Base" } } },
      {
        kind: "if",
        then: [
          {
            kind: "return",
            value: {
              kind: "dynFrom",
              value: { kind: "downcast", type: { kind: "object", className: "Child" } },
            },
          },
        ],
      },
    ],
  });
});

test("class branches read their exact class's bag, also for classes with subclasses", () => {
  const { lowerer, liftedFns } = context();
  const base = {
    def: { name: "Base", fields: [{ name: "value", type: F64 }], tracksOwnFields: true },
    fields: new Map([["value", F64]]),
    methods: new Map(),
    base: null,
    subclasses: [],
  } as unknown as ClassInfo;
  const child = {
    def: {
      name: "Child",
      base: "Base",
      fields: [{ name: "value", type: F64 }],
      tracksOwnFields: true,
    },
    fields: new Map([["value", F64]]),
    methods: new Map(),
    base,
    subclasses: [],
  } as unknown as ClassInfo;
  base.subclasses.push(child);
  lowerer.classes.set("Base", base);
  lowerer.classes.set("Child", child);
  lowerer.classCanBeConstructed = () => true;
  lowerer.isSubclassOf = (name, parent) => name === "Child" && parent === "Base";
  lowerer.coerceToExpected = (value, type) =>
    type.kind === "dyn" ? { kind: "dynFrom", value, type, loc } : value;
  const boxes = fn(
    "boxes",
    [base, child].map((info) =>
      statement({
        kind: "dynFrom",
        value: {
          kind: "varRef",
          localId: info.def.name,
          type: { kind: "object", className: info.def.name },
          loc,
        },
        type: DYN,
        loc,
      }),
    ),
  );
  const read = fn("read", [
    statement({
      kind: "dynKeyGet",
      value: variable("value"),
      key: literal("value"),
      type: DYN,
      loc,
    }),
  ]);
  const dispatch = new ClassDynamicDispatch();
  for (let pass = 0; pass < 4 && dispatch.process(lowerer, [boxes, read, ...liftedFns]); pass++);
  dispatch.finalize(lowerer);
  const property = liftedFns.find((helper) => helper.name.startsWith("%dyn.class.property."))!;
  // The class branches; the fallback for other receivers keeps the
  // dispatch over every class.
  const branches = property.body.filter(
    (statement) =>
      statement.kind === "if" &&
      statement.cond.kind === "libCall" &&
      statement.cond.fn === "dyn.typedRefIs",
  );
  expect(branches).toHaveLength(2);
  const text = JSON.stringify(branches);
  expect(text).toContain('"callee":"%class.branchPropertiesOrEmpty:Base"');
  expect(text).toContain('"callee":"%class.branchPropertiesOrEmpty:Child"');
  expect(text).not.toContain('"callee":"%dyn.class.readPropertiesOrEmpty"');
  const bag = liftedFns.find((helper) => helper.name === "%class.branchPropertiesOrEmpty:Base")!;
  // The bag is the receiver's own field; an absent bag reads as a fresh,
  // unstored empty object.
  expect(bag.params[0]!.type).toEqual({ kind: "object", className: "Base" });
  expect(JSON.stringify(bag.body)).toContain('"className":"Base","field":"%dynProperties"');
  expect(JSON.stringify(bag.body)).not.toContain('"kind":"fieldSet"');
  expect(bag.body[0]).toMatchObject({
    kind: "if",
    then: [{ kind: "return", value: { kind: "dynObjLit", fields: [] } }],
  });
});

test("records a class's bag initializer only when all its class-table branches agree", () => {
  const { lowerer } = context();
  const classBagInitializers = new Map<string, IrExpr>();
  Object.assign(lowerer, { classBagInitializers });
  for (const name of ["Material", "Texture"])
    lowerer.classes.set(name, { def: { name, tracksOwnFields: true } } as unknown as ClassInfo);
  const initializer = (
    className: string,
    prototype: string,
    start: number,
  ): Extract<IrStmt, { kind: "fieldSet" }> => {
    const at = { ...loc, start };
    return {
      kind: "fieldSet",
      obj: {
        kind: "dynCheck",
        value: { kind: "varRef", localId: "p.0", type: DYN, loc: at },
        type: { kind: "object", className },
        loc: at,
      },
      className,
      field: "%bag",
      value: {
        kind: "libCall",
        fn: "dyn.objCreate",
        args: [{ kind: "call", callee: prototype, args: [], type: DYN, loc: at }],
        type: DYN,
        loc: at,
      },
      loc: at,
    };
  };
  const dispatch = new ClassDynamicDispatch();
  const tables = (dispatch as unknown as { bagInitializers: Map<string, unknown[]> })
    .bagInitializers;
  // A base class whose own instances get its prototype and whose subclass
  // instances get theirs through a per-instance dispatch has no single bag.
  tables.set("Material", [
    initializer("Material", "%prototype.data.Material", 1),
    initializer("Material", "%class.bagPrototype:Material", 2),
  ]);
  // Branches that differ only in source location agree.
  tables.set("Texture", [
    initializer("Texture", "%prototype.data.Texture", 3),
    initializer("Texture", "%prototype.data.Texture", 4),
  ]);
  dispatch.finalize(lowerer);
  expect([...classBagInitializers.keys()]).toEqual(["Texture"]);
});

/** A helper whose body is one class branch per name on parameter `p`, then
 * a generic tail. `test` is the builtin of the branches' key tests and
 * `then` the body each branch runs for its class. */
function classTable(
  name: string,
  keys: readonly string[],
  test: "dyn.typedRefIs" | "dyn.classIs",
  then: (key: string) => IrStmt[],
): IrFunction {
  return {
    ...fn(name, [
      ...keys.map((key): IrStmt => ({
        kind: "if",
        cond: { kind: "libCall", fn: test, args: [variable("p"), literal(key)], type: BOOL, loc },
        then: then(key),
        else_: null,
        loc,
      })),
      { kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
    ]),
    params: [{ localId: "p", name: "p", type: DYN }],
    returnType: BOOL,
  };
}
const returnsTrue: IrStmt = {
  kind: "return",
  value: { kind: "boolLit", value: true, type: BOOL, loc },
  loc,
};

test("indexes a table of class values on the constructor's key from eight classes", () => {
  const { lowerer, liftedFns } = context();
  const keys = Array.from({ length: 8 }, (_, i) => `classval:Class${i}`);
  const table = classTable("%class.instanceof:dynamic", keys, "dyn.classIs", () => [returnsTrue]);
  const short = classTable("%class.construct:0", keys.slice(0, 7), "dyn.classIs", () => [
    returnsTrue,
  ]);
  liftedFns.push(table, short);
  new ClassDynamicDispatch().finalize(lowerer);
  // The whole run is in the switch: a value that is no compiled class, the
  // usual operand of such a test, passes every branch with one index.
  expect(table.body).toHaveLength(2);
  const dispatchSwitch = table.body[0];
  expect(dispatchSwitch).toMatchObject({
    kind: "switch",
    disc: {
      kind: "libCall",
      fn: "dyn.classValueHash",
      // Eight classes take sixteen slots: four slot bits.
      args: [
        { kind: "varRef", localId: "p" },
        { kind: "numLit", value: 4 },
      ],
    },
  });
  if (dispatchSwitch?.kind !== "switch") throw new Error("expected a dispatch switch");
  // Every branch is in a case, as it was built, with its own key test, in a
  // slot the key folds to; branches that share a slot keep their order.
  const moved = dispatchSwitch.cases.flatMap(({ body }) => body.slice(0, -1));
  expect(moved).toHaveLength(keys.length);
  for (const { test, body } of dispatchSwitch.cases) {
    expect(test).toMatchObject({ kind: "numLit" });
    if (test?.kind !== "numLit") throw new Error("expected a slot");
    expect(test.value).toBeGreaterThanOrEqual(0);
    expect(test.value).toBeLessThan(16);
    // A value the slot's guards reject leaves the table there.
    expect(body[body.length - 1]).toMatchObject({ kind: "break" });
    for (const branch of body.slice(0, -1)) {
      expect(branch).toMatchObject({ kind: "if", cond: { kind: "libCall", fn: "dyn.classIs" } });
      if (branch.kind !== "if" || branch.cond.kind !== "libCall") throw new Error("a branch");
      const key = branch.cond.args[1];
      expect(key?.kind === "strLit" ? classValueSlot(key.value, 4) : null).toBe(test.value);
    }
  }
  expect(short.body.map((stmt) => stmt.kind)).toEqual([
    ...keys.slice(0, 7).map(() => "if"),
    "return",
  ]);
});

test("does not put class values and capsules of one receiver in one switch", () => {
  const { lowerer, liftedFns } = context();
  const values = Array.from({ length: 8 }, (_, i) => `classval:Class${i}`);
  const capsules = Array.from({ length: 64 }, (_, i) => `object:Class${i}`);
  const table = classTable("%mixed", [], "dyn.classIs", () => []);
  table.body = [
    ...classTable("%a", values, "dyn.classIs", () => [returnsTrue]).body.slice(0, -1),
    ...classTable("%b", capsules, "dyn.typedRefIs", () => [returnsTrue]).body,
  ];
  liftedFns.push(table);
  new ClassDynamicDispatch().finalize(lowerer);
  const switches = table.body.filter((stmt) => stmt.kind === "switch");
  expect(switches.map((stmt) => (stmt.disc.kind === "libCall" ? stmt.disc.fn : null))).toEqual([
    "dyn.classValueHash",
    "dyn.classHash",
  ]);
  // The capsule run keeps its two leading branches in the chain.
  expect(table.body.map((stmt) => stmt.kind)).toEqual(["switch", "if", "if", "switch", "return"]);
});

test("indexes class branches that can complete, and closes each case with a break", () => {
  const { lowerer, liftedFns } = context();
  const keys = Array.from({ length: 64 }, (_, i) => `object:Class${i}`);
  // A keyed read's prelude: the class's branch returns only for some keys.
  const prelude = (): IrStmt[] => [
    {
      kind: "if",
      cond: { kind: "dynTest", test: "symbol", value: variable("key"), type: BOOL, loc },
      then: [returnsTrue],
      else_: null,
      loc,
    },
  ];
  const table = classTable("%dyn.class.computed.0", keys, "dyn.typedRefIs", prelude);
  const short = classTable("%dyn.class.computed.1", keys.slice(0, 63), "dyn.typedRefIs", prelude);
  liftedFns.push(table, short);
  new ClassDynamicDispatch().finalize(lowerer);
  expect(table.body.map((stmt) => stmt.kind)).toEqual(["switch", "return"]);
  const dispatchSwitch = table.body[0];
  if (dispatchSwitch?.kind !== "switch") throw new Error("expected a dispatch switch");
  expect(dispatchSwitch.disc).toMatchObject({ kind: "libCall", fn: "dyn.classHash" });
  expect(dispatchSwitch.cases).toHaveLength(keys.length);
  for (const { body } of dispatchSwitch.cases) {
    // No later case holds a branch of the same class, so the selected
    // class leaves the switch instead of walking the other guards.
    expect(body.map((stmt) => stmt.kind)).toEqual(["if", "break"]);
    expect(branchKey(body[0])).not.toBeNull();
  }
  expect(short.body.filter((stmt) => stmt.kind === "switch")).toHaveLength(0);
});

test("keeps returning and completing class branches in separate runs", () => {
  const { lowerer, liftedFns } = context();
  const keys = Array.from({ length: 64 }, (_, i) => `object:Class${i}`);
  const table = classTable("%split", [], "dyn.typedRefIs", () => []);
  table.body = [
    ...classTable("%a", keys, "dyn.typedRefIs", () => [statement(variable("key"))]).body.slice(
      0,
      -1,
    ),
    ...classTable("%b", keys, "dyn.typedRefIs", () => [returnsTrue]).body,
  ];
  liftedFns.push(table);
  new ClassDynamicDispatch().finalize(lowerer);
  // The returning run is built as it always was: two branches ahead of the
  // switch, cases without a break.
  expect(table.body.map((stmt) => stmt.kind)).toEqual(["switch", "if", "if", "switch", "return"]);
  const [completing, returning] = table.body.filter((stmt) => stmt.kind === "switch");
  expect(completing!.cases.every(({ body }) => body[body.length - 1]!.kind === "break")).toBe(true);
  expect(returning!.cases.every(({ body }) => body.every((stmt) => stmt.kind === "if"))).toBe(true);
  expect(returning!.cases).toHaveLength(keys.length - 2);
});
