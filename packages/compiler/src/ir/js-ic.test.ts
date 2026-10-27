import { expect, test } from "vitest";
import { BOOL, DYN, STRING, VOID, type IrExpr, type IrFunction, type IrStmt } from "./ir.js";
import { JsIcSites, hasJsIcSite } from "./js-ic.js";

const loc = { file: "js-ic.ts", start: 0, end: 0 };
const ref = (id: string, type = DYN): IrExpr => ({ kind: "varRef", localId: id, type, loc });
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const call = (callee: string, ...args: IrExpr[]): IrExpr => ({
  kind: "call",
  callee,
  args,
  type: DYN,
  loc,
});
const ret = (value: IrExpr | null): IrStmt => ({ kind: "return", value, loc });

function helper(name: string, params: string[], body: IrStmt[], locals: string[] = []): IrFunction {
  return {
    name,
    params: params.map((id) => ({ localId: id, name: id, type: DYN })),
    returnType: DYN,
    locals: [...params, ...locals].map((id) => ({ id, name: id, type: DYN, mutable: false })),
    body,
    loc,
  };
}

/** `if (dyn.typedRefIs(p, "C")) return undefined` — a capsule branch. */
function capsuleBranch(param: string, fn = "dyn.typedRefIs"): IrStmt {
  return {
    kind: "if",
    cond: {
      kind: "libCall",
      fn: fn as "dyn.typedRefIs",
      args: [ref(param), str("C")],
      type: BOOL,
      loc,
    },
    then: [ret(ref(param))],
    else_: null,
    loc,
  };
}

const identityBag = helper(
  "%dyn.class.readPropertiesOrEmpty",
  ["v"],
  [capsuleBranch("v"), ret(ref("v"))],
);

function getHelper(name: string, key: string, prefix: IrStmt[] = [], bag?: IrExpr): IrFunction {
  const bagRef = ref("bag.0");
  return helper(
    name,
    ["p.0"],
    [
      ...prefix,
      { kind: "varDecl", localId: "bag.0", init: bag ?? call(identityBag.name, ref("p.0")), loc },
      ret({
        kind: "libCall",
        fn: "js.fromDyn",
        args: [
          {
            kind: "ternary",
            cond: { kind: "dynScalarEq", left: bagRef, right: ref("p.0"), type: BOOL, loc },
            then: { kind: "dynKeyGet", key: str(key), value: bagRef, type: DYN, loc },
            else_: {
              kind: "libCall",
              fn: "dyn.bagGet",
              args: [bagRef, str(key), ref("p.0")],
              type: DYN,
              loc,
            },
            type: DYN,
            loc,
          },
        ],
        type: { kind: "jsval" },
        loc,
      }),
    ],
    ["bag.0"],
  );
}

function setHelper(name: string, key: string, prefix: IrStmt[] = []): IrFunction {
  return {
    ...helper(
      name,
      ["p.0", "p.1"],
      [
        ...prefix,
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.keySet",
            args: [call("%dyn.class.properties", ref("p.0")), str(key), ref("p.1")],
            type: VOID,
            loc,
          },
          loc,
        },
        ret(null),
      ],
    ),
    returnType: VOID,
  };
}

const properties = helper("%dyn.class.properties", ["v"], [capsuleBranch("v"), ret(ref("v"))]);

function sitesOf(...functions: IrFunction[]): JsIcSites {
  return new JsIcSites({ functions: [identityBag, properties, ...functions] });
}

test("property helpers whose class branches only test capsules are cache sites", () => {
  const sites = sitesOf(
    getHelper("%dyn.class.property.0", "x", [
      capsuleBranch("p.0"),
      capsuleBranch("p.0", "dyn.classIs"),
    ]),
    setHelper("%dyn.class.property.1", "y", [capsuleBranch("p.0", "dyn.typedRefKeyIs")]),
  );
  expect(sites.site("%dyn.class.property.0")).toEqual({ kind: "get", key: "x" });
  expect(sites.site("%dyn.class.property.1")).toEqual({ kind: "set", key: "y" });
});

