import {
  BOOL,
  F64,
  VOID,
  arrayOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "../../packages/compiler/src/ir/ir.js";
import { IR_VERSION } from "../../packages/compiler/src/ir/serialize.js";

export interface RangeCase {
  name: string;
  module: IrModule;
  expected: { start: number; min: number | null; max: number | null; present?: boolean }[];
}

/** Source positions identify expression occurrences across serialization;
 * object identity is deliberately exercised inside the native fixture too. */
export function integerRangeCases(): RangeCase[] {
  let position = 0;
  const loc = () => ({ file: "ranges.ts", start: position++, end: position });
  const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc: loc() });
  const reference = (localId = "x"): IrExpr => ({ kind: "varRef", localId, type: F64, loc: loc() });
  const binary = (
    op: Extract<IrExpr, { kind: "bin" }>["op"],
    left: IrExpr,
    right: IrExpr,
  ): IrExpr => ({ kind: "bin", op, left, right, type: F64, loc: loc() });
  const statement = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc: loc() });
  const assign = (value: IrExpr, localId = "x"): IrStmt => ({
    kind: "assign",
    localId,
    value,
    loc: loc(),
  });
  const bool = (): IrExpr => ({ kind: "boolLit", value: true, type: BOOL, loc: loc() });
  const fn = (body: IrStmt[]): IrFunction => ({
    name: "main",
    params: [],
    locals: [{ id: "x", name: "x", type: F64, mutable: true }],
    returnType: VOID,
    body,
    loc: loc(),
  });
  const cases: RangeCase[] = [];
  const add = (
    name: string,
    body: IrStmt[],
    expected: RangeCase["expected"],
    transform?: (fn: IrFunction) => void,
  ): void => {
    const func = fn(body);
    transform?.(func);
    cases.push({
      name,
      module: { irVersion: IR_VERSION, sourceFile: "ranges.ts", entry: "main", functions: [func] },
      expected,
    });
  };
  const proof = (expr: IrExpr, min: number | null, max = min, present = true) => ({
    start: expr.loc.start,
    min,
    max,
    present,
  });

  for (const value of [
    0,
    -0,
    1,
    -1,
    0.5,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const input = number(value);
    const exact = Number.isSafeInteger(value) && !Object.is(value, -0) ? value : null;
    add(
      `literal ${Object.is(value, -0) ? "-0" : String(value)}`,
      [statement(input)],
      [proof(input, exact)],
    );
  }
  for (const op of ["|", "&", "^", "<<", ">>", ">>>"] as const) {
    const value = binary(op, reference(), number(0));
    add(
      `bitwise ${op}`,
      [statement(value)],
      [
        proof(
          value,
          op === "&" || op === ">>>" ? 0 : -2147483648,
          op === "&" ? 0 : op === ">>>" ? 4294967295 : 2147483647,
        ),
      ],
    );
  }
  for (const op of ["+", "-", "*", "/", "%"] as const) {
    const value = binary(op, reference(), number(3));
    const min = op === "+" ? 12 : op === "-" ? 6 : op === "*" ? 27 : op === "%" ? 0 : null;
    add(
      `arithmetic ${op}`,
      [assign(number(9)), statement(value)],
      [proof(value, min, op === "%" ? 2 : min)],
    );
  }
  const overflow = binary("+", number(Number.MAX_SAFE_INTEGER), number(1));
  add("inexact sum", [statement(overflow)], [proof(overflow, null)]);
  const bounded = binary(
    "+",
    binary("|", reference(), number(0)),
    binary(">>>", reference(), number(0)),
  );
  add(
    "combined signed and unsigned bounds",
    [statement(bounded)],
    [proof(bounded, -2147483648, 6442450942)],
  );
  const unary: IrExpr = { kind: "unary", op: "~", operand: reference(), type: F64, loc: loc() };
  add("bitwise complement", [statement(unary)], [proof(unary, -2147483648, 2147483647)]);

  for (const storage of ["boxed", "tdz", "captured", "parameter", "global"] as const) {
    const read = reference(storage === "global" ? "global" : "x");
    const body = storage === "parameter" ? [statement(read)] : [assign(number(7)), statement(read)];
    add(`${storage} storage is conservative`, body, [proof(read, null)], (func) => {
      if (storage === "boxed") func.locals[0]!.boxed = true;
      if (storage === "tdz") func.locals[0]!.tdz = true;
      if (storage === "captured") func.captures = [{ localId: "x", name: "x", type: F64 }];
      if (storage === "parameter") func.params = [{ localId: "x", name: "x", type: F64 }];
    });
  }
  for (const suspension of ["async", "generator"] as const) {
    const value = number(9);
    add(
      `${suspension} suspends analysis`,
      [statement(value)],
      [proof(value, null, null, false)],
      (func) => {
        if (suspension === "async") func.async = true;
        else
          func.generator = {
            yieldT: F64,
            nextT: F64,
            resultType: { kind: "record", shapeId: "result" },
          };
      },
    );
  }

  const regions = [
    "block",
    "if",
    "while",
    "doWhile",
    "for",
    "forOf",
    "switch",
    "tryCatch",
  ] as const;
  for (const region of regions) {
    const before = reference();
    const inside = reference();
    const after = reference();
    const body = [assign(number(11)), statement(inside)];
    let control: IrStmt;
    switch (region) {
      case "block":
        control = { kind: "block", body, loc: loc() };
        break;
      case "if":
        control = { kind: "if", cond: before, then: body, else_: [], loc: loc() };
        break;
      case "while":
        control = { kind: "while", cond: before, body, loc: loc() };
        break;
      case "doWhile":
        control = { kind: "doWhile", cond: before, body, loc: loc() };
        break;
      case "for":
        control = {
          kind: "for",
          init: assign(before),
          cond: bool(),
          update: assign(number(100)),
          body,
          loc: loc(),
        };
        break;
      case "forOf":
        control = {
          kind: "forOf",
          localId: "x",
          iterable: { kind: "arrayLit", elems: [before], type: arrayOf(F64), loc: loc() },
          body,
          loc: loc(),
        };
        break;
      case "switch":
        control = {
          kind: "switch",
          disc: before,
          cases: [
            { test: number(1), body },
            { test: null, body: [] },
          ],
          loc: loc(),
        };
        break;
      case "tryCatch":
        control = {
          kind: "tryCatch",
          tryBody: body,
          catchBody: [statement(before)],
          catchLocalId: null,
          finallyBody: [],
          loc: loc(),
        };
        break;
    }
    // Where control flow is not followed, x keeps only the closed range: it
    // enters as 3 and the region's only write is 11, so the closures narrow
    // to their join. The for loop's `x = x` initializer evaluates to the
    // whole bound the closure assumes (int32 and uint32 at once), and the
    // for-of loop binds x itself to unproven elements, so nothing survives.
    const closed = region === "for" ? ([0, 2147483647] as const) : ([3, 11] as const);
    const expected = [
      proof(inside, 11),
      region === "block"
        ? proof(after, 11)
        : region === "if"
          ? proof(after, 3, 11)
          : region === "forOf"
            ? proof(after, null)
            : proof(after, ...closed),
    ];
    if (region !== "block")
      expected.push(
        region === "if" || region === "for" || region === "forOf"
          ? proof(before, 3)
          : proof(before, ...closed),
      );
    add(
      `${region} regions retain only valid entry and exit facts`,
      [assign(number(3)), control, statement(after)],
      expected,
    );
  }
  const thenRead = reference();
  const elseRead = reference();
  add(
    "branches never pass facts to their siblings",
    [
      {
        kind: "if",
        cond: bool(),
        then: [assign(number(4)), statement(thenRead)],
        else_: [statement(elseRead)],
        loc: loc(),
      },
    ],
    [proof(thenRead, 4), proof(elseRead, null)],
  );
  const caught = reference();
  const final = reference();
  add(
    "catch and finally have independent facts",
    [
      {
        kind: "tryCatch",
        tryBody: [assign(number(4))],
        catchBody: [statement(caught), assign(number(5))],
        catchLocalId: null,
        finallyBody: [statement(final)],
        loc: loc(),
      },
    ],
    [proof(caught, null), proof(final, null)],
  );

  const children: IrExpr[] = [number(2), reference(), number(6)];
  const opaque: IrExpr = {
    kind: "seqExpr",
    stmts: [assign(children[0]!), statement(children[1]!)],
    result: children[2]!,
    type: F64,
    loc: loc(),
  };
  const afterOpaque = reference();
  add(
    "sequence expressions preserve evaluated writes and result facts",
    [assign(number(1)), statement(opaque), statement(afterOpaque)],
    [
      proof(children[0]!, 2),
      proof(children[1]!, 2),
      proof(children[2]!, 6),
      proof(opaque, 6),
      proof(afterOpaque, 2),
    ],
  );
  const left = reference();
  const hidden = reference();
  const right: IrExpr = { kind: "call", callee: "unknown", args: [hidden], type: F64, loc: loc() };
  const afterward = reference();
  add(
    "calls preserve uncaptured slots and already read operands",
    [assign(number(5)), statement(binary("|", left, right)), statement(afterward)],
    [proof(left, 5), proof(hidden, 5), proof(afterward, 5)],
  );
  const stored = reference();
  const arr: IrExpr = { kind: "arrayLit", elems: [], type: arrayOf(F64), loc: loc() };
  const afterStore = reference();
  add(
    "stores preserve unwritten slots and visit all operands",
    [
      assign(number(3)),
      { kind: "arraySet", arr, index: number(0), value: stored, loc: loc() },
      statement(afterStore),
    ],
    [proof(stored, 3), proof(afterStore, 3)],
  );
  const declared = reference();
  const uninitialized = reference();
  add(
    "declaration reset",
    [
      { kind: "varDecl", localId: "x", init: number(6), loc: loc() },
      statement(declared),
      { kind: "varDecl", localId: "x", init: null, loc: loc() },
      statement(uninitialized),
    ],
    [proof(declared, 6), proof(uninitialized, null)],
  );
  const returned = reference();
  const unreachable = reference();
  add(
    "return ends straight-line facts",
    [assign(number(4)), { kind: "return", value: returned, loc: loc() }, statement(unreachable)],
    [proof(returned, 4), proof(unreachable, null)],
  );
  const cursor = reference("cursor"),
    decoded = reference("decoded"),
    head = reference();
  add(
    "filtered strides bound output cursors and preserve decoded integers",
    [
      assign(number(0), "cursor"),
      {
        kind: "for",
        init: { kind: "varDecl", localId: "x", init: number(0), loc: loc() },
        cond: { kind: "bin", op: "<", left: head, right: number(100), type: BOOL, loc: loc() },
        update: assign(binary("+", reference(), number(24))),
        loc: loc(),
        body: [
          {
            kind: "varDecl",
            localId: "decoded",
            init: binary(">>>", reference("input"), number(0)),
            loc: loc(),
          },
          {
            kind: "if",
            cond: bool(),
            then: [{ kind: "continue", loc: loc() }],
            else_: null,
            loc: loc(),
          },
          statement(cursor),
          statement(decoded),
          assign(binary("+", reference("cursor"), number(16)), "cursor"),
        ],
      },
    ],
    // Passes enter at 0, 24, 48, 72 and 96 (at most 99), so the failing test reads at most 123.
    [proof(cursor, 0, 80), proof(decoded, 0, 4294967295), proof(head, 0, 123)],
    (func) => {
      for (const id of ["cursor", "decoded"])
        func.locals.push({ id, name: id, type: F64, mutable: true });
    },
  );
  return cases;
}
