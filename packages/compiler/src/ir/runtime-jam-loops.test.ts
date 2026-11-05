import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrType,
  type IrStmt,
} from "./ir.js";
import { everyStmtList } from "./traverse.js";
import { jamRuntimeCountLoops } from "./runtime-jam-loops.js";

const loc = { file: "runtime-jam-loops.ts", start: 0, end: 0 };
const BYTES = { kind: "bytes", elem: "f64" } as const;
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
type Op = "+" | "*" | "-" | "<" | ">" | "|" | "!==" | "&";
const bin = (op: Op, left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: op === "<" || op === ">" || op === "!==" ? BOOL : F64,
});
const and = (left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "logical",
  op: "&&",
  left,
  right,
  type: BOOL,
});
const decl = (id: string, init: IrExpr): IrStmt => ({ loc, kind: "varDecl", localId: id, init });
const set = (id: string, value: IrExpr): IrStmt => ({ loc, kind: "assign", localId: id, value });
const stepBy = (id: string, by: number): IrStmt => set(id, bin("+", ref(id), num(by)));
const when = (cond: IrExpr, then: IrStmt[]): IrStmt => ({
  loc,
  kind: "if",
  cond,
  then,
  else_: null,
});
const forLoop = (
  id: string,
  end: IrExpr,
  by: number,
  body: IrStmt[],
  start: IrExpr = num(0),
): IrStmt & { kind: "for" } => ({
  loc,
  kind: "for",
  init: decl(id, start),
  cond: bin("<", ref(id), end),
  update: stepBy(id, by),
  body,
});
const whileLoop = (cond: IrExpr, body: IrStmt[]): IrStmt => ({
  loc,
  kind: "while",
  cond,
  body,
});
const doWhile = (cond: IrExpr, body: IrStmt[]): IrStmt => ({
  loc,
  kind: "doWhile",
  cond,
  body,
});
const get = (index: IrExpr): IrExpr => ({
  loc,
  kind: "bytesIntrinsic",
  method: "get",
  receiver: { loc, kind: "varRef", localId: "cr", type: BYTES },
  args: [index],
  type: F64,
  invalidNaN: true,
});
const FN: IrType = { kind: "func", params: [], ret: F64 };
const closureOf = (captures: string[]): IrExpr => ({
  loc,
  kind: "closure",
  fnName: "%fn.0",
  captures,
  type: FN,
});
const store = (index: IrExpr, value: IrExpr): IrStmt => ({
  loc,
  kind: "bytesSet",
  arr: { loc, kind: "varRef", localId: "cr", type: BYTES },
  index,
  value,
});

/** One iteration's work in the shape the pass jams: `pre` computes the
 * iteration's seed, an inner loop refines it, `post` folds the result into
 * the value the loop carries. */
function nest(
  inner: IrStmt,
  post: IrStmt[] = [set("acc", bin("+", ref("acc"), ref("m")))],
): IrStmt[] {
  return [
    decl("acc", num(0)),
    forLoop("x", num(10), 2, [
      decl("a", bin("*", ref("x"), num(3))),
      decl("m", num(0)),
      inner,
      ...post,
    ]),
  ];
}

const countdown = (): IrStmt =>
  doWhile(and(bin("<", ref("i"), num(5)), bin("!==", ref("m"), num(0))), [
    set("m", num(0)),
    when(bin("<", ref("a"), num(20)), [set("m", bin("|", ref("m"), num(1)))]),
    set("i", bin("+", ref("i"), num(1))),
  ]);

/** `x`'s iteration keeps its own counter in `i`, declared before the inner
 * loop. */
function nestWithCounter(inner: IrStmt, post?: IrStmt[]): IrStmt[] {
  const body = nest(inner, post);
  const outer = body[1] as IrStmt & { kind: "for" };
  outer.body.splice(1, 0, decl("i", num(0)));
  return body;
}

