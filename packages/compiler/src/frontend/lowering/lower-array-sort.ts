import {
  BOOL,
  BYTES_U8,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
  JSVAL,
  VOID,
  type SrcLoc,
  arrayOf,
  funcOf,
} from "../../ir/ir.js";
import { numLit } from "../../ir/build.js";
import { transformStmtList } from "../../ir/traverse.js";

type SortLocal = IrExpr & { kind: "varRef" };
type Greater = (left: IrExpr, right: IrExpr) => IrExpr;

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

/** Stable natural merge sort over an owned snapshot. Strict descending runs
 * can be reversed without reversing ties. Short runs use bounded binary
 * insertion; merge passes then consume pairs of complete runs. The boundary
 * table compacts in place, and a single run needs no scratch buffer at all.
 * Comparator scheduling is intentionally unspecified, as for the previous
 * bottom-up sorter. Every callback still uses ordinary IR exception/ownership
 * handling; the caller's array is only written after sorting succeeds. */
function stableSort(b: SortIr, src: SortLocal, n: IrExpr, greater: Greater): IrStmt[] {
  const elem = src.type.kind === "array" ? src.type.elem : F64;
  const dst = b.local("dst", src.type);
  const tmp = b.local("tmp", src.type);
  const runs = b.local("runs", arrayOf(F64));
  const runCount = b.local("runCount");
  const start = b.local("start");
  const end = b.local("end");
  const descending = b.local("descending", BOOL);
  const left = b.local("left");
  const right = b.local("right");
  const pivot = b.local("pivot", elem);
  const low = b.local("low");
  const high = b.local("high");
  const center = b.local("center");
  const limit = b.local("limit");
  const i = b.local("i");
  const j = b.local("j");
  const k = b.local("k");
  const mid = b.local("mid");
  const run = b.local("run");
  const nextRun = b.local("nextRun");
  const vLeft = b.local("vLeft", elem);
  const vRight = b.local("vRight", elem);
  const boundaryLeft = b.local("boundaryLeft", elem);
  const boundaryRight = b.local("boundaryRight", elem);
  const zero = b.num(0),
    one = b.num(1),
    two = b.num(2);
  const at = (index: IrExpr): IrExpr => b.at(src, index);
  const copy = (index: SortLocal, stop: IrExpr): IrStmt =>
    b.while(b.lt(index, stop), [b.set(dst, k, at(index)), b.step(index), b.step(k)]);
  const merge: IrStmt[] = [
    b.bind(vLeft, at(i)),
    b.bind(vRight, at(j)),
    b.while(
      {
        kind: "logical",
        op: "&&",
        left: b.lt(i, mid),
        right: b.lt(j, right),
        type: BOOL,
        loc: b.loc,
      },
      [
        b.branch(
          greater(vLeft, vRight),
          [b.set(dst, k, vRight), b.step(j), b.branch(b.lt(j, right), [b.assign(vRight, at(j))])],
          [b.set(dst, k, vLeft), b.step(i), b.branch(b.lt(i, mid), [b.assign(vLeft, at(i))])],
        ),
        b.step(k),
      ],
    ),
    copy(i, mid),
    copy(j, right),
  ];
  return [
    b.bind(runs, { kind: "arrayLit", elems: [zero], type: runs.type, loc: b.loc }),
    b.bind(runCount, one),
    b.bind(start, zero),
    b.while(b.lt(start, n), [
      b.bind(end, b.add(start, one)),
      b.branch(b.lt(end, n), [
        b.bind(descending, greater(at(start), at(end))),
        b.step(end),
        b.while(b.lt(end, n), [
          b.branch(
            b.choose(
              descending,
              greater(at(b.sub(end, one)), at(end)),
              b.not(greater(at(b.sub(end, one)), at(end))),
            ),
            [b.step(end)],
            [{ kind: "break", loc: b.loc }],
          ),
        ]),
        b.branch(descending, [
          b.bind(left, start),
          b.bind(right, b.sub(end, one)),
          b.while(b.lt(left, right), [
            b.bind(vLeft, at(left)),
            b.bind(vRight, at(right)),
            b.set(src, left, vRight),
            b.set(src, right, vLeft),
            b.step(left),
            b.step(right, -1),
          ]),
        ]),
      ]),
      // Bound insertion movement while avoiding tiny merge runs.
      b.bind(limit, b.choose(b.lt(b.add(start, b.num(16)), n), b.add(start, b.num(16)), n)),
      b.while(b.lt(end, limit), [
        b.bind(pivot, at(end)),
        b.bind(low, start),
        b.bind(high, end),
        b.while(b.lt(low, high), [
          b.bind(center, {
            kind: "libCall",
            fn: "math.floor",
            args: [
              { kind: "bin", op: "/", left: b.add(low, high), right: two, type: F64, loc: b.loc },
            ],
            type: F64,
            loc: b.loc,
          }),
          // Insert after equal values to preserve their original order.
          b.branch(
            greater(at(center), pivot),
            [b.assign(high, center)],
            [b.assign(low, b.add(center, one))],
          ),
        ]),
        b.bind(i, end),
        b.while(b.lt(low, i), [b.set(src, i, at(b.sub(i, one))), b.step(i, -1)]),
        b.set(src, low, pivot),
        b.step(end),
      ]),
      b.set(runs, runCount, end),
      b.step(runCount),
      b.assign(start, end),
    ]),
    b.branch(b.lt(two, runCount), [
      b.bind(dst, b.allocate(src.type, n)),
      b.while(b.lt(two, runCount), [
        b.bind(run, zero),
        b.bind(nextRun, one),
        b.while(b.lt(b.add(run, one), runCount), [
          b.bind(start, b.at(runs, run)),
          b.bind(mid, b.at(runs, b.add(run, one))),
          b.bind(right, b.choose(b.lt(b.add(run, two), runCount), b.at(runs, b.add(run, two)), n)),
          b.bind(i, start),
          b.bind(j, mid),
          b.bind(k, start),
          b.branch(
            b.lt(mid, right),
            [
              b.bind(boundaryLeft, at(b.sub(mid, one))),
              b.bind(boundaryRight, at(mid)),
              b.branch(greater(boundaryLeft, boundaryRight), merge, [copy(i, right)]),
            ],
            [copy(i, right)],
          ),
          b.set(runs, nextRun, right),
          b.step(nextRun),
          b.step(run, 2),
        ]),
        b.assign(runCount, nextRun),
        b.bind(tmp, src),
        b.assign(src, dst),
        b.assign(dst, tmp),
      ]),
    ]),
  ];
}

