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
import {
  ClassDynamicDispatch,
  classPropertiesHelper,
  trackClassFieldCreation,
} from "./class-dynamic-dispatch.js";
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
function context() {
  const liftedFns: IrFunction[] = [];
  const lowerer = {
    shapes: new Map(),
    unions: new Map(),
    classes: new Map(),
    liftedFns,
    diags: [],
    prototypeMethodAccesses: new Map(),
    protocolDispatches: new Map(),
    classMethodValueSelections: new Map(),
    isSubclassOf: () => false,
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

function trackedContext() {
  const { lowerer } = context();
  const type = { kind: "object", className: "Widget" } as const;
  lowerer.classes.set("Widget", {
    def: {
      name: "Widget",
      tracksOwnFields: true,
      nativePropertyBagHelper: "prepare.Widget",
      fields: [
        { name: "#public", type: DYN },
        { name: "%public", type: STRING },
        { name: "#secret", type: F64, visibility: "private" },
      ],
    },
    symbolFields: new Map(),
  } as unknown as ClassInfo);
  lowerer.coerceToExpected = (value, type) =>
    value.type.kind === type.kind ? value : { kind: "dynFrom", value, type, loc };
  const receiver: IrExpr = { kind: "call", callee: "receiverEffect", args: [], type, loc };
  return { lowerer, receiver };
}

test.each(["set", "setSloppy", "define"] as const)(
  "class %s saves conversion before admission and couples presence with the store",
  (propertyOp) => {
    const { lowerer, receiver } = trackedContext();
    const value: IrExpr = {
      kind: "dynCheck",
      value: { kind: "call", callee: "valueEffect", args: [], type: DYN, loc },
      type: STRING,
      loc,
    };
    const target = fn("write", [
      {
        kind: "fieldSet",
        obj: receiver,
        className: "Widget",
        field: "%public",
        value,
        propertyOp,
        loc,
      },
    ]);
    const functions = [target];
    trackClassFieldCreation(lowerer, functions);
    const block = target.body[0]!;
    if (block.kind !== "block") throw new Error("missing guarded store");
    expect(block.body).toMatchObject([
      { kind: "varDecl", init: receiver },
      { kind: "varDecl", init: value },
      {
        kind: "if",
        cond: {
          kind: "intrinsic",
          name: "native.checkWrite",
          args: [
            { kind: "varRef" },
            literal("%public"),
            { kind: "numLit", value: { set: 0, setSloppy: 1, define: 2 }[propertyOp] },
            ...(propertyOp === "define" ? [] : [{ kind: "varRef" }]),
          ],
        },
        then: [{ kind: "fieldSet", value: { kind: "varRef" } }],
        else_: null,
      },
    ]);
    const savedReceiver = block.body[0]!;
    const saved = block.body[1]!;
    const admitted = block.body[2]!;
    if (
      savedReceiver.kind !== "varDecl" ||
      saved.kind !== "varDecl" ||
      admitted.kind !== "if" ||
      admitted.cond.kind !== "intrinsic"
    )
      throw new Error("missing saved class value");
    expect(admitted.cond.args).toHaveLength(propertyOp === "define" ? 3 : 4);
    if (propertyOp !== "define")
      expect(admitted.cond.args[3]).toMatchObject({ kind: "varRef", localId: saved.localId });
    expect(admitted.then).toMatchObject([
      {
        kind: "fieldSet",
        obj: { kind: "varRef", localId: savedReceiver.localId },
        value: { kind: "varRef", localId: saved.localId },
        propertyOp,
      },
    ]);
    expect(functions).toEqual([target]);
  },
);

test.each(["set", "setSloppy", "define"] as const)(
  "class %s without native admission publishes field creation after the store",
  (propertyOp) => {
    const { lowerer, receiver } = trackedContext();
    delete lowerer.classes.get("Widget")!.def.nativePropertyBagHelper;
    const value = literal("stored");
    const target = fn("write", [
      {
        kind: "fieldSet",
        obj: receiver,
        className: "Widget",
        field: "%public",
        value,
        propertyOp,
        loc,
      },
    ]);
    const functions = [target];
    trackClassFieldCreation(lowerer, functions);
    const block = target.body[0]!;
    if (block.kind !== "block" || block.body[0]?.kind !== "varDecl")
      throw new Error("missing saved class receiver");
    expect(block.body.slice(1)).toMatchObject([
      {
        kind: "fieldSet",
        obj: { kind: "varRef", localId: block.body[0].localId },
        value,
        propertyOp,
      },
      {
        kind: "exprStmt",
        expr: {
          kind: "call",
          callee: "%dyn.class.fieldCreated",
          args: [
            expect.anything(),
            expect.anything(),
            { kind: "boolLit", value: propertyOp === "define" },
          ],
        },
      },
    ]);
    const helper = functions.find((item) => item.name === "%dyn.class.fieldCreated")!;
    expect(helper.body[1]).toMatchObject({
      kind: "if",
      cond: {
        kind: "logical",
        op: "||",
        left: { kind: "varRef", localId: "define" },
        right: { kind: "unary", op: "!", operand: { kind: "libCall", fn: "dyn.hasOwnComputed" } },
      },
    });
  },
);

test.each([false, true])(
  "guarded class increment preserves the computed result: prefix=%s",
  (prefix) => {
    const { lowerer, receiver } = trackedContext();
    const target = fn("update", [
      statement({
        kind: "fieldIncDec",
        obj: receiver,
        className: "Widget",
        field: "#public",
        fieldDyn: true,
        op: "+",
        prefix,
        propertyOp: "setSloppy",
        type: F64,
        loc,
      }),
    ]);
    trackClassFieldCreation(lowerer, [target]);
    const body = target.body[0]!;
    if (body.kind !== "exprStmt" || body.expr.kind !== "seqExpr")
      throw new Error("missing guarded update");
    const { stmts, result } = body.expr;
    expect(stmts.map((stmt) => stmt.kind)).toEqual([
      "varDecl",
      "varDecl",
      "varDecl",
      "varDecl",
      "if",
    ]);
    expect(stmts[1]).toMatchObject({
      init: { kind: "dynCheck", value: { kind: "fieldGet", field: "#public" } },
    });
    expect(stmts[3]).toMatchObject({ init: { kind: "dynFrom" } });
    expect(stmts[4]).toMatchObject({
      kind: "if",
      cond: {
        name: "native.checkWrite",
        args: [
          { kind: "varRef" },
          literal("#public"),
          { kind: "numLit", value: 1 },
          { kind: "varRef", localId: (stmts[3] as Extract<IrStmt, { kind: "varDecl" }>).localId },
        ],
      },
      then: [{ kind: "fieldSet" }],
    });
    expect(result).toMatchObject({
      kind: "varRef",
      localId: (stmts[prefix ? 2 : 1] as Extract<IrStmt, { kind: "varDecl" }>).localId,
    });
    expect(JSON.stringify(target.body)).not.toContain('"kind":"fieldIncDec"');
  },
);

test("guarded class fields keep the old string until admission and leave private slots alone", () => {
  const { lowerer, receiver } = trackedContext();
  const obj: IrExpr = { kind: "varRef", localId: "obj", type: receiver.type, loc };
  const old: IrExpr = { kind: "varRef", localId: "old", type: STRING, loc };
  const clear: IrStmt = {
    kind: "fieldSet",
    obj,
    className: "Widget",
    field: "%public",
    value: literal(""),
    loc,
  };
  const privateStore: IrStmt = {
    kind: "fieldSet",
    obj,
    className: "Widget",
    field: "#secret",
    value: { kind: "numLit", value: 9, type: F64, loc },
    loc,
  };
  const target = fn("append", [
    statement({
      kind: "seqExpr",
      stmts: [
        clear,
        {
          kind: "assign",
          localId: "old",
          value: { kind: "strConcat", left: old, right: literal("suffix"), type: STRING, loc },
          loc,
        },
        { ...clear, value: old },
        privateStore,
      ],
      result: old,
      type: STRING,
      loc,
    }),
  ]);
  trackClassFieldCreation(lowerer, [target]);
  const body = target.body[0]!;
  if (body.kind !== "exprStmt" || body.expr.kind !== "seqExpr") throw new Error("missing append");
  expect(body.expr.stmts.map((stmt) => stmt.kind)).toEqual(["assign", "block", "fieldSet"]);
  expect(body.expr.stmts[2]).toEqual(privateStore);
  expect(JSON.stringify(body.expr.stmts[1])).not.toContain('"value":""');
});

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

test.each([false, true])(
  "routes literal presence through class dispatch: negated=%s",
  (negated) => {
    const { lowerer, boxed, liftedFns } = context();
    lowerer.coerceToExpected = (value, type) =>
      value.type.kind === type.kind ? value : { kind: "dynFrom", value, type, loc };
    const receiver: IrExpr = { kind: "call", callee: "receiverEffect", args: [], type: DYN, loc };
    const target = fn("probe", [
      statement({
        kind: "dynHasKey",
        key: "method",
        value: receiver,
        type: BOOL,
        loc,
        ...(negated ? { negated: true as const } : {}),
      }),
    ]);
    const dispatch = new ClassDynamicDispatch();
    expect(dispatch.process(lowerer, [boxed, target])).toBe(true);
    const operation = target.body[0];
    if (operation?.kind !== "exprStmt") throw new Error("missing probe");
    const call = operation.expr.kind === "unary" ? operation.expr.operand : operation.expr;
    expect(operation.expr.kind).toBe(negated ? "unary" : "call");
    expect(call).toMatchObject({
      kind: "call",
      args: [receiver, { kind: "dynFrom", value: literal("method") }],
    });
    expect(JSON.stringify(target.body).match(/receiverEffect/g)).toHaveLength(1);
    const helper = liftedFns.find((item) => item.name.startsWith("%dyn.class.computed."));
    expect(helper?.body.at(-1)).toMatchObject({
      kind: "return",
      value: { kind: "libCall", fn: "dyn.in" },
    });
    expect(dispatch.process(lowerer, [boxed, target, ...liftedFns])).toBe(false);
  },
);

test("settles cached presence against the reflected declaration owner", () => {
  const { lowerer, boxed, liftedFns } = context();
  const base = {
    def: { name: "Base", fields: [], prototypeDataHelper: "%prototype.Base", loc },
    fields: new Map(),
    methods: new Map([["inherited", { params: [], ret: F64 }]]),
    base: null,
    subclasses: [],
    decl: {},
    prototypeObservedMethodsReady: true,
  } as unknown as ClassInfo;
  const child = {
    def: { name: "Widget", fields: [], prototypeDataHelper: "%prototype.Widget", loc },
    fields: new Map(),
    methods: new Map([["own", { params: [], ret: F64 }]]),
    base,
    subclasses: [],
    decl: {},
    prototypeObservedMethodsReady: true,
  } as unknown as ClassInfo;
  base.subclasses.push(child);
  lowerer.classes.set("Base", base);
  lowerer.classes.set("Widget", child);
  lowerer.classCanBeConstructed = () => true;
  lowerer.coerceToExpected = (value, type) =>
    value.type.kind === type.kind ? value : { kind: "dynFrom", value, type, loc };
  const target = fn("probe", [
    statement({
      kind: "dynHasKey",
      key: "inherited",
      value: variable("receiver"),
      type: BOOL,
      loc,
    }),
  ]);
  const dispatch = new ClassDynamicDispatch();
  dispatch.process(lowerer, [boxed, target]);
  const helper = liftedFns.find((item) => item.name.startsWith("%dyn.class.keys."))!;
  const answer = (name: string) => {
    const branch = helper.body.find(
      (item) =>
        item.kind === "if" &&
        item.cond.kind === "strEq" &&
        item.cond.right.kind === "strLit" &&
        item.cond.right.value === name,
    );
    if (branch?.kind !== "if" || branch.then[0]?.kind !== "return")
      throw new Error("missing key branch");
    return branch.then[0].value;
  };
  expect(answer("inherited")).toMatchObject({ kind: "ternary" });
  expect(answer("own")).toMatchObject({ kind: "ternary" });
  base.prototypeReflectionReady = true;
  dispatch.finalize(lowerer);
  expect(answer("inherited")).toMatchObject({ kind: "libCall", fn: "dyn.in" });
  expect(answer("own")).toMatchObject({ kind: "ternary" });
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
  expect(normalize.body[0]).toMatchObject({
    kind: "if",
    then: [
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