function moduleOf(body: IrStmt[], overrides: Record<string, Partial<IrLocal>> = {}): IrModule {
  const ids = new Set<string>();
  everyStmtList(body, {
    expr: (e) => {
      if (e.kind === "varRef" && e.localId !== "cr") ids.add(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "varDecl" || s.kind === "assign") ids.add(s.localId);
      return true;
    },
  });
  const fn: IrFunction = {
    name: "render",
    params: [{ localId: "cr", name: "cr", type: BYTES }],
    locals: [
      { id: "cr", name: "cr", type: BYTES, mutable: false },
      ...[...ids].map((id) => ({
        id,
        name: id,
        type: F64,
        mutable: true,
        ...overrides[id],
      })),
    ],
    body,
    returnType: VOID,
    loc,
  };
  return { irVersion: 17, sourceFile: loc.file, entry: "render", functions: [fn] } as IrModule;
}

function forLoops(body: IrStmt[]): (IrStmt & { kind: "for" })[] {
  const found: (IrStmt & { kind: "for" })[] = [];
  everyStmtList(body, {
    expr: () => true,
    stmt: (s) => {
      if (s.kind === "for") found.push(s);
      return true;
    },
  });
  return found;
}

/** The jammed shape of `nest`: the counter declaration, the second
 * iteration's counter, the paired loop and the tail. */
function jammed(mod: IrModule): IrStmt & { kind: "block" } {
  const out = jamRuntimeCountLoops(mod);
  expect(out).not.toBe(mod);
  const outer = out.functions[0]!.body[1]!;
  expect(outer.kind).toBe("block");
  if (outer.kind !== "block") throw new Error("expected a block");
  expect(outer.body.map((s) => s.kind)).toEqual(["varDecl", "varDecl", "while", "for"]);
  return outer;
}

function renamed(id: string): boolean {
  return id.startsWith("%jam.");
}

function copyOf(id: string, copy: number): string {
  return `%jam.${copy}.${id}`;
}

test("pairs a counted loop whose body computes a seed, runs an inner loop and folds the result", () => {
  const mod = moduleOf(nestWithCounter(countdown()));
  const block = jammed(mod);
  const original = mod.functions[0]!.body[1] as IrStmt & { kind: "for" };
  const [init, next, pair, tail] = block.body;
  // The counter keeps its declaration and gains the second iteration's
  // value: one step past it, the same addition the loop's update makes.
  expect(init).toEqual(original.init);
  if (next?.kind !== "varDecl") throw new Error("expected the second counter");
  expect(next.localId).toBe("%jam.next");
  expect(next.init).toEqual(bin("+", ref("x"), num(2)));
  // The pair runs while both iterations are in range, testing the second
  // iteration's counter through the original condition.
  if (pair?.kind !== "while" || pair.cond.kind !== "logical") throw new Error("expected the pair");
  expect(pair.cond.op).toBe("&&");
  expect(pair.cond.left).toEqual(original.cond);
  const second = pair.cond.right;
  if (second.kind !== "bin" || second.left.kind !== "varRef") throw new Error("expected x2 < 10");
  expect(second.left.localId).toBe("%jam.next");
  // The tail finishes the one iteration a pair cannot take, from the
  // counter the pair leaves.
  if (tail?.kind !== "for") throw new Error("expected the tail");
  expect(tail.init).toBeNull();
  expect(tail.cond).toEqual(original.cond);
  expect(tail.body).toEqual(original.body);
  const pairLoop = forLoops(block.body);
  expect(pairLoop.map((loop) => loop.init)).toEqual([null]);
});

