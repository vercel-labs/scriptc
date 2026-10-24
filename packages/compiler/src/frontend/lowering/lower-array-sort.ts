import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
  VOID,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  funcOf,
} from "../../ir/ir.js";
import { numLit } from "../../ir/build.js";
import { transformStmtList } from "../../ir/traverse.js";

type SortLocal = IrExpr & { kind: "varRef" };
/** `f(left, right) < 0`: the one comparison TimSort makes. */
type Less = (left: IrExpr, right: IrExpr) => IrExpr;

/** Small IR vocabulary shared by the array and byte sort helpers. */
class SortIr {
  readonly locals: IrLocal[] = [];
  constructor(readonly loc: SrcLoc) {}

  local(name: string, type: IrType = F64): SortLocal {
    const id = name + ".0";
    this.locals.push({ id, name, type, mutable: true });
    return { kind: "varRef", localId: id, type, loc: this.loc };
  }
  num(value: number): IrExpr {
    return numLit(value, this.loc);
  }
  bind(local: SortLocal, init: IrExpr): IrStmt {
    return { kind: "varDecl", localId: local.localId, init, loc: this.loc };
  }
  assign(local: SortLocal, value: IrExpr): IrStmt {
    return { kind: "assign", localId: local.localId, value, loc: this.loc };
  }
  add(left: IrExpr, right: IrExpr): IrExpr {
    return { kind: "bin", op: "+", left, right, type: F64, loc: this.loc };
  }
  sub(left: IrExpr, right: IrExpr): IrExpr {
    return { kind: "bin", op: "-", left, right, type: F64, loc: this.loc };
  }
  lt(left: IrExpr, right: IrExpr): IrExpr {
    return { kind: "bin", op: "<", left, right, type: BOOL, loc: this.loc };
  }
  eq(left: IrExpr, right: IrExpr): IrExpr {
    return { kind: "bin", op: "===", left, right, type: BOOL, loc: this.loc };
  }
  not(operand: IrExpr): IrExpr {
    return { kind: "unary", op: "!", operand, type: BOOL, loc: this.loc };
  }
  choose(cond: IrExpr, then: IrExpr, else_: IrExpr): IrExpr {
    return { kind: "ternary", cond, then, else_, type: then.type, loc: this.loc };
  }
  branch(cond: IrExpr, then: IrStmt[], else_: IrStmt[] | null = null): IrStmt {
    return { kind: "if", cond, then, else_, loc: this.loc };
  }
  while(cond: IrExpr, body: IrStmt[]): IrStmt {
    return { kind: "while", cond, body, loc: this.loc };
  }
  step(local: SortLocal, amount = 1): IrStmt {
    return this.assign(local, this.add(local, this.num(amount)));
  }
  loop(index: SortLocal, start: IrExpr, end: IrExpr, body: IrStmt[]): IrStmt {
    return {
      kind: "for",
      init: this.bind(index, start),
      cond: this.lt(index, end),
      update: this.step(index),
      body,
      loc: this.loc,
    };
  }
  length(receiver: IrExpr): IrExpr {
    return receiver.type.kind === "bytes"
      ? { kind: "bytesIntrinsic", method: "length", receiver, args: [], type: F64, loc: this.loc }
      : { kind: "arrIntrinsic", method: "length", receiver, args: [], type: F64, loc: this.loc };
  }
  at(arr: IrExpr, index: IrExpr): IrExpr {
    return arr.type.kind === "bytes"
      ? {
          kind: "bytesIntrinsic",
          method: "get",
          receiver: arr,
          args: [index],
          type: F64,
          loc: this.loc,
        }
      : {
          kind: "arrayGet",
          arr,
          index,
          type: arr.type.kind === "array" ? arr.type.elem : F64,
          loc: this.loc,
        };
  }
  set(arr: IrExpr, index: IrExpr, value: IrExpr): IrStmt {
    return {
      kind: arr.type.kind === "bytes" ? "bytesSet" : "arraySet",
      arr,
      index,
      value,
      loc: this.loc,
    };
  }
  allocate(type: IrType, length: IrExpr): IrExpr {
    return type.kind === "bytes"
      ? { kind: "bytesNew", source: length, type, loc: this.loc }
      : { kind: "arrayLit", elems: [], type, loc: this.loc };
  }
}

/** The builders reuse local references, constants and comparator operands at
 * several sites. Give every site its own node: per-node emitter analyses then
 * see the same tree as a serialized IR artifact, and facts proved at one site
 * cannot be merged with another. */
function distinctNodes(body: IrStmt[]): IrStmt[] {
  return transformStmtList(body, {
    expr: (node) => {
      switch (node.kind) {
        case "varRef":
          return { ...node };
        case "numLit":
          return { ...node };
        case "boolLit":
          return { ...node };
        default:
          return node;
      }
    },
    stmt: (node) => (node.kind === "break" ? { ...node } : node),
  });
}

/** V8's TimSort (third_party/v8/builtins/array-sort.tq) over the first `n`
 * slots of an owned snapshot, step for step like the runtime's
 * (scr_array.c): the same minimum run length, run detection, binary
 * insertion, run-stack invariants, galloping merges and adaptive gallop
 * threshold. Every comparison is `less(x, y)`, the comparator's
 * `f(x, y) < 0`, so the comparator sees Node's calls in Node's order. Every
 * callback still uses ordinary IR exception/ownership handling; the
 * caller's array is only written after sorting succeeds. */
function timSort(b: SortIr, src: SortLocal, n: IrExpr, less: Less): IrStmt[] {
  return [b.branch(b.lt(b.num(1), n), timSortBody(b, src, n, less))];
}