test("bags converted between dyn and jsval are still the receiver", () => {
  // A program that declares a class returns its bags as jsvals, and the
  // helpers read them through js.toDyn.
  const toDyn = (value: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "js.toDyn",
    args: [value],
    type: DYN,
    loc,
  });
  const fromDyn = (value: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "js.fromDyn",
    args: [value],
    type: { kind: "jsval" },
    loc,
  });
  const jsvalBag = helper(
    "%dyn.class.readPropertiesOrEmpty.js",
    ["v"],
    [capsuleBranch("v"), ret(fromDyn(ref("v")))],
  );
  const staticBag = helper("%dyn.class.staticProperties", ["v"], [ret(ref("v"))]);
  const getter = getHelper(
    "%dyn.class.property.0",
    "x",
    [capsuleBranch("p.0")],
    call(staticBag.name, toDyn(call(jsvalBag.name, ref("p.0")))),
  );
  const setter = setHelper("%dyn.class.property.1", "y");
  const write = setter.body[0] as Extract<IrStmt, { kind: "exprStmt" }>;
  const keySet = write.expr as Extract<IrExpr, { kind: "libCall" }>;
  keySet.args[0] = toDyn(call(jsvalBag.name, ref("p.0")));
  // A converted value that is not the receiver stays a helper call.
  const foreign = getHelper(
    "%dyn.class.property.2",
    "x",
    [],
    toDyn(fromDyn({ kind: "dynObjLit", type: DYN, loc } as IrExpr)),
  );
  const sites = sitesOf(jsvalBag, staticBag, getter, setter, foreign);
  expect(sites.site("%dyn.class.property.0")).toEqual({ kind: "get", key: "x" });
  expect(sites.site("%dyn.class.property.1")).toEqual({ kind: "set", key: "y" });
  expect(sites.site("%dyn.class.property.2")).toBeNull();
});

test("a bag helper may first rebind its parameter to a bag of it", () => {
  // Programs with subclasses normalize the value before the class branches.
  const normalize = helper("%dyn.class.normalize", ["v"], [capsuleBranch("v"), ret(ref("v"))]);
  const rebind = (value: IrExpr): IrStmt => ({ kind: "assign", localId: "v", value, loc });
  const normalized = helper(
    "%dyn.class.readPropertiesOrEmpty.normalized",
    ["v"],
    [rebind(call(normalize.name, ref("v"))), capsuleBranch("v"), ret(ref("v"))],
  );
  const replaced = helper(
    "%dyn.class.readPropertiesOrEmpty.replaced",
    ["v"],
    [rebind({ kind: "dynObjLit", type: DYN, loc } as IrExpr), ret(ref("v"))],
  );
  const sites = sitesOf(
    normalize,
    normalized,
    replaced,
    getHelper("%dyn.class.property.0", "x", [], call(normalized.name, ref("p.0"))),
    getHelper("%dyn.class.property.1", "x", [], call(replaced.name, ref("p.0"))),
    // The property helper itself normalizes its receiver first, too.
    getHelper("%dyn.class.property.2", "x", [
      { kind: "assign", localId: "p.0", value: call(normalize.name, ref("p.0")), loc },
      capsuleBranch("p.0"),
    ]),
  );
  expect(sites.site("%dyn.class.property.0")).toEqual({ kind: "get", key: "x" });
  expect(sites.site("%dyn.class.property.1")).toBeNull();
  expect(sites.site("%dyn.class.property.2")).toEqual({ kind: "get", key: "x" });
});

