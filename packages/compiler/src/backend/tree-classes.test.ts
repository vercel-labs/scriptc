import { expect, test } from "vitest";
import {
  F64,
  arrayOf,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrParam,
  type IrStmt,
  type IrType,
} from "../ir/ir.js";
import { planTreeClasses } from "./tree-classes.js";

const loc = { file: "tree.ts", start: 0, end: 1 };
const NODE: IrType = { kind: "object", className: "Node" };
const MAYBE_NODE: IrType = { kind: "union", unionId: "u0" };
const F64_T = F64;

const local = (id: string, type: IrType, mutable = false) => ({ id, name: id, type, mutable });

/** `x` as an expression. */
const at = (localId: string, type: IrType = NODE): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const wrap = (tag: number, value: IrExpr): IrExpr => ({
  kind: "unionWrap",
  unionId: "u0",
  tag,
  value,
  type: MAYBE_NODE,
  loc,
});
const nil = (): IrExpr => wrap(0, { kind: "unitLit", unit: "null", type: { kind: "nullT" }, loc });
const narrow = (value: IrExpr): IrExpr => ({
  kind: "unionNarrow",
  unionId: "u0",
  tag: 1,
  value,
  type: NODE,
  loc,
});
const isNil = (value: IrExpr): IrExpr => ({
  kind: "unionIsTag",
  unionId: "u0",
  tag: 0,
  negated: false,
  value,
  type: { kind: "bool" },
  loc,
});
const call = (callee: string, args: IrExpr[], type: IrType): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});
const field = (obj: IrExpr, name: string): IrExpr => ({
  kind: "fieldGet",
  obj,
  className: "Node",
  field: name,
  type: MAYBE_NODE,
  loc,
});
const construct = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "new",
  className: "Node",
  args: [left, right],
  type: NODE,
  loc,
});
const ret = (value: IrExpr | null): IrStmt => ({ kind: "return", value, loc });
const store = (obj: IrExpr, field: string, value: IrExpr): IrStmt => ({
  kind: "fieldSet",
  obj,
  className: "Node",
  field,
  value,
  loc,
});
/** A write to a field of `this` in the constructor. */
const init = (field: string, value: IrExpr): IrStmt => store(at("this.0"), field, value);

function param(localId: string, type: IrType, owned?: true): IrParam {
  return owned === undefined
    ? { localId, name: localId, type }
    : { localId, name: localId, type, owned };
}

function fn(
  name: string,
  params: IrParam[],
  returnType: IrType,
  body: IrStmt[],
  locals: IrFunction["locals"] = [],
): IrFunction {
  return {
    name,
    params,
    returnType,
    locals: [...params.map((p) => local(p.localId, p.type)), ...locals],
    body,
    loc,
  };
}

/** The binary-trees recursion: a node owns two nullable children and the
 * constructor is the only writer of both fields. */
function tree(over: { ctorBody?: IrStmt[]; functions?: IrFunction[] } = {}): IrModule {
  const node: IrClassDef = {
    name: "Node",
    fields: [
      { name: "left", type: MAYBE_NODE },
      { name: "right", type: MAYBE_NODE },
    ],
    loc,
  };
  const ctor = fn(
    "%Node.constructor",
    [param("this.0", NODE), param("left.0", MAYBE_NODE), param("right.0", MAYBE_NODE)],
    { kind: "void" },
    over.ctorBody ?? [
      init("left", at("left.0", MAYBE_NODE)),
      init("right", at("right.0", MAYBE_NODE)),
    ],
  );
  const build = fn("bottomUpTree", [param("depth.0", F64_T)], NODE, [
    {
      kind: "if",
      cond: {
        kind: "bin",
        op: "===",
        left: at("depth.0", F64_T),
        right: { kind: "numLit", value: 0, type: F64_T, loc },
        type: { kind: "bool" },
        loc,
      },
      then: [ret(construct(nil(), nil()))],
      else_: null,
      loc,
    },
    {
      kind: "return",
      value: construct(
        wrap(
          1,
          call(
            "bottomUpTree",
            [
              {
                kind: "bin",
                op: "-",
                left: at("depth.0", F64_T),
                right: { kind: "numLit", value: 1, type: F64_T, loc },
                type: F64_T,
                loc,
              },
            ],
            NODE,
          ),
        ),
        wrap(
          1,
          call(
            "bottomUpTree",
            [
              {
                kind: "bin",
                op: "-",
                left: at("depth.0", F64_T),
                right: { kind: "numLit", value: 1, type: F64_T, loc },
                type: F64_T,
                loc,
              },
            ],
            NODE,
          ),
        ),
      ),
      loc,
    },
  ]);
  const count = fn("nodeCount", [param("tree.0", NODE)], F64_T, [
    {
      kind: "if",
      cond: {
        kind: "logical",
        op: "||",
        left: isNil(field(at("tree.0"), "left")),
        right: isNil(field(at("tree.0"), "right")),
        type: { kind: "bool" },
        loc,
      },
      then: [ret({ kind: "numLit", value: 1, type: F64_T, loc })],
      else_: null,
      loc,
    },
    {
      kind: "return",
      value: {
        kind: "bin",
        op: "+",
        left: { kind: "numLit", value: 1, type: F64_T, loc },
        right: {
          kind: "bin",
          op: "+",
          left: call("nodeCount", [narrow(field(at("tree.0"), "left"))], F64_T),
          right: call("nodeCount", [narrow(field(at("tree.0"), "right"))], F64_T),
          type: F64_T,
          loc,
        },
        type: F64_T,
        loc,
      },
      loc,
    },
  ]);
  const main = fn(
    "%init.0",
    [],
    { kind: "void" },
    [
      {
        kind: "varDecl",
        localId: "t.0",
        init: call("bottomUpTree", [{ kind: "numLit", value: 10, type: F64_T, loc }], NODE),
        loc,
      },
      { kind: "exprStmt", expr: call("nodeCount", [at("t.0")], F64_T), loc },
    ],
    [local("t.0", NODE)],
  );
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "%init.0",
    functions: [ctor, build, count, main, ...(over.functions ?? [])],
    classes: [node],
    unions: [{ id: "u0", arms: [{ kind: "nullT" }, NODE] }],
  };
}