function timSortBody(b: SortIr, src: SortLocal, n: IrExpr, less: Less): IrStmt[] {
  const elem = src.type.kind === "array" ? src.type.elem : F64;
  const loc = b.loc;
  let labels = 0;
  const local = (name: string, type: IrType = F64) => b.local(name, type);
  const zero = b.num(0),
    one = b.num(1),
    two = b.num(2);
  const at = (arr: IrExpr, index: IrExpr): IrExpr => b.at(arr, index);
  const ge = (left: IrExpr, right: IrExpr): IrExpr => b.not(b.lt(left, right));
  const le = (left: IrExpr, right: IrExpr): IrExpr => b.not(b.lt(right, left));
  const and = (left: IrExpr, right: IrExpr): IrExpr => ({
    kind: "logical",
    op: "&&",
    left,
    right,
    type: BOOL,
    loc,
  });
  const or = (left: IrExpr, right: IrExpr): IrExpr => ({
    kind: "logical",
    op: "||",
    left,
    right,
    type: BOOL,
    loc,
  });
  const truth: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
  const forever = (body: IrStmt[]): IrStmt => b.while(truth, body);
  const brk = (label?: string): IrStmt => ({ kind: "break", ...(label ? { label } : {}), loc });
  const block = (label: string, body: IrStmt[]): IrStmt => ({
    kind: "block",
    body,
    labels: [label],
    loc,
  });
  const half = (low: IrExpr, high: IrExpr): IrExpr =>
    b.add(low, {
      kind: "libCall",
      fn: "math.floor",
      args: [{ kind: "bin", op: "/", left: b.sub(high, low), right: two, type: F64, loc }],
      type: F64,
      loc,
    });
  const min = (x: IrExpr, y: IrExpr): IrExpr => b.choose(b.lt(x, y), x, y);
  /** Copies `count` slots between arrays (or within one, front to back). */
  const copyForward = (from: IrExpr, fromAt: IrExpr, to: IrExpr, toAt: IrExpr, count: IrExpr) => [
    b.assign(cp, zero),
    b.while(b.lt(cp, count), [b.set(to, b.add(toAt, cp), at(from, b.add(fromAt, cp))), b.step(cp)]),
  ];
  /** Copies `count` slots within `src` back to front (overlap to the right). */
  const copyBackward = (fromAt: IrExpr, toAt: IrExpr, count: IrExpr) => [
    b.assign(cp, count),
    b.while(b.lt(zero, cp), [
      b.step(cp, -1),
      b.set(src, b.add(toAt, cp), at(src, b.add(fromAt, cp))),
    ]),
  ];

  const minGallop = local("minGallop");
  const runBase = local("runBase", arrayOf(F64));
  const runLen = local("runLen", arrayOf(F64));
  const runs = local("runs");
  const cp = local("copyIndex");
  // Gallop search state; searches never nest.
  const gLast = local("gallopLast");
  const gOfs = local("gallopOffset");
  const gMax = local("gallopMax");
  const gMid = local("gallopMid");
  const gTmp = local("gallopTmp");
  const gBase = local("gallopBase");
  const gLength = local("gallopLength");
  const gHint = local("gallopHint");
  const gKey = local("gallopKey", elem);

  /** gallopLeft/gallopRight: assigns `out` the offset k in [0, length] of
   * `key` in arr[base .. base + length), starting the search at `hint`. */
  const gallop = (
    right: boolean,
    out: SortLocal,
    arr: IrExpr,
    key: IrExpr,
    base: IrExpr,
    lengthExpr: IrExpr,
    hintExpr: IrExpr,
  ): IrStmt[] => {
    // gallopLeft tests arr[i] < key; gallopRight tests key < arr[i].
    const probe = (index: IrExpr): IrExpr =>
      right ? less(gKey, at(arr, b.add(gBase, index))) : less(at(arr, b.add(gBase, index)), gKey);
    // Whether the search moves right (toward higher indices) from the hint.
    const towardHigh = right ? b.not(probe(gHint)) : probe(gHint);
    const advance = () => [b.assign(gLast, gOfs), b.assign(gOfs, b.add(b.add(gOfs, gOfs), one))];
    const length = gLength,
      hint = gHint;
    const body: IrStmt[] = [
      b.bind(gKey, key),
      b.assign(gBase, base),
      b.assign(gLength, lengthExpr),
      b.assign(gHint, hintExpr),
      b.assign(gLast, zero),
      b.assign(gOfs, one),
      b.branch(
        towardHigh,
        [
          b.assign(gMax, b.sub(length, hint)),
          b.while(b.lt(gOfs, gMax), [
            // Stop at the first element the key does not pass.
            b.branch(right ? probe(b.add(hint, gOfs)) : b.not(probe(b.add(hint, gOfs))), [brk()]),
            ...advance(),
          ]),
          b.branch(b.lt(gMax, gOfs), [b.assign(gOfs, gMax)]),
          b.assign(gLast, b.add(gLast, hint)),
          b.assign(gOfs, b.add(gOfs, hint)),
        ],
        [
          b.assign(gMax, b.add(hint, one)),
          b.while(b.lt(gOfs, gMax), [
            b.branch(right ? b.not(probe(b.sub(hint, gOfs))) : probe(b.sub(hint, gOfs)), [brk()]),
            ...advance(),
          ]),
          b.branch(b.lt(gMax, gOfs), [b.assign(gOfs, gMax)]),
          b.assign(gTmp, gLast),
          b.assign(gLast, b.sub(hint, gOfs)),
          b.assign(gOfs, b.sub(hint, gTmp)),
        ],
      ),
      b.step(gLast),
      b.while(b.lt(gLast, gOfs), [
        b.assign(gMid, half(gLast, gOfs)),
        b.branch(
          probe(gMid),
          right ? [b.assign(gOfs, gMid)] : [b.assign(gLast, b.add(gMid, one))],
          right ? [b.assign(gLast, b.add(gMid, one))] : [b.assign(gOfs, gMid)],
        ),
      ]),
      b.assign(out, gOfs),
    ];
    return [{ kind: "block", body, loc }];
  };

  // Merge state (merges never nest).
  const tmp = local("mergeTmp", src.type);
  const baseA = local("baseA");
  const lenA = local("lenA");
  const baseB = local("baseB");
  const lenB = local("lenB");
  const dest = local("dest");
  const cursorT = local("cursorT");
  const cursorX = local("cursorX");
  const winsA = local("winsA");
  const winsB = local("winsB");
  const firstPass = local("firstPass", BOOL);
  const k = local("mergeK");

  const takeTmp = (count: IrExpr, from: IrExpr): IrStmt[] => [
    b.bind(tmp, b.allocate(src.type, count)),
    ...copyForward(src, from, tmp, zero, count),
  ];
  const lowerGallop = (value: IrExpr): IrStmt =>
    b.assign(minGallop, b.choose(b.lt(one, value), b.sub(value, one), one));
  const enoughWins = (): IrExpr => or(or(ge(winsA, b.num(7)), ge(winsB, b.num(7))), firstPass);

  const mergeLow = (): IrStmt[] => {
    const id = labels++;
    const succeed = `ts.low${id}.succeed`,
      copyB = `ts.low${id}.copyB`,
      exit = `ts.low${id}.exit`;
    const moveB = [b.set(src, dest, at(src, cursorX)), b.step(dest), b.step(cursorX)];
    const moveT = [b.set(src, dest, at(tmp, cursorT)), b.step(dest), b.step(cursorT)];
    return [
      ...takeTmp(lenA, baseA),
      b.assign(dest, baseA),
      b.assign(cursorT, zero),
      b.assign(cursorX, baseB),
      ...moveB,
      block(exit, [
        block(copyB, [
          block(succeed, [
            b.step(lenB, -1),
            b.branch(b.eq(lenB, zero), [brk(succeed)]),
            b.branch(b.eq(lenA, one), [brk(copyB)]),
            forever([
              b.assign(winsA, zero),
              b.assign(winsB, zero),
              forever([
                b.branch(
                  less(at(src, cursorX), at(tmp, cursorT)),
                  [
                    ...moveB,
                    b.step(winsB),
                    b.step(lenB, -1),
                    b.assign(winsA, zero),
                    b.branch(b.eq(lenB, zero), [brk(succeed)]),
                    b.branch(ge(winsB, minGallop), [brk()]),
                  ],
                  [
                    ...moveT,
                    b.step(winsA),
                    b.step(lenA, -1),
                    b.assign(winsB, zero),
                    b.branch(b.eq(lenA, one), [brk(copyB)]),
                    b.branch(ge(winsA, minGallop), [brk()]),
                  ],
                ),
              ]),
              b.step(minGallop),
              b.assign(firstPass, truth),
              b.while(enoughWins(), [
                b.assign(firstPass, { kind: "boolLit", value: false, type: BOOL, loc }),
                lowerGallop(minGallop),
                ...gallop(true, winsA, tmp, at(src, cursorX), cursorT, lenA, zero),
                b.branch(b.lt(zero, winsA), [
                  ...copyForward(tmp, cursorT, src, dest, winsA),
                  b.assign(dest, b.add(dest, winsA)),
                  b.assign(cursorT, b.add(cursorT, winsA)),
                  b.assign(lenA, b.sub(lenA, winsA)),
                  b.branch(b.eq(lenA, one), [brk(copyB)]),
                  b.branch(b.eq(lenA, zero), [brk(succeed)]),
                ]),
                ...moveB,
                b.step(lenB, -1),
                b.branch(b.eq(lenB, zero), [brk(succeed)]),
                ...gallop(false, winsB, src, at(tmp, cursorT), cursorX, lenB, zero),
                b.branch(b.lt(zero, winsB), [
                  ...copyForward(src, cursorX, src, dest, winsB),
                  b.assign(dest, b.add(dest, winsB)),
                  b.assign(cursorX, b.add(cursorX, winsB)),
                  b.assign(lenB, b.sub(lenB, winsB)),
                  b.branch(b.eq(lenB, zero), [brk(succeed)]),
                ]),
                ...moveT,
                b.step(lenA, -1),
                b.branch(b.eq(lenA, one), [brk(copyB)]),
              ]),
              b.step(minGallop),
            ]),
          ]),
          // succeed
          ...copyForward(tmp, cursorT, src, dest, lenA),
          brk(exit),
        ]),
        // copyB: the last element of run A belongs at the end of the merge.
        ...copyForward(src, cursorX, src, dest, lenB),
        b.set(src, b.add(dest, lenB), at(tmp, cursorT)),
      ]),
    ];
  };

  const mergeHigh = (): IrStmt[] => {
    const id = labels++;
    const succeed = `ts.high${id}.succeed`,
      copyA = `ts.high${id}.copyA`,
      exit = `ts.high${id}.exit`;
    // dest, cursorX (run A) and cursorT index their next slot.
    const moveA = [b.set(src, dest, at(src, cursorX)), b.step(dest, -1), b.step(cursorX, -1)];
    const moveT = [b.set(src, dest, at(tmp, cursorT)), b.step(dest, -1), b.step(cursorT, -1)];
    return [
      ...takeTmp(lenB, baseB),
      b.assign(dest, b.sub(b.add(baseB, lenB), one)),
      b.assign(cursorT, b.sub(lenB, one)),
      b.assign(cursorX, b.sub(b.add(baseA, lenA), one)),
      ...moveA,
      block(exit, [
        block(copyA, [
          block(succeed, [
            b.step(lenA, -1),
            b.branch(b.eq(lenA, zero), [brk(succeed)]),
            b.branch(b.eq(lenB, one), [brk(copyA)]),
            forever([
              b.assign(winsA, zero),
              b.assign(winsB, zero),
              forever([
                b.branch(
                  less(at(tmp, cursorT), at(src, cursorX)),
                  [
                    ...moveA,
                    b.step(winsA),
                    b.step(lenA, -1),
                    b.assign(winsB, zero),
                    b.branch(b.eq(lenA, zero), [brk(succeed)]),
                    b.branch(ge(winsA, minGallop), [brk()]),
                  ],
                  [
                    ...moveT,
                    b.step(winsB),
                    b.step(lenB, -1),
                    b.assign(winsA, zero),
                    b.branch(b.eq(lenB, one), [brk(copyA)]),
                    b.branch(ge(winsB, minGallop), [brk()]),
                  ],
                ),
              ]),
              b.step(minGallop),
              b.assign(firstPass, truth),
              b.while(enoughWins(), [
                b.assign(firstPass, { kind: "boolLit", value: false, type: BOOL, loc }),
                lowerGallop(minGallop),
                ...gallop(true, k, src, at(tmp, cursorT), baseA, lenA, b.sub(lenA, one)),
                b.assign(winsA, b.sub(lenA, k)),
                b.branch(b.lt(zero, winsA), [
                  b.assign(dest, b.sub(dest, winsA)),
                  b.assign(cursorX, b.sub(cursorX, winsA)),
                  ...copyBackward(b.add(cursorX, one), b.add(dest, one), winsA),
                  b.assign(lenA, b.sub(lenA, winsA)),
                  b.branch(b.eq(lenA, zero), [brk(succeed)]),
                ]),
                ...moveT,
                b.step(lenB, -1),
                b.branch(b.eq(lenB, one), [brk(copyA)]),
                ...gallop(false, k, tmp, at(src, cursorX), zero, lenB, b.sub(lenB, one)),
                b.assign(winsB, b.sub(lenB, k)),
                b.branch(b.lt(zero, winsB), [
                  b.assign(dest, b.sub(dest, winsB)),
                  b.assign(cursorT, b.sub(cursorT, winsB)),
                  ...copyForward(tmp, b.add(cursorT, one), src, b.add(dest, one), winsB),
                  b.assign(lenB, b.sub(lenB, winsB)),
                  b.branch(b.eq(lenB, one), [brk(copyA)]),
                  b.branch(b.eq(lenB, zero), [brk(succeed)]),
                ]),
                ...moveA,
                b.step(lenA, -1),
                b.branch(b.eq(lenA, zero), [brk(succeed)]),
              ]),
              b.step(minGallop),
            ]),
          ]),
          // succeed
          ...copyForward(tmp, zero, src, b.sub(dest, b.sub(lenB, one)), lenB),
          brk(exit),
        ]),
        // copyA: the first element of run B belongs at the front of the merge.
        b.assign(dest, b.sub(dest, lenA)),
        b.assign(cursorX, b.sub(cursorX, lenA)),
        ...copyBackward(b.add(cursorX, one), b.add(dest, one), lenA),
        b.set(src, dest, at(tmp, cursorT)),
      ]),
    ];
  };

  const mergeAt = (i: IrExpr): IrStmt[] => {
    const merged = local(`mergeAt${labels++}`);
    const id = `ts.at${labels++}`;
    return [
      b.bind(merged, i),
      b.assign(baseA, at(runBase, merged)),
      b.assign(lenA, at(runLen, merged)),
      b.assign(baseB, at(runBase, b.add(merged, one))),
      b.assign(lenB, at(runLen, b.add(merged, one))),
      b.set(runLen, merged, b.add(lenA, lenB)),
      b.branch(b.eq(b.add(merged, b.num(3)), runs), [
        b.set(runBase, b.add(merged, one), at(runBase, b.add(merged, two))),
        b.set(runLen, b.add(merged, one), at(runLen, b.add(merged, two))),
      ]),
      b.step(runs, -1),
      block(id, [
        ...gallop(true, k, src, at(src, baseB), baseA, lenA, zero),
        b.assign(baseA, b.add(baseA, k)),
        b.assign(lenA, b.sub(lenA, k)),
        b.branch(b.eq(lenA, zero), [brk(id)]),
        ...gallop(
          false,
          lenB,
          src,
          at(src, b.sub(b.add(baseA, lenA), one)),
          baseB,
          lenB,
          b.sub(lenB, one),
        ),
        b.branch(b.eq(lenB, zero), [brk(id)]),
        b.branch(le(lenA, lenB), mergeLow(), mergeHigh()),
      ]),
    ];
  };

  const invariant = (m: IrExpr): IrExpr =>
    or(
      b.lt(m, two),
      b.lt(b.add(at(runLen, b.sub(m, one)), at(runLen, m)), at(runLen, b.sub(m, two))),
    );
  const top = local("top");
  const low = local("low");
  const remaining = local("remaining");
  const minRun = local("minRun");
  const minRunOdd = local("minRunOdd");
  const runEnd = local("runEnd");
  const descending = local("descending", BOOL);
  const previous = local("previous", elem);
  const pivot = local("pivot", elem);
  const left = local("left");
  const right = local("right");
  const mid = local("mid");
  const pos = local("insert");
  const forced = local("forced");
  const vl = local("swapLeft", elem);
  const vr = local("swapRight", elem);
  const length = local("runLength");
  const scan = local("scan");
  const half2 = (value: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "math.floor",
    args: [{ kind: "bin", op: "/", left: value, right: two, type: F64, loc }],
    type: F64,
    loc,
  });

  const countRun: IrStmt[] = [
    b.assign(scan, b.add(low, one)),
    b.assign(runEnd, b.add(low, remaining)),
    b.branch(
      b.eq(scan, runEnd),
      [b.assign(length, one)],
      [
        b.assign(length, two),
        b.assign(descending, less(at(src, scan), at(src, low))),
        b.bind(previous, at(src, scan)),
        b.step(scan),
        b.while(b.lt(scan, runEnd), [
          b.branch(
            b.choose(
              descending,
              b.not(less(at(src, scan), previous)),
              less(at(src, scan), previous),
            ),
            [brk()],
          ),
          b.assign(previous, at(src, scan)),
          b.step(length),
          b.step(scan),
        ]),
        b.branch(descending, [
          b.assign(left, low),
          b.assign(right, b.sub(b.add(low, length), one)),
          b.while(b.lt(left, right), [
            b.bind(vl, at(src, left)),
            b.bind(vr, at(src, right)),
            b.set(src, left, vr),
            b.set(src, right, vl),
            b.step(left),
            b.step(right, -1),
          ]),
        ]),
      ],
    ),
  ];
  const insertion: IrStmt[] = [
    b.assign(forced, min(minRun, remaining)),
    // [low, low + length) is sorted; insert each later element.
    b.assign(pos, b.add(low, length)),
    b.while(b.lt(pos, b.add(low, forced)), [
      b.assign(left, low),
      b.assign(right, pos),
      b.bind(pivot, at(src, pos)),
      b.while(b.lt(left, right), [
        b.assign(mid, half(left, right)),
        b.branch(
          less(pivot, at(src, mid)),
          [b.assign(right, mid)],
          [b.assign(left, b.add(mid, one))],
        ),
      ]),
      ...copyBackward(left, b.add(left, one), b.sub(pos, left)),
      b.set(src, left, pivot),
      b.step(pos),
    ]),
    b.assign(length, forced),
  ];
  const collapse: IrStmt = b.while(b.lt(one, runs), [
    b.assign(top, b.sub(runs, two)),
    b.branch(
      or(b.not(invariant(b.add(top, one))), b.not(invariant(top))),
      [
        b.branch(b.lt(at(runLen, b.sub(top, one)), at(runLen, b.add(top, one))), [b.step(top, -1)]),
        ...mergeAt(top),
      ],
      [b.branch(le(at(runLen, top), at(runLen, b.add(top, one))), [...mergeAt(top)], [brk()])],
    ),
  ]);
  const forceCollapse: IrStmt = b.while(b.lt(one, runs), [
    b.assign(top, b.sub(runs, two)),
    b.branch(and(b.lt(zero, top), b.lt(at(runLen, b.sub(top, one)), at(runLen, b.add(top, one)))), [
      b.step(top, -1),
    ]),
    ...mergeAt(top),
  ]);
  const scalars = [
    cp,
    gLast,
    gOfs,
    gMax,
    gMid,
    gTmp,
    gBase,
    gLength,
    gHint,
    baseA,
    lenA,
    baseB,
    lenB,
    dest,
    cursorT,
    cursorX,
    winsA,
    winsB,
    k,
    top,
    low,
    remaining,
    minRun,
    minRunOdd,
    runEnd,
    left,
    right,
    mid,
    pos,
    forced,
    length,
    scan,
  ];
  return [
    ...scalars.map((local) => b.bind(local, zero)),
    b.bind(firstPass, { kind: "boolLit", value: false, type: BOOL, loc }),
    b.bind(descending, { kind: "boolLit", value: false, type: BOOL, loc }),
    b.bind(minGallop, b.num(7)),
    b.bind(runBase, { kind: "arrayLit", elems: [], type: runBase.type, loc }),
    b.bind(runLen, { kind: "arrayLit", elems: [], type: runLen.type, loc }),
    b.bind(runs, zero),
    b.bind(minRun, n),
    b.bind(minRunOdd, zero),
    b.while(ge(minRun, b.num(64)), [
      b.branch(b.not(b.eq(b.sub(minRun, b.add(half2(minRun), half2(minRun))), zero)), [
        b.assign(minRunOdd, one),
      ]),
      b.assign(minRun, half2(minRun)),
    ]),
    b.assign(minRun, b.add(minRun, minRunOdd)),
    b.bind(low, zero),
    b.bind(remaining, n),
    b.while(b.lt(zero, remaining), [
      ...countRun,
      b.branch(b.lt(length, minRun), insertion),
      b.set(runBase, runs, low),
      b.set(runLen, runs, length),
      b.step(runs),
      collapse,
      b.assign(low, b.add(low, length)),
      b.assign(remaining, b.sub(remaining, length)),
    ]),
    forceCollapse,
  ];
}