export function buildArraySortFn(
  name: string,
  elem: IrType,
  arity: number,
  copyFirst: boolean,
  undefinedTag: number | null,
  loc: SrcLoc,
  native = false,
): IrFunction {
  const b = new SortIr(loc);
  const arrT = arrayOf(elem),
    fnT = funcOf([elem, elem].slice(0, arity), F64);
  const a = b.local("a", arrT),
    f = b.local("f", fnT);
  const src = b.local("src", arrT);
  const n = b.local("n"),
    valueCount = b.local("valueCount"),
    undefinedCount = b.local("undefinedCount");
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
    if (elem.kind === "jsval") {
      return {
        kind: "jsOp",
        op: "eq",
        args: [value, { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }],
        type: BOOL,
        loc,
      };
    }
    return null;
  };
  const greater: Greater = (left, right) => {
    const compare: IrExpr = {
      kind: "bin",
      op: ">",
      left: { kind: "callValue", callee: f, args: [left, right].slice(0, arity), type: F64, loc },
      right: b.num(0),
      type: BOOL,
      loc,
    };
    const leftUndefined = isUndefined(left),
      rightUndefined = isUndefined(right);
    return leftUndefined !== null && rightUndefined !== null
      ? b.choose(
          leftUndefined,
          b.not(rightUndefined),
          b.choose(rightUndefined, { kind: "boolLit", value: false, type: BOOL, loc }, compare),
        )
      : compare;
  };
  const result = copyFirst ? src : a;
  const body: IrStmt[] = [
    b.bind(n, b.length(a)),
    b.bind(src, { kind: "arrIntrinsic", method: "slice", receiver: a, args: [], type: arrT, loc }),
    b.bind(valueCount, b.num(0)),
    b.bind(undefinedCount, b.num(0)),
    // Compact the owned snapshot before callbacks. Dense values stay in
    // place; only values following holes or storage-level undefined move.
    b.loop(index, b.num(0), n, [
      b.bind(state, { kind: "arrayState", arr: src, index, type: F64, loc }),
      b.branch(
        b.eq(state, b.num(1)),
        [
          b.branch(b.lt(valueCount, index), [b.set(src, valueCount, b.at(src, index))]),
          b.step(valueCount),
        ],
        [b.branch(b.eq(state, b.num(2)), [b.step(undefinedCount)])],
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
              args: [valueCount, f],
              type: VOID,
              loc,
            },
            loc,
          },
        ]
      : stableSort(b, src, valueCount, greater)),
    ...(copyFirst
      ? []
      : [b.loop(index, b.num(0), valueCount, [b.set(a, index, b.at(src, index))])]),
    b.loop(index, valueCount, copyFirst ? n : b.add(valueCount, undefinedCount), [
      { kind: "arraySetUndefined", arr: result, index, loc },
    ]),
    ...(copyFirst
      ? []
      : [
          b.loop(index, b.add(valueCount, undefinedCount), n, [
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
    ],
    returnType: arrT,
    locals: b.locals,
    body: distinctNodes(body),
    loc,
  };
}

/** A byte's complete value domain is small enough for stable default ordering
 * without comparisons. Counts use numbers so large inputs cannot wrap. */
function countBytes(b: SortIr, a: SortLocal, src: SortLocal, n: SortLocal): IrStmt[] {
  const counts = b.local("counts", arrayOf(F64));
  const value = b.local("value"),
    index = b.local("index"),
    end = b.local("end");
  const zero = b.num(0),
    one = b.num(1);
  return [
    b.bind(src, b.allocate(BYTES_U8, n)),
    b.bind(counts, b.allocate(counts.type, b.num(256))),
    b.loop(value, zero, b.num(256), [b.set(counts, value, zero)]),
    b.loop(index, zero, n, [
      b.bind(value, b.at(a, index)),
      b.set(counts, value, b.add(b.at(counts, value), one)),
    ]),
    b.bind(index, zero),
    b.loop(value, zero, b.num(256), [
      b.bind(end, b.add(index, b.at(counts, value))),
      b.while(b.lt(index, end), [b.set(src, index, value), b.step(index)]),
    ]),
  ];
}

export function buildBytesSortFn(
  name: string,
  arity: number,
  hasComparator: boolean,
  loc: SrcLoc,
): IrFunction {
  const b = new SortIr(loc);
  const a = b.local("a", BYTES_U8),
    src = b.local("src", BYTES_U8),
    n = b.local("n");
  const fnT = funcOf([F64, F64].slice(0, arity), F64);
  const f = hasComparator ? b.local("f", fnT) : null;
  const body: IrStmt[] = [b.bind(n, b.length(a))];
  if (f !== null) {
    body.push(
      b.bind(src, {
        kind: "bytesIntrinsic",
        method: "slice",
        receiver: a,
        args: [],
        type: BYTES_U8,
        loc,
      }),
    );
    body.push(
      ...stableSort(b, src, n, (left, right) => ({
        kind: "bin",
        op: ">",
        left: { kind: "callValue", callee: f, args: [left, right].slice(0, arity), type: F64, loc },
        right: b.num(0),
        type: BOOL,
        loc,
      })),
    );
  } else {
    body.push(...countBytes(b, a, src, n));
  }
  body.push({ kind: "return", value: src, loc });
  return {
    name,
    params: [
      { localId: a.localId, name: "a", type: BYTES_U8 },
      ...(f === null ? [] : [{ localId: f.localId, name: "f", type: fnT }]),
    ],
    returnType: BYTES_U8,
    locals: b.locals,
    body: distinctNodes(body),
    loc,
  };
}