/** nodeCount reads its parameter without owning it, and so does the
 * constructor's body read `this`; bottomUpTree owns the node it returns. */
const FACTS = {
  borrowed: new Map([
    ["nodeCount", new Set([0])],
    ["%Node.constructor", new Set([0])],
  ]),
};

test("a binary tree drops its reference-count word", () => {
  const plan = planTreeClasses(tree(), FACTS);
  expect([...plan.classes]).toEqual(["Node"]);
  expect([...plan.rejected]).toEqual([]);
});

test("the accepted plan names the reads that transfer a node", () => {
  const plan = planTreeClasses(tree(), FACTS);
  // The constructor's two field stores are the reads that hand each
  // argument to the node; nodeCount's reads of its parameter borrow it.
  const moved = [...plan.moves].flatMap((e) => (e.kind === "varRef" ? [e.localId] : []));
  expect(moved).toEqual(["left.0", "right.0"]);
});

test("a class that keeps the count contributes no moves", () => {
  const mod = tree();
  mod.records = [{ id: "r0", fields: [{ name: "tree", type: NODE }] }];
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect([...plan.moves]).toEqual([]);
});

test("a field a later write can retarget keeps the count", () => {
  const mod = tree();
  mod.functions.push(
    fn("retarget", [param("t.0", NODE)], { kind: "void" }, [
      store(at("t.0"), "left", construct(nil(), nil())),
    ]),
  );
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  // The rewritten edge is a mutable one, which is exactly a potential
  // cycle: the cycle analysis refuses the class before the immutability
  // rule is even consulted.
  expect(plan.rejected.get("Node")).toContain("is on a cycle or reaches one");
});

test("a node stored in a record field keeps the count", () => {
  const mod = tree();
  mod.records = [{ id: "r0", fields: [{ name: "tree", type: NODE }] }];
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect(plan.rejected.get("Node")?.[0]).toContain("lets a reference escape the tree discipline");
});

test("a node reaching a dynamic value keeps the count", () => {
  const mod = tree();
  mod.functions.push(
    fn("show", [param("t.0", NODE)], { kind: "void" }, [
      {
        kind: "exprStmt",
        expr: { kind: "dynFrom", value: at("t.0"), type: { kind: "dyn" }, loc },
        loc,
      },
    ]),
  );
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect(plan.rejected.get("Node")?.[0]).toContain("dynFrom expression holds one");
});

test("a node handed to a consuming callee keeps the count", () => {
  const mod = tree();
  mod.functions.push(
    fn("keep", [param("t.0", NODE, true)], { kind: "void" }, []),
    fn("hand", [param("t.0", NODE)], { kind: "void" }, [
      {
        kind: "exprStmt",
        expr: call("keep", [field(at("t.0"), "left") as IrExpr], { kind: "void" }),
        loc,
      },
    ]),
  );
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect([...(plan.rejected.get("Node") ?? [])]).toEqual(
    expect.arrayContaining([expect.stringContaining("consumes a node that comes from a field")]),
  );
});