type SortKeyField = IrExpr & { kind: "recordGet" | "fieldGet" };

/** A key read over the comparator's first parameter: one number field, or
 * an optional number field with a number default (`x.k ?? 0`). */
export interface SortKeyRead {
  field: SortKeyField;
  fallback: (IrExpr & { kind: "numLit" }) | null;
}

/** One key of a comparator: the elements themselves or one field of each,
 * ascending or descending. */
export interface SortKeyOrder {
  /** 1 for ascending, -1 for descending. */
  order: 1 | -1;
  /** The key read, or null when the elements are the numbers. */
  read: SortKeyRead | null;
}

/** Most keys a comparator chain is recognized with (the runtime's
 * SCR_SORT_KEYS_MAX). */
const MAX_SORT_KEYS = 8;

/** Recognizes the lifted body of a capture-free numeric comparator:
 * `(a, b) => a - b`, `b - a`, `a < b ? -1 : a > b ? 1 : 0` (either test
 * first, either sign), or any of them over one number field of both
 * parameters (`a.k - b.k`, or `(a.k ?? 0) - (b.k ?? 0)` over an optional
 * field). Such a comparator runs no user code, cannot throw, and is
 * consistent over numbers other than NaN, so the runtime may order the
 * elements by their keys without calling it. A chain `t0 || t1 || ...` of
 * such terms over fields orders by several keys, the first deciding: a term
 * that is 0 or NaN falls through to the next. Returns the keys in order. */