test("keyed helpers may test capsules between the key's coercion and the read", () => {
  const read = (object: IrExpr, key: string): IrExpr => ({
    kind: "libCall",
    fn: "js.fromDyn",
    args: [{ kind: "dynKeyGet", value: object, key: ref(key), type: DYN, loc }],
    type: { kind: "jsval" },
    loc,
  });
  const guard = (test: "symbol" | "nullish", tested: string, object: IrExpr): IrStmt => ({
    kind: "if",
    cond: { kind: "dynTest", test, value: ref(tested), type: BOOL, loc },
    then: [ret(read(object, "p.key"))],
    else_: null,
    loc,
  });
  const keyed = (name: string, between: IrStmt[]): IrFunction =>
    helper(
      name,
      ["p.0", "p.key"],
      [
        capsuleBranch("p.0"),
        guard("symbol", "p.key", call(identityBag.name, ref("p.0"))),
        guard("nullish", "p.0", ref("p.0")),
        {
          kind: "varDecl",
          localId: "key.string",
          init: {
            kind: "libCall",
            fn: "dyn.toStringCoerce",
            args: [ref("p.key")],
            type: STRING,
            loc,
          },
          loc,
        },
        ...between,
        ret(read(call(identityBag.name, ref("p.0")), "key.string")),
      ],
      ["key.string"],
    );
  const errorBranch: IrStmt = {
    kind: "if",
    cond: { kind: "dynTest", test: "error", value: ref("p.0"), type: BOOL, loc },
    then: [ret(ref("p.0"))],
    else_: null,
    loc,
  };
  const sites = sitesOf(
    keyed("%dyn.class.computed.0", []),
    keyed("%dyn.class.computed.1", [capsuleBranch("p.0"), capsuleBranch("p.0", "dyn.classIs")]),
    keyed("%dyn.class.computed.2", [errorBranch]),
  );
  expect(sites.site("%dyn.class.computed.0")).toEqual({ kind: "keyed" });
  expect(sites.site("%dyn.class.computed.1")).toEqual({ kind: "keyed" });
  expect(sites.site("%dyn.class.computed.2")).toBeNull();
});

test("any other prefix or tail keeps the helper call", () => {
  const errorBranch: IrStmt = {
    kind: "if",
    cond: { kind: "dynTest", test: "error", value: ref("p.0"), type: BOOL, loc },
    then: [ret(ref("p.0"))],
    else_: null,
    loc,
  };
  // A branch an ordinary object can take (toString of an error object).
  const withError = getHelper("%dyn.class.property.0", "toString", [errorBranch]);
  // A bag that is not the receiver for ordinary objects.
  const otherBag = helper("%dyn.class.other", ["v"], [ret({ kind: "dynObjLit", type: DYN, loc })]);
  const foreignBag = getHelper("%dyn.class.property.1", "x", [], call(otherBag.name, ref("p.0")));
  // A function outside the generated helper family.
  const userFn = { ...getHelper("%dyn.class.property.2", "x"), name: "user" };
  const sites = sitesOf(withError, otherBag, foreignBag, userFn);
  expect(sites.site("%dyn.class.property.0")).toBeNull();
  expect(sites.site("%dyn.class.property.1")).toBeNull();
  expect(sites.site("user")).toBeNull();
  expect(sites.site("%dyn.class.missing")).toBeNull();
});

test("a function holds a site when it calls a classified helper or dispatches a method", () => {
  const getter = getHelper("%dyn.class.property.0", "x");
  const sites = sitesOf(getter);
  const caller = helper("f", ["o"], [ret(call(getter.name, ref("o")))]);
  const invoker = helper(
    "g",
    ["o"],
    [
      ret({
        kind: "dynInvoke",
        recv: ref("o"),
        method: "m",
        calleeName: "o.m",
        args: [],
        type: DYN,
        loc,
      }),
    ],
  );
  const plain = helper("h", ["o"], [ret(ref("o"))]);
  expect(hasJsIcSite(caller, sites)).toBe(true);
  expect(hasJsIcSite(invoker, sites)).toBe(true);
  expect(hasJsIcSite(plain, sites)).toBe(false);
  // Module initializers keep plain method dispatch (top-level handle
  // wiring), while their property sites still cache.
  expect(hasJsIcSite({ ...invoker, name: "%init.0" }, sites)).toBe(false);
  expect(hasJsIcSite({ ...caller, name: "%init.0" }, sites)).toBe(true);
});

test("a function holds a site when an object literal has a constant-key member", () => {
  const sites = sitesOf();
  const literal = (key: IrExpr): IrFunction =>
    helper(
      "f",
      ["o"],
      [ret({ kind: "dynObjLit", fields: [{ key, value: ref("o") }], type: DYN, loc })],
    );
  expect(hasJsIcSite(literal(str("x")), sites)).toBe(true);
  // `__proto__` sets the prototype, and a computed key has no constant
  // name: both keep the generic member store.
  expect(hasJsIcSite(literal(str("__proto__")), sites)).toBe(false);
  expect(hasJsIcSite(literal(ref("k")), sites)).toBe(false);
  // Module initializers build their literals once.
  expect(hasJsIcSite({ ...literal(str("x")), name: "%init.0" }, sites)).toBe(false);
});