test("a node returned from a field keeps the count", () => {
  const mod = tree();
  mod.functions.push(
    fn("leftOf", [param("t.0", NODE)], MAYBE_NODE, [ret(field(at("t.0"), "left"))]),
  );
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect([...(plan.rejected.get("Node") ?? [])]).toEqual(
    expect.arrayContaining([expect.stringContaining("returns a node it only borrows")]),
  );
});

test("a constructor that lets this escape keeps the count", () => {
  const mod = tree({
    ctorBody: [
      init("left", at("left.0", MAYBE_NODE)),
      init("right", at("right.0", MAYBE_NODE)),
      ret(at("this.0")),
    ],
  });
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect(plan.rejected.get("Node")).toContain("its constructor lets this escape");
});

test("an array of nodes keeps the count", () => {
  const mod = tree();
  mod.globals = [{ id: "%g.m.trees", name: "trees", type: arrayOf(NODE), mutable: false }];
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect(plan.rejected.get("Node")?.length).toBeGreaterThan(0);
});

test("a node a function only builds inside an expression keeps the count", () => {
  // `show` names no tree local and returns nothing but a number, yet its
  // temporary expression hands a freshly built node to a dynamic value. The
  // function must still be walked, because the lowering frees that node
  // where the statement ends.
  const mod = tree();
  mod.functions.push(
    fn("show", [], F64_T, [
      {
        kind: "exprStmt",
        expr: { kind: "dynFrom", value: construct(nil(), nil()), type: { kind: "dyn" }, loc },
        loc,
      },
      ret({ kind: "numLit", value: 1, type: F64_T, loc }),
    ]),
  );
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect(plan.rejected.get("Node")?.[0]).toContain("dynFrom expression holds one");
});

test("a local both branches moved is not read after the join", () => {
  // Each branch hands the parameter to a consuming callee, so the binding
  // holds nothing on either path; a read after the `if` reads a slot the
  // lowering cleared on both.
  const mod = tree();
  const hand = (): IrStmt => ({
    kind: "exprStmt",
    expr: call("keep", [at("t.0")], { kind: "void" }),
    loc,
  });
  mod.functions.push(
    fn("keep", [param("k.0", NODE, true)], { kind: "void" }, []),
    fn("twice", [param("t.0", NODE)], F64_T, [
      {
        kind: "if",
        cond: { kind: "boolLit", value: true, type: { kind: "bool" }, loc },
        then: [hand()],
        else_: [hand()],
        loc,
      },
      hand(),
      ret({ kind: "numLit", value: 0, type: F64_T, loc }),
    ]),
  );
  const plan = planTreeClasses(mod, FACTS);
  expect([...plan.classes]).toEqual([]);
  expect(plan.rejected.get("Node")).toEqual(
    expect.arrayContaining([expect.stringContaining("local t.0 is used after it was moved")]),
  );
});

test("each class is judged by the slots that mention it, in module order", () => {
  // Two classes share a module. A slot that reaches a class through a
  // container, a map value or a function type counts for that class and for
  // no other, and the reasons keep the order of the module's slots.
  const OTHER: IrType = { kind: "object", className: "Other" };
  const mod = tree();
  mod.classes!.push({ name: "Other", fields: [{ name: "n", type: F64_T }], loc });
  mod.functions.push(
    fn("%Other.constructor", [param("this.1", OTHER)], { kind: "void" }, []),
    fn("pick", [param("all.0", arrayOf(OTHER))], F64_T, [
      ret({ kind: "numLit", value: 0, type: F64_T, loc }),
    ]),
  );
  mod.records = [
    {
      id: "r0",
      fields: [{ name: "make", type: { kind: "func", params: [OTHER], ret: MAYBE_NODE } }],
    },
  ];
  mod.globals = [
    {
      id: "%g.m.byName",
      name: "byName",
      type: { kind: "map", key: { kind: "string" }, value: OTHER },
      mutable: false,
    },
    { id: "%g.m.trees", name: "trees", type: arrayOf(NODE), mutable: false },
  ];
  const plan = planTreeClasses(mod, {
    borrowed: new Map([...FACTS.borrowed, ["%Other.constructor", new Set([0])]]),
  });
  const unfit = "holds it in a type that is neither the class nor null or it";
  expect([...plan.classes]).toEqual([]);
  expect(plan.rejected.get("Node")).toEqual([
    `record r0 field make ${unfit}`,
    `global trees ${unfit}`,
  ]);
  expect(plan.rejected.get("Other")).toEqual([
    `pick parameter all.0 ${unfit}`,
    `pick local all.0 ${unfit}`,
    `record r0 field make ${unfit}`,
    `global byName ${unfit}`,
  ]);
});