export function recognizeKeyComparator(fn: IrFunction): readonly SortKeyOrder[] | null {
  if (fn.params.length !== 2 || fn.async || fn.generator || (fn.captures?.length ?? 0) > 0)
    return null;
  const ret = fn.body.length === 1 ? fn.body[0]! : null;
  if (ret?.kind !== "return" || !ret.value) return null;
  const terms: IrExpr[] = [];
  const flatten = (e: IrExpr): void => {
    if (e.kind === "logical" && e.op === "||" && e.type.kind === "f64") {
      flatten(e.left);
      flatten(e.right);
    } else terms.push(e);
  };
  flatten(ret.value);
  if (terms.length > MAX_SORT_KEYS) return null;
  const keys: SortKeyOrder[] = [];
  for (const term of terms) {
    const key = recognizeKeyTerm(fn, term);
    if (!key) return null;
    keys.push(key);
  }
  // Several keys order elements by their fields.
  if (keys.length > 1 && keys.some((key) => key.read === null)) return null;
  return keys;
}

/** One term of a key comparator over one key (recognizeKeyComparator). */
function recognizeKeyTerm(fn: IrFunction, value: IrExpr): SortKeyOrder | null {
  const [first, second] = fn.params;
  let read: SortKeyRead | null | undefined;
  // Which parameter an operand reads; every operand must read the same key.
  const operand = (e: IrExpr): 0 | 1 | null => {
    if (e.type.kind !== "f64") return null;
    let ref: IrExpr = e;
    let key: SortKeyRead | null = null;
    if (
      e.kind === "nullish" &&
      (e.left.kind === "recordGet" || e.left.kind === "fieldGet") &&
      e.right.kind === "numLit"
    ) {
      key = { field: e.left, fallback: e.right };
      ref = e.left.obj;
    } else if (e.kind === "recordGet" || e.kind === "fieldGet") {
      key = { field: e, fallback: null };
      ref = e.obj;
    }
    if (ref.kind !== "varRef") return null;
    const param = ref.localId === first!.localId ? 0 : ref.localId === second!.localId ? 1 : null;
    if (param === null) return null;
    if (read === undefined) read = key;
    else if (!sameKeyRead(read, key)) return null;
    return param;
  };
  // `x < y` or `x > y` over both parameters, as the first one's relation.
  const relation = (e: IrExpr): "lt" | "gt" | null => {
    if (e.kind !== "bin" || (e.op !== "<" && e.op !== ">")) return null;
    const left = operand(e.left),
      right = operand(e.right);
    if (left === null || right === null || left === right) return null;
    return (e.op === "<") === (left === 0) ? "lt" : "gt";
  };
  const sign = (e: IrExpr): number | null =>
    e.kind === "numLit" && (e.value === 1 || e.value === -1 || e.value === 0) ? e.value : null;
  if (value.kind === "bin" && value.op === "-") {
    const left = operand(value.left),
      right = operand(value.right);
    if (left === null || right === null || left === right) return null;
    return { order: left === 0 ? 1 : -1, read: read ?? null };
  }
  if (value.kind === "ternary" && value.else_.kind === "ternary") {
    const outer = relation(value.cond),
      inner = relation(value.else_.cond);
    const outerSign = sign(value.then),
      innerSign = sign(value.else_.then);
    if (
      outer === null ||
      inner === null ||
      outer === inner ||
      outerSign === null ||
      outerSign === 0 ||
      innerSign !== -outerSign ||
      sign(value.else_.else_) !== 0
    )
      return null;
    // Ascending answers negative when the first parameter is less.
    return { order: (outer === "lt") === outerSign < 0 ? 1 : -1, read: read ?? null };
  }
  return null;
}