test("bag helpers that exit early for values no class branch matches are still the receiver", () => {
  /** `if (!<test>(v)) return <value>`: the class tables' early exit. */
  const exit = (test: "classCapsule" | "funcKind", value: IrExpr, negated = true): IrStmt => ({
    kind: "if",
    cond: {
      kind: "dynTest",
      test,
      ...(negated ? { negated: true as const } : {}),
      value: ref("v"),
      type: BOOL,
      loc,
    },
    then: [ret(value)],
    else_: null,
    loc,
  });
  const guarded = (name: string, first: IrStmt): IrFunction =>
    helper(name, ["v"], [first, capsuleBranch("v"), ret(ref("v"))]);
  const readBag = guarded("%dyn.class.readPropertiesOrEmpty", exit("classCapsule", ref("v")));
  const writeBag = guarded("%dyn.class.properties", exit("classCapsule", ref("v")));
  const staticBag = guarded("%dyn.class.staticProperties", exit("funcKind", ref("v")));
  const getter = getHelper(
    "%dyn.class.property.0",
    "x",
    [],
    call(staticBag.name, call(readBag.name, ref("p.0"))),
  );
  const setter = setHelper("%dyn.class.property.1", "y");
  // An exit that returns another value, or a test that is not negated,
  // makes the bag differ from the receiver.
  const otherExit = guarded(
    "%dyn.class.other",
    exit("classCapsule", { kind: "dynObjLit", type: DYN, loc } as IrExpr),
  );
  const positive = guarded("%dyn.class.positive", exit("classCapsule", ref("v"), false));
  const otherGetter = getHelper("%dyn.class.property.2", "x", [], call(otherExit.name, ref("p.0")));
  const positiveGetter = getHelper(
    "%dyn.class.property.3",
    "x",
    [],
    call(positive.name, ref("p.0")),
  );
  const sites = new JsIcSites({
    functions: [
      readBag,
      writeBag,
      staticBag,
      otherExit,
      positive,
      getter,
      setter,
      otherGetter,
      positiveGetter,
    ],
  });
  expect(sites.site("%dyn.class.property.0")).toEqual({ kind: "get", key: "x" });
  expect(sites.site("%dyn.class.property.1")).toEqual({ kind: "set", key: "y" });
  expect(sites.site("%dyn.class.property.2")).toBeNull();
  expect(sites.site("%dyn.class.property.3")).toBeNull();
});

test("helpers that answer plain values first with the same operation are cache sites", () => {
  const negated = (test: "classCapsule" | "funcKind"): IrExpr => ({
    kind: "dynTest",
    test,
    negated: true,
    value: ref("p.0"),
    type: BOOL,
    loc,
  });
  const exit = (body: IrStmt[], test: IrExpr = negated("classCapsule")): IrStmt => ({
    kind: "if",
    cond: test,
    then: [{ kind: "if", cond: negated("funcKind"), then: body, else_: null, loc }],
    else_: null,
    loc,
  });
  const store = (key: string): IrStmt[] => [
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySet",
        args: [ref("p.0"), str(key), ref("p.1")],
        type: VOID,
        loc,
      },
      loc,
    },
    ret(null),
  ];
  const load = (key: string): IrStmt[] => [
    ret({ kind: "dynKeyGet", value: ref("p.0"), key: str(key), type: DYN, loc }),
  ];
  const sites = sitesOf(
    setHelper("%dyn.class.property.0", "x", [exit(store("x")), capsuleBranch("p.0")]),
    getHelper("%dyn.class.property.1", "x", [exit(load("x")), capsuleBranch("p.0")]),
    // An exit for another key, or one plain values do not take.
    setHelper("%dyn.class.property.2", "x", [exit(store("y"))]),
    setHelper("%dyn.class.property.3", "x", [
      exit(store("x"), {
        kind: "dynTest",
        test: "classCapsule",
        value: ref("p.0"),
        type: BOOL,
        loc,
      }),
    ]),
  );
  expect(sites.site("%dyn.class.property.0")).toEqual({ kind: "set", key: "x" });
  expect(sites.site("%dyn.class.property.1")).toEqual({ kind: "get", key: "x" });
  expect(sites.site("%dyn.class.property.2")).toBeNull();
  expect(sites.site("%dyn.class.property.3")).toBeNull();
});