test("a union that reaches itself through a container is walked once", () => {
  // `type Forest = Node | Forest[]` in a global: the class is mentioned
  // through the union's own array arm, and the slot keeps the count. A
  // second class the union does not reach is judged without it.
  const FOREST: IrType = { kind: "union", unionId: "u.forest" };
  const WOODS: IrType = { kind: "union", unionId: "u.woods" };
  const OTHER: IrType = { kind: "object", className: "Other" };
  const mod = tree();
  mod.unions!.push(
    { id: "u.forest", arms: [arrayOf(WOODS), NODE] },
    // Two unions that reach each other: each mentions what the other does.
    { id: "u.woods", arms: [arrayOf(FOREST), { kind: "nullT" }] },
  );
  mod.classes!.push({ name: "Other", fields: [{ name: "n", type: F64_T }], loc });
  mod.functions.push(fn("%Other.constructor", [param("this.1", OTHER)], { kind: "void" }, []));
  mod.globals = [
    { id: "%g.m.woods", name: "woods", type: WOODS, mutable: false },
    { id: "%g.m.forest", name: "forest", type: FOREST, mutable: false },
  ];
  const plan = planTreeClasses(mod, {
    borrowed: new Map([...FACTS.borrowed, ["%Other.constructor", new Set([0])]]),
  });
  const unfit = "holds it in a type that is neither the class nor null or it";
  expect([...plan.classes]).toEqual(["Other"]);
  expect(plan.rejected.get("Node")).toEqual([
    `global woods ${unfit}`,
    `global forest ${unfit}`,
    `union u.forest ${unfit}`,
    `union u.woods ${unfit}`,
  ]);
});

test("a class whose own field holds a self-reaching union is judged", () => {
  // `type Json = string | Json[]; class Other { data: Json }`: the rule
  // about reference fields asks whether the field's type leads back to the
  // class, and that question follows the union's array arm into the union.
  const JSON_T: IrType = { kind: "union", unionId: "u.json" };
  const OTHER: IrType = { kind: "object", className: "Other" };
  const mod = tree();
  mod.unions!.push({ id: "u.json", arms: [{ kind: "string" }, arrayOf(JSON_T)] });
  mod.classes!.push({ name: "Other", fields: [{ name: "data", type: JSON_T }], loc });
  mod.functions.push(fn("%Other.constructor", [param("this.1", OTHER)], { kind: "void" }, []));
  const plan = planTreeClasses(mod, {
    borrowed: new Map([...FACTS.borrowed, ["%Other.constructor", new Set([0])]]),
  });
  expect([...plan.classes]).toEqual(["Node", "Other"]);
  expect([...plan.rejected]).toEqual([]);
});

test("a function that holds a node beside a self-reaching union is checked", () => {
  // The linear-use check asks every local, result and expression type of a
  // function that mentions the class whether it holds a node. Two unions
  // that reach each other and never the class answer no.
  const EVEN: IrType = { kind: "union", unionId: "u.even" };
  const ODD: IrType = { kind: "union", unionId: "u.odd" };
  const mod = tree({
    functions: [
      fn(
        "weigh",
        [param("tree.1", NODE), param("extra.1", EVEN)],
        F64_T,
        [
          { kind: "varDecl", localId: "seen.1", init: at("extra.1", EVEN), loc },
          ret(call("nodeCount", [at("tree.1")], F64_T)),
        ],
        [local("seen.1", EVEN)],
      ),
    ],
  });
  mod.unions!.push(
    { id: "u.even", arms: [F64_T, arrayOf(ODD)] },
    { id: "u.odd", arms: [{ kind: "string" }, arrayOf(EVEN)] },
  );
  const plan = planTreeClasses(mod, {
    borrowed: new Map([...FACTS.borrowed, ["weigh", new Set([0])]]),
  });
  expect([...plan.classes]).toEqual(["Node"]);
  expect([...plan.rejected]).toEqual([]);
});

test("a module with a self-reaching union and no class is planned without a walk", () => {
  const JSON_T: IrType = { kind: "union", unionId: "u.json" };
  const plan = planTreeClasses(
    {
      irVersion: 17,
      sourceFile: loc.file,
      entry: "%init.0",
      functions: [fn("%init.0", [], { kind: "void" }, [], [local("j.0", JSON_T)])],
      unions: [{ id: "u.json", arms: [{ kind: "string" }, arrayOf(JSON_T)] }],
    },
    { borrowed: new Map() },
  );
  expect([...plan.classes]).toEqual([]);
  expect([...plan.rejected]).toEqual([]);
});