/** The keys of a comparator closure: a zero-capture closure (not a
 * signature adapter) over a lifted function recognizeKeyComparator accepts. */
export function closureKeyOrder(
  liftedFns: readonly IrFunction[],
  closure: IrExpr,
): readonly SortKeyOrder[] | null {
  if (closure.kind !== "closure" || closure.captures.length > 0 || closure.adapts) return null;
  const fn = liftedFns.find((lifted) => lifted.name === closure.fnName);
  return fn ? recognizeKeyComparator(fn) : null;
}

function sameKeyRead(left: SortKeyRead | null, right: SortKeyRead | null): boolean {
  if (left === null || right === null) return left === right;
  if (!Object.is(left.fallback?.value, right.fallback?.value)) return false;
  const a = left.field,
    b = right.field;
  if (a.kind === "recordGet" && b.kind === "recordGet")
    return a.shapeId === b.shapeId && a.field === b.field;
  if (a.kind === "fieldGet" && b.kind === "fieldGet")
    return a.className === b.className && a.field === b.field;
  return false;
}

/** The order argument of a keyed sort: 1 or -1 for one key; for several,
 * the key count in the low byte and, from bit 8, one bit per descending
 * key (the runtime's SCR_SORT_KEYS encoding). */
export function sortKeysOrder(keys: readonly SortKeyOrder[]): number {
  if (keys.length === 1) return keys[0]!.order;
  return keys.reduce((code, key, j) => (key.order < 0 ? code | (1 << (8 + j)) : code), keys.length);
}