test("gives each copy its own locals and runs the two inner loops through live flags", () => {
  const mod = moduleOf(nestWithCounter(countdown()));
  const block = jammed(mod);
  const pair = block.body[2] as IrStmt & { kind: "while" };
  const kinds = pair.body.map((s) => s.kind);
  expect(kinds).toEqual([
    "varDecl", // a, copy 0
    "varDecl", // i, copy 0
    "varDecl", // m, copy 0
    "varDecl", // a, copy 1
    "varDecl", // i, copy 1
    "varDecl", // m, copy 1
    "varDecl", // live, copy 0
    "varDecl", // live, copy 1
    "doWhile",
    "assign",
    "assign",
    "assign", // x
    "assign", // next
  ]);
  const own = ["a", "i", "m"];
  for (let copy = 0; copy < 2; copy++)
    for (let at = 0; at < own.length; at++)
      expect((pair.body[copy * own.length + at] as IrStmt & { kind: "varDecl" }).localId).toBe(
        copyOf(own[at]!, copy),
      );
  // A `do { } while` body runs at least once, so both copies start live.
  const live = pair.body.slice(6, 8) as (IrStmt & { kind: "varDecl" })[];
  expect(live.map((s) => s.localId)).toEqual(["%jam.live", "%jam.live_"]);
  expect(live.every((s) => s.init?.kind === "boolLit" && s.init.value === true)).toBe(true);
  // The copies' inner loops share one loop: each runs only while its own
  // flag is set, and the flags are the copies' own conditions at the end.
  const fused = pair.body[8] as IrStmt & { kind: "doWhile" };
  expect(fused.kind).toBe("doWhile");
  expect(fused.body.map((s) => s.kind)).toEqual(["if", "if", "assign", "assign"]);
  const guards = fused.body.slice(0, 2) as (IrStmt & { kind: "if" })[];
  for (let copy = 0; copy < 2; copy++) {
    const guard = guards[copy]!;
    expect(guard.cond).toEqual({
      loc,
      kind: "varRef",
      localId: copy === 0 ? "%jam.live" : "%jam.live_",
      type: BOOL,
    });
    expect(guard.then.map((s) => s.kind)).toEqual(["assign", "if", "assign"]);
    expect(guard.then[2]).toEqual(set(copyOf("i", copy), bin("+", ref(copyOf("i", copy)), num(1))));
  }
  const next = fused.body.slice(2) as (IrStmt & { kind: "assign" })[];
  expect(next[0]!.localId).toBe("%jam.live");
  expect(next[1]!.localId).toBe("%jam.live_");
  // The fold runs in order, each copy reading its own refined value.
  const posts = pair.body.slice(9, 11) as (IrStmt & { kind: "assign" })[];
  expect(posts.map((s) => s.localId)).toEqual(["acc", "acc"]);
  expect(posts[0]!.value).toEqual(bin("+", ref("acc"), ref(copyOf("m", 0))));
  expect(posts[1]!.value).toEqual(bin("+", ref("acc"), ref(copyOf("m", 1))));
  // Each copy's locals are declared once, next to each other.
  const added = mod.functions[0]!.locals;
  const out = jamRuntimeCountLoops(mod).functions[0]!.locals;
  const fresh = out.slice(added.length);
  for (const id of own) {
    expect(fresh.filter((local) => local.id === copyOf(id, 0)).length).toBe(1);
    expect(fresh.filter((local) => local.id === copyOf(id, 1)).length).toBe(1);
  }
  expect(fresh.filter((local) => local.id === "%jam.next").length).toBe(1);
  expect(fresh.filter((local) => local.id.startsWith("%jam.live")).length).toBe(2);
  expect(fresh.every((local) => renamed(local.id))).toBe(true);
  // `acc` lives across iterations, so both folds write the same local.
  expect(fresh.some((local) => local.id === copyOf("acc", 0))).toBe(false);
});

test("gives a `post` closure the copy's box for the local it captures", () => {
  // `s` is boxed because `post` closes over it: every iteration gets a box
  // of its own, so each copy's closure must capture the copy's box, the one
  // its declaration initializes.
  const body = [
    decl("acc", num(0)),
    forLoop("x", num(10), 2, [
      decl("s", bin("*", ref("x"), num(10))),
      decl("i", num(0)),
      whileLoop(bin("<", ref("i"), num(3)), [set("i", bin("+", ref("i"), num(1)))]),
      set("g", closureOf(["s", "acc"])),
    ]),
  ];
  const mod = moduleOf(body, { s: { boxed: true }, g: { type: FN } });
  const block = jammed(mod);
  const pair = block.body[2] as IrStmt & { kind: "while" };
  const folds = pair.body.filter(
    (s): s is IrStmt & { kind: "assign" } => s.kind === "assign" && s.localId === "g",
  );
  expect(folds.map((s) => s.value)).toEqual([
    closureOf([copyOf("s", 0), "acc"]),
    closureOf([copyOf("s", 1), "acc"]),
  ]);
  // A binding declared outside the loop is one box both copies share: only
  // the iteration's own locals are renamed, so no copy names the original
  // `s`, whose declaration is the tail's.
  for (const fold of folds)
    expect((fold.value as IrExpr & { kind: "closure" }).captures).not.toContain("s");
  const locals = jamRuntimeCountLoops(mod).functions[0]!.locals;
  const fresh = locals.filter(
    (local) => local.id === copyOf("s", 0) || local.id === copyOf("s", 1),
  );
  expect(fresh.map((local) => local.boxed)).toEqual([true, true]);
  const tail = block.body[3] as IrStmt & { kind: "for" };
  const original = body[1] as IrStmt & { kind: "for" };
  expect(tail.body).toEqual(original.body);
});