/** A cache key that identifies a recognized comparator's key reads. */
export function sortKeysId(keys: readonly SortKeyOrder[]): string {
  return keys
    .map((key) => {
      if (!key.read) return "self";
      const field = key.read.field;
      const owner = field.kind === "recordGet" ? field.shapeId : field.className;
      const fallback = key.read.fallback
        ? `??${Object.is(key.read.fallback.value, -0) ? "-0" : key.read.fallback.value}`
        : "";
      return `${field.kind}:${owner}:${field.field}${fallback}`;
    })
    .join("|");
}

/** The key reader of a recognized field comparator: `(x) => x.k` (or
 * `x.k ?? d`), the same read as the comparator's. For several keys it takes
 * the key's index too: `(x, j) => j === 0 ? key0 : j === 1 ? key1 : ...`. */
export function buildSortKeyFn(
  name: string,
  elem: IrType,
  reads: readonly SortKeyRead[],
  loc: SrcLoc,
): IrFunction {
  const b = new SortIr(loc);
  const x = b.local("x", elem);
  const read = (key: SortKeyRead): IrExpr => {
    const field: IrExpr = { ...key.field, obj: x, loc };
    return key.fallback
      ? { kind: "nullish", left: field, right: key.fallback, type: F64, loc }
      : field;
  };
  if (reads.length === 1) {
    return {
      name,
      params: [{ localId: x.localId, name: "x", type: elem }],
      returnType: F64,
      locals: b.locals,
      body: distinctNodes([{ kind: "return", value: read(reads[0]!), loc }]),
      loc,
    };
  }
  const j = b.local("j");
  let value = read(reads[reads.length - 1]!);
  for (let index = reads.length - 2; index >= 0; index--) {
    value = {
      kind: "ternary",
      cond: b.eq(j, b.num(index)),
      then: read(reads[index]!),
      else_: value,
      type: F64,
      loc,
    };
  }
  return {
    name,
    params: [
      { localId: x.localId, name: "x", type: elem },
      { localId: j.localId, name: "j", type: F64 },
    ],
    returnType: F64,
    locals: b.locals,
    body: distinctNodes([{ kind: "return", value, loc }]),
    loc,
  };
}

export function buildArraySortFn(
  name: string,
  elem: IrType,
  arity: number,
  copyFirst: boolean,
  undefinedTag: number | null,
  loc: SrcLoc,
  native = false,
  keyed: { order: number; key: boolean; keys: number } | null = null,
  /** The throw for a foreign element (SCR_ARR_FOREIGN) at `index` of
   * `arr`, which the comparator's element type cannot hold; for element
   * types whose arrays can hold one. */
  checkForeign: ((arr: IrExpr, index: IrExpr) => IrExpr) | null = null,
): IrFunction {
  const b = new SortIr(loc);
  const arrT = arrayOf(elem),
    fnT = funcOf([elem, elem].slice(0, arity), F64);
  const a = b.local("a", arrT),
    f = b.local("f", fnT);
  // A reader of several keys takes the key's index too (buildSortKeyFn).
  const keyT = funcOf(keyed && keyed.keys > 1 ? [elem, F64] : [elem], F64);
  const key = keyed?.key ? b.local("key", keyT) : null;
  // A recognized comparator lets the runtime order by keys; it still
  // receives the comparator for inputs whose keys it does not order.
  const keyArgs: IrExpr[] = keyed ? [b.num(keyed.order), ...(key ? [key] : [])] : [];
  const src = b.local("src", arrT);
  const n = b.local("n"),
    valueCount = b.local("valueCount"),
    undefinedCount = b.local("undefinedCount"),
    undefinedValues = b.local("undefinedValues");
  const index = b.local("index"),
    state = b.local("state");
  const isUndefined = (value: IrExpr): IrExpr | null => {
    if (elem.kind === "union" && undefinedTag !== null) {
      return {
        kind: "unionIsTag",
        unionId: elem.unionId,
        tag: undefinedTag,
        negated: false,
        value,
        type: BOOL,
        loc,
      };
    }

    return null;
  };
  // A NaN result compares as 0, which `< 0` gives.
  const less: Less = (left, right) => ({
    kind: "bin",
    op: "<",
    left: { kind: "callValue", callee: f, args: [left, right].slice(0, arity), type: F64, loc },
    right: b.num(0),
    type: BOOL,
    loc,
  });
  const keepValue = (): IrStmt[] => [
    b.branch(b.lt(valueCount, index), [b.set(src, valueCount, b.at(src, index))]),
    b.step(valueCount),
  ];
  const compactValue = (): IrStmt => {
    const undefinedValue = isUndefined(b.at(src, index));
    return undefinedValue === null
      ? { kind: "block", body: keepValue(), loc }
      : b.branch(undefinedValue, [b.step(undefinedValues)], keepValue());
  };
  // The union's undefined value, for the elements that held one.
  const undefinedValue = (): IrExpr | null =>
    elem.kind === "union" && undefinedTag !== null
      ? {
          kind: "unionWrap",
          unionId: elem.unionId,
          tag: undefinedTag,
          value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
          type: elem,
          loc,
        }
      : null;
  const unionTail = (): IrStmt[] => {
    const value = undefinedValue();
    return value === null
      ? []
      : [
          b.loop(index, valueCount, b.add(valueCount, undefinedValues), [
            b.set(result, index, value),
          ]),
        ];
  };
  const tailStart = (): IrExpr => b.add(valueCount, undefinedValues);
  const result = copyFirst ? src : a;
  // Dense arrays sort in the runtime without the compacting snapshot below:
  // `sort` orders the receiver's values outside it and writes them back
  // after success, and `toSorted` orders its private copy in place.
  const dense = (receiver: SortLocal): IrStmt =>
    b.branch(
      {
        kind: "arrIntrinsic",
        method: "sortDense",
        receiver,
        args: [f, { kind: "boolLit", value: copyFirst, type: BOOL, loc }, ...keyArgs],
        type: BOOL,
        loc,
      },
      [{ kind: "return", value: receiver, loc }],
    );
  const body: IrStmt[] = [
    ...(native && !copyFirst ? [dense(a)] : []),
    b.bind(n, b.length(a)),
    b.bind(src, { kind: "arrIntrinsic", method: "slice", receiver: a, args: [], type: arrT, loc }),
    ...(native && copyFirst ? [dense(src)] : []),
    b.bind(valueCount, b.num(0)),
    b.bind(undefinedCount, b.num(0)),
    b.bind(undefinedValues, b.num(0)),
    // Compact the owned snapshot before callbacks, as V8 does: holes are
    // dropped, undefined values (storage-level, or a union's undefined arm)
    // are counted, and the comparator only sees the other values. Dense
    // values stay in place; only values following the others move.
    b.loop(index, b.num(0), n, [
      b.bind(state, { kind: "arrayState", arr: src, index, type: F64, loc }),
      b.branch(
        b.eq(state, b.num(1)),
        [compactValue()],
        [
          b.branch(
            b.eq(state, b.num(2)),
            [b.step(undefinedCount)],
            checkForeign
              ? [
                  // A foreign element does not fit the comparator's element
                  // type: the checked conversion's TypeError.
                  b.branch(b.eq(state, b.num(3)), [
                    { kind: "exprStmt", expr: checkForeign(src, index), loc },
                  ]),
                ]
              : null,
          ),
        ],
      ),
    ]),
    // Sort only the compacted prefix. The tail is overwritten with undefined
    // for toSorted, or released with this private snapshot for sort.
    // The runtime runs the same algorithm over raw slots when the element
    // ABI allows it (isSortValuesElement).
    ...(native
      ? [
          {
            kind: "exprStmt" as const,
            expr: {
              kind: "arrIntrinsic" as const,
              method: "sortValues" as const,
              receiver: src,
              args: [valueCount, f, ...keyArgs],
              type: VOID,
              loc,
            },
            loc,
          },
        ]
      : timSort(b, src, valueCount, less)),
    ...(copyFirst
      ? []
      : [b.loop(index, b.num(0), valueCount, [b.set(a, index, b.at(src, index))])]),
    ...unionTail(),
    b.loop(index, tailStart(), copyFirst ? n : b.add(tailStart(), undefinedCount), [
      { kind: "arraySetUndefined", arr: result, index, loc },
    ]),
    ...(copyFirst
      ? []
      : [
          b.loop(index, b.add(tailStart(), undefinedCount), n, [
            { kind: "arrayDelete", arr: a, index, loc },
          ]),
        ]),
    { kind: "return", value: result, loc },
  ];
  return {
    name,
    params: [
      { localId: a.localId, name: "a", type: arrT },
      { localId: f.localId, name: "f", type: fnT },
      ...(key ? [{ localId: key.localId, name: "key", type: keyT }] : []),
    ],
    returnType: arrT,
    locals: b.locals,
    body: distinctNodes(body),
    loc,
  };
}