test("starts a `while` copy from its condition and a `for` copy from its condition after the init", () => {
  const mod = moduleOf(
    nest(whileLoop(bin("<", ref("m"), num(30)), [set("m", bin("+", ref("m"), ref("a")))]), [
      set("acc", bin("+", ref("acc"), ref("m"))),
    ]),
  );
  const block = jammed(mod);
  const pair = block.body[2] as IrStmt & { kind: "while" };
  const live = pair.body.slice(4, 6) as (IrStmt & { kind: "varDecl" })[];
  // A `while` may run zero times: the flag is the copied condition itself.
  expect(live[0]!.init).toEqual(bin("<", ref(copyOf("m", 0)), num(30)));
  expect(live[1]!.init).toEqual(bin("<", ref(copyOf("m", 1)), num(30)));
  const fused = pair.body[6] as IrStmt & { kind: "while" };
  expect(fused.kind).toBe("while");
  const assertFor = (inner: IrStmt): void => {
    const mod = moduleOf(nest(inner, [set("acc", bin("+", ref("acc"), ref("m")))]));
    const pair = jammed(mod).body[2] as IrStmt & { kind: "while" };
    // The inner counter is declared before the flags and advanced inside
    // the copy's guard, after its body.
    const kinds = pair.body.map((s) => s.kind);
    expect(kinds).toEqual([
      "varDecl", // a, copy 0
      "varDecl", // m, copy 0
      "varDecl", // a, copy 1
      "varDecl", // m, copy 1
      "varDecl", // j, copy 0
      "varDecl", // j, copy 1
      "varDecl", // live, copy 0
      "varDecl", // live, copy 1
      "while", // the copies' shared loop
      "assign", // fold, copy 0
      "assign", // fold, copy 1
      "assign", // x
      "assign", // next
    ]);
    const initJ = pair.body[4] as IrStmt & { kind: "varDecl" };
    expect(initJ).toEqual(decl(copyOf("j", 0), num(0)));
    const fused = pair.body[8] as IrStmt & { kind: "while" };
    const guard = fused.body[0] as IrStmt & { kind: "if" };
    expect(guard.then[guard.then.length - 1]).toEqual(
      set(copyOf("j", 0), bin("+", ref(copyOf("j", 0)), num(1))),
    );
  };
  assertFor(forLoop("j", num(6), 1, [set("m", bin("+", ref("m"), ref("j")))]));
});