/** Typed-array `sort` and `toSorted`. `toSorted` orders a private copy;
 * `sort` orders the receiver and returns it. Without a comparator, and for a
 * recognized numeric comparator's `order`, the runtime sorts the elements by
 * value (sortNumeric). Other comparators, and a recognized one the runtime
 * refuses (a NaN or -0 element), take the runtime comparator sort
 * (sortCompare). */
export function buildBytesSortFn(
  name: string,
  type: IrType & { kind: "bytes" },
  arity: number,
  hasComparator: boolean,
  copyFirst: boolean,
  order: 1 | -1 | null,
  loc: SrcLoc,
): IrFunction {
  const b = new SortIr(loc);
  const a = b.local("a", type),
    src = b.local("src", type);
  const fnT = funcOf([F64, F64].slice(0, arity), F64);
  const f = hasComparator ? b.local("f", fnT) : null;
  const target = copyFirst ? src : a;
  const intrinsic = (method: "sortNumeric" | "sortCompare", arg: IrExpr): IrExpr => ({
    kind: "bytesIntrinsic",
    method,
    receiver: target,
    args: [arg],
    type: method === "sortNumeric" ? BOOL : VOID,
    loc,
  });
  const body: IrStmt[] = copyFirst
    ? [b.bind(src, { kind: "bytesIntrinsic", method: "slice", receiver: a, args: [], type, loc })]
    : [];
  const compare: IrStmt[] =
    f === null ? [] : [{ kind: "exprStmt", expr: intrinsic("sortCompare", f), loc }];
  if (f === null) body.push({ kind: "exprStmt", expr: intrinsic("sortNumeric", b.num(0)), loc });
  else if (order === null) body.push(...compare);
  else body.push(b.branch(b.not(intrinsic("sortNumeric", b.num(order))), compare));
  body.push({ kind: "return", value: target, loc });
  return {
    name,
    params: [
      { localId: a.localId, name: "a", type },
      ...(f === null ? [] : [{ localId: f.localId, name: "f", type: fnT }]),
    ],
    returnType: type,
    locals: b.locals,
    body: distinctNodes(body),
    loc,
  };
}