test("leaves loops whose body is not the jammable shape alone", () => {
  const reject = (body: IrStmt[], overrides: Record<string, Partial<IrLocal>> = {}): void => {
    const mod = moduleOf(body, overrides);
    expect(jamRuntimeCountLoops(mod)).toBe(mod);
  };
  // The loop carries a value across iterations before the inner loop, so
  // the second copy would run before the first fold.
  reject([
    decl("sum", num(0)),
    forLoop("x", num(10), 2, [
      set("sum", bin("+", ref("sum"), ref("x"))),
      decl("m", num(0)),
      decl("i", num(0)),
      countdown(),
      set("acc", bin("+", ref("acc"), ref("i"))),
    ]),
  ]);
  // The inner loop writes a value that lives across iterations.
  reject(
    nestWithCounter(
      doWhile(bin("<", ref("i"), num(5)), [
        set("i", bin("+", ref("i"), num(1))),
        set("acc", bin("+", ref("acc"), num(1))),
      ]),
    ),
  );
  // Two inner loops would need two loops' worth of interleaving.
  reject([
    decl("acc", num(0)),
    forLoop("x", num(10), 2, [
      decl("a", bin("*", ref("x"), num(3))),
      decl("m", num(0)),
      decl("i", num(0)),
      countdown(),
      whileLoop(bin("<", ref("m"), num(3)), [set("m", bin("+", ref("m"), num(1)))]),
      set("acc", bin("+", ref("acc"), ref("m"))),
    ]),
  ]);
  // A labelled loop's `break label` would leave from the wrong place.
  const labelled = moduleOf(nestWithCounter(countdown()));
  (labelled.functions[0]!.body[1] as IrStmt & { kind: "for" }).labels = ["outer"];
  expect(jamRuntimeCountLoops(labelled)).toBe(labelled);
  // `post` runs no code: a call could observe or change the copies.
  reject(
    nestWithCounter(countdown(), [
      {
        loc,
        kind: "exprStmt",
        expr: { loc, kind: "call", callee: "console.log", args: [ref("m")], type: VOID },
      },
    ]),
  );
  // A library call runs code the same way: `emitter.emit` calls its
  // listeners synchronously, and they may change what the second copy's
  // loop has already read.
  reject(
    nestWithCounter(countdown(), [
      {
        loc,
        kind: "exprStmt",
        expr: { loc, kind: "libCall", fn: "emitter.emit", args: [ref("m")], type: VOID },
      },
    ]),
  );
  // So does an in-place sort: the runtime hands its comparator control
  // between the two copies' loops.
  reject(
    nestWithCounter(countdown(), [
      {
        loc,
        kind: "exprStmt",
        expr: {
          loc,
          kind: "bytesIntrinsic",
          method: "sortCompare",
          receiver: { loc, kind: "varRef", localId: "cr", type: BYTES },
          args: [{ loc, kind: "varRef", localId: "m", type: F64 }],
          type: BYTES,
        },
      },
    ]),
  );
  // A promise executor runs when the promise is made, and an array sort
  // runs its comparator, so both leave `post` no more code-free.
  reject(
    nestWithCounter(countdown(), [
      decl("p", { loc, kind: "newPromise", executor: ref("m"), type: F64 }),
    ]),
  );
  reject(
    nestWithCounter(countdown(), [
      {
        loc,
        kind: "exprStmt",
        expr: {
          loc,
          kind: "arrIntrinsic",
          method: "sortDense",
          receiver: { loc, kind: "varRef", localId: "m", type: { kind: "array", elem: F64 } },
          args: [ref("m")],
          type: { kind: "array", elem: F64 },
        },
      },
    ]),
  );
  // `post` holds no control transfer.
  reject(nestWithCounter(countdown(), [{ loc, kind: "break" }]));
  // A call in a `post` statement's condition runs before the second copy's
  // loop just as one in the statement itself would.
  reject(
    nestWithCounter(countdown(), [
      when({ loc, kind: "call", callee: "console.log", args: [ref("m")], type: BOOL }, [
        set("acc", bin("+", ref("acc"), num(1))),
      ]),
    ]),
  );
  // A storing `post` rules out an inner loop that reads memory, since the
  // store may alias what the second copy's loop reads.
  const storing = (read: boolean): IrStmt[] => [
    decl("acc", num(0)),
    forLoop("x", num(10), 2, [
      decl("a", bin("*", ref("x"), num(3))),
      ...(read ? [decl("v", get(ref("x")))] : []),
      decl("m", num(0)),
      decl("i", num(0)),
      countdown(),
      store(ref("x"), ref("m")),
    ]),
  ];
  reject(storing(true));
  // The same loop without a memory read is still paired.
  const unread = moduleOf(storing(false));
  expect(jamRuntimeCountLoops(unread)).not.toBe(unread);
  // A typed-array method writes element storage the same way a `bytesSet`
  // does: the second copy's loop may read what the fill overwrites.
  const fillPost = (read: boolean): IrStmt[] => [
    decl("acc", num(0)),
    forLoop("x", num(10), 2, [
      decl("a", bin("*", ref("x"), num(3))),
      ...(read ? [decl("v", get(ref("x")))] : []),
      decl("m", num(0)),
      decl("i", num(0)),
      countdown(),
      {
        loc,
        kind: "exprStmt",
        expr: {
          loc,
          kind: "bytesIntrinsic",
          method: "fillNum",
          receiver: { loc, kind: "varRef", localId: "cr", type: BYTES },
          args: [num(0)],
          type: BYTES,
        },
      },
    ]),
  ];
  reject(fillPost(true));
  // Without an earlier memory read the fill still pairs: the copies' stores
  // run in their original order.
  const unreadFill = moduleOf(fillPost(false));
  expect(jamRuntimeCountLoops(unreadFill)).not.toBe(unreadFill);
  // Reading a typed array in `post` stores nothing, so it still pairs.
  const reading = moduleOf([
    decl("acc", num(0)),
    forLoop("x", num(10), 2, [
      decl("a", bin("*", ref("x"), num(3))),
      decl("m", num(0)),
      decl("i", num(0)),
      countdown(),
      set("acc", bin("+", ref("acc"), get(ref("x")))),
    ]),
  ]);
  expect(jamRuntimeCountLoops(reading)).not.toBe(reading);
  // The second copy's condition is tested before the first fold, so a
  // condition that reads a range the fold stores rules the pairing out.
  const memoryCond = (read: boolean): IrStmt[] => {
    const outer = forLoop("x", num(10), 2, [
      decl("a", bin("*", ref("x"), num(3))),
      decl("m", num(0)),
      decl("i", num(0)),
      countdown(),
      store(ref("x"), ref("m")),
    ]);
    outer.cond = read ? bin(">", get(ref("x")), num(0)) : bin(">", ref("x"), num(0));
    return [decl("acc", num(0)), outer];
  };
  reject(memoryCond(true));
  // The same loop with a condition that reads no memory is still paired.
  const plainCond = moduleOf(memoryCond(false));
  expect(jamRuntimeCountLoops(plainCond)).not.toBe(plainCond);
  // A `post` write that the first copy's `pre` or loop reads.
  reject(
    nestWithCounter(
      doWhile(bin("<", ref("i"), num(5)), [
        set("a", bin("-", ref("a"), num(1))),
        set("i", bin("+", ref("i"), num(1))),
      ]),
      [set("i", num(0))],
    ),
  );
  // The outer condition reads a value the body writes, which the second
  // copy's evaluation would observe before the first fold.
  reject([
    decl("acc", num(0)),
    (() => {
      const outer = forLoop("x", num(10), 2, [
        decl("a", bin("*", ref("x"), num(3))),
        decl("m", num(0)),
        decl("i", num(0)),
        countdown(),
        set("acc", bin("+", ref("acc"), ref("m"))),
      ]);
      outer.cond = bin("<", ref("x"), ref("m"));
      return outer;
    })(),
  ]);
  // The counter must be a mutable f64 that starts at a literal and steps by
  // a positive literal.
  reject(nestWithCounter(countdown()), { x: { mutable: false } });
  reject(nestWithCounter(countdown()), { x: { boxed: true } });
  reject(nestWithCounter(countdown()), { x: { tdz: true } });
  const byRef = moduleOf(nestWithCounter(countdown()));
  (byRef.functions[0]!.body[1] as IrStmt & { kind: "for" }).update = set(
    "x",
    bin("+", ref("x"), ref("i")),
  );
  expect(jamRuntimeCountLoops(byRef)).toBe(byRef);
  const byZero = moduleOf(nestWithCounter(countdown()));
  (byZero.functions[0]!.body[1] as IrStmt & { kind: "for" }).update = stepBy("x", 0);
  expect(jamRuntimeCountLoops(byZero)).toBe(byZero);
  const fromRef = moduleOf(nestWithCounter(countdown()));
  const outer = fromRef.functions[0]!.body[1] as IrStmt & { kind: "for" };
  outer.init = decl("x", ref("acc"));
  expect(jamRuntimeCountLoops(fromRef)).toBe(fromRef);
});

test("jams a loop nested inside another loop and leaves the jammed result alone", () => {
  const body = nestWithCounter(countdown());
  const inner = body[1] as IrStmt & { kind: "for" };
  const mod = moduleOf([forLoop("y", num(3), 1, [inner])]);
  const out = jamRuntimeCountLoops(mod);
  expect(out).not.toBe(mod);
  expect(forLoops(out.functions[0]!.body).length).toBe(2);
  // The pass does not pair a pair: the fused loops are `while`/`doWhile`,
  // and the tail's `for` has no init.
  expect(jamRuntimeCountLoops(out)).toBe(out);
});
