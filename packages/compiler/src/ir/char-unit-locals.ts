import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { mapExprChildren, mapStmtChildren } from "./traverse.js";
import { type IrFieldWalker, walkStmtFields } from "./fields.generated.js";

type CharAt = IrExpr & { kind: "strIntrinsic" };
type UnitUse = IrExpr & { kind: "strEq" | "strCmp" };
type CompareOp = "<" | "<=" | ">" | ">=";

const FLIPPED = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as const;

/** Character reads and locals held as their code unit.
 *
 * `const c = s[i]` (or `s.charAt(i)`) followed only by tests such as
 * `c === " "`, `c >= "a" && c <= "z"` or `switch (c) { case "x": ... }`
 * against literals of one UTF-16 code unit builds a one-character string
 * and compares strings, though every answer follows from the code unit.
 * Such a local holds `s.charCodeAt(i)` instead, and each test compares
 * numbers:
 * - a one-unit string compares as its unit;
 * - charAt reads "" for an index out of range, and charCodeAt reads NaN.
 *   "" equals no one-unit literal and is below each, while NaN equals no
 *   unit and fails every ordered comparison, so `c < "x"` becomes
 *   `!(c >= 120)`.
 *
 * Only immutable unboxed string locals qualify, with one declaration whose
 * initializer is a one-argument charAt, and with no other mention of the
 * local. The same tests of `s.charAt(i)` in place compare
 * `s.charCodeAt(i)`, so a loop version sees one kind of read.
 *
 * `s[i]` with an index not proven in bounds reads the character or
 * undefined (an optional read, see `optionalCharRead`). Its tests against
 * one-unit literals compare `i === Math.floor(i) ? s.charCodeAt(i) : NaN`
 * instead: undefined, like NaN, equals no literal and fails every ordered
 * comparison, and charCodeAt answers NaN out of range. That holds both for
 * the read in place and for an immutable local initialized from it and
 * used only in such tests and in tests for undefined, which become NaN
 * tests. */
export function holdCharLocalsAsUnits(mod: IrModule): IrModule {
  let changed = false;
  const functions = mod.functions.map((fn) => {
    const next = rewriteFunction(fn);
    if (next !== fn) changed = true;
    return next;
  });
  return changed ? { ...mod, functions } : mod;
}

/** The read of `s[i]` for an index not proven in bounds: temps for the
 * string and the index, then the string's charAt when the index is an
 * integer in [0, length) and undefined otherwise. */
interface OptionalCharRead {
  /** The temps' declarations, and whether both operands are plain (local
   * reads and literals), which the unit read may evaluate in place. */
  temps: [IrStmt & { kind: "varDecl" }, IrStmt & { kind: "varDecl" }];
  plain: boolean;
  receiver: IrExpr;
  index: IrExpr;
  unionId: string;
  stringTag: number;
  undefinedTag: number;
}

function optionalCharRead(e: IrExpr): OptionalCharRead | null {
  if (e.kind !== "seqExpr" || e.stmts.length !== 2 || e.diverges) return null;
  const [str, idx] = e.stmts;
  if (str?.kind !== "varDecl" || idx?.kind !== "varDecl" || !str.init || !idx.init) return null;
  const isStr = (x: IrExpr): boolean => x.kind === "varRef" && x.localId === str.localId;
  const isIdx = (x: IrExpr): boolean => x.kind === "varRef" && x.localId === idx.localId;
  const r = e.result;
  if (r.kind !== "ternary") return null;
  const c = r.cond;
  if (c.kind !== "logical" || c.op !== "&&" || c.left.kind !== "logical" || c.left.op !== "&&")
    return null;
  const [low, high, whole] = [c.left.left, c.left.right, c.right];
  if (
    !(
      low.kind === "bin" &&
      low.op === ">=" &&
      isIdx(low.left) &&
      low.right.kind === "numLit" &&
      low.right.value === 0
    ) ||
    !(
      high.kind === "bin" &&
      high.op === "<" &&
      isIdx(high.left) &&
      high.right.kind === "strIntrinsic" &&
      high.right.method === "length" &&
      isStr(high.right.receiver)
    ) ||
    !(
      whole.kind === "bin" &&
      whole.op === "===" &&
      isIdx(whole.left) &&
      whole.right.kind === "libCall" &&
      whole.right.fn === "math.floor" &&
      whole.right.args.length === 1 &&
      isIdx(whole.right.args[0]!)
    )
  )
    return null;
  const [present, absent] = [r.then, r.else_];
  if (present.kind !== "unionWrap" || absent.kind !== "unionWrap") return null;
  if (present.unionId !== absent.unionId) return null;
  const read = present.value;
  if (
    read.kind !== "strIntrinsic" ||
    read.method !== "charAt" ||
    !isStr(read.receiver) ||
    read.args.length !== 1 ||
    !isIdx(read.args[0]!)
  )
    return null;
  if (absent.value.kind !== "unitLit" || absent.value.unit !== "undefined") return null;
  return {
    temps: [str, idx],
    plain: plainOperand(str.init) && plainOperand(idx.init),
    receiver: str.init,
    index: idx.init,
    unionId: present.unionId,
    stringTag: present.tag,
    undefinedTag: absent.tag,
  };
}

function plainOperand(e: IrExpr): boolean {
  return e.kind === "varRef" || e.kind === "numLit" || e.kind === "strLit";
}

/** `i === Math.floor(i) ? s.charCodeAt(i) : NaN`: the code unit of an
 * optional read, or NaN where it reads undefined. Plain operands are read
 * in place; others keep the read's temps, so each is evaluated once. */
function unitRead(read: OptionalCharRead, loc: IrExpr["loc"]): IrExpr {
  if (!read.plain) {
    const [str, idx] = read.temps;
    const temp = (decl: IrStmt & { kind: "varDecl" }, type: IrExpr["type"]): IrExpr => ({
      kind: "varRef",
      localId: decl.localId,
      type,
      loc,
    });
    return {
      kind: "seqExpr",
      stmts: [{ ...str }, { ...idx }],
      result: unitOf(temp(str, read.receiver.type), () => temp(idx, F64), loc),
      type: F64,
      loc,
    };
  }
  return unitOf({ ...read.receiver }, () => ({ ...read.index }), loc);
}

function unitOf(receiver: IrExpr, index: () => IrExpr, loc: IrExpr["loc"]): IrExpr {
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: index(),
      right: { kind: "libCall", fn: "math.floor", args: [index()], type: F64, loc },
      type: BOOL,
      loc,
    },
    then: {
      kind: "strIntrinsic",
      method: "charCodeAt",
      receiver,
      args: [index()],
      type: F64,
      loc,
    },
    else_: { kind: "numLit", value: NaN, type: F64, loc },
    type: F64,
    loc,
  };
}

/** A test of an operand that reads one character or undefined, against a
 * literal of one code unit or for undefined, and the same test on the
 * operand's code unit. `tagsOf` gives the operand's union tags. */
interface UnitTest {
  operand: IrExpr;
  /** The test reads the unit twice. */
  twice?: boolean;
  test: (unit: () => IrExpr) => IrExpr;
}

function optionalUnitTest(
  e: IrExpr,
  tagsOf: (operand: IrExpr) => OptionalCharRead | null,
): UnitTest | null {
  const loc = e.loc;
  const compare = (op: "===" | "!==" | CompareOp, u: IrExpr, right: IrExpr): IrExpr => ({
    kind: "bin",
    op,
    left: u,
    right,
    type: BOOL,
    loc,
  });
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  if (e.kind === "unionEq" && !e.sameValue) {
    for (const [operand, other] of [
      [e.left, e.right],
      [e.right, e.left],
    ] as const) {
      const tags = tagsOf(operand);
      if (
        tags &&
        tags.unionId === e.unionId &&
        other.kind === "unionWrap" &&
        other.tag === tags.stringTag &&
        other.value.kind === "strLit" &&
        other.value.value.length === 1
      ) {
        const code = other.value.value.charCodeAt(0);
        return {
          operand,
          test: (unit) => compare(e.negated ? "!==" : "===", unit(), num(code)),
        };
      }
      // `case undefined:` of a switch: undefined is a NaN unit.
      if (
        tags &&
        tags.unionId === e.unionId &&
        other.kind === "unionWrap" &&
        other.tag === tags.undefinedTag &&
        other.value.kind === "unitLit" &&
        other.value.unit === "undefined"
      )
        return {
          operand,
          twice: true,
          test: (unit) => compare(e.negated ? "===" : "!==", unit(), unit()),
        };
    }
    return null;
  }
  if (e.kind === "libCall" && e.fn === "js.compare" && e.args.length === 3) {
    const [a, b, opArg] = e.args as [IrExpr, IrExpr, IrExpr];
    if (opArg.kind !== "strLit" || !(opArg.value in FLIPPED)) return null;
    const op = opArg.value as CompareOp;
    const literalOf = (x: IrExpr): number | null =>
      x.kind === "libCall" &&
      x.fn === "js.fromStr" &&
      x.args.length === 1 &&
      x.args[0]!.kind === "strLit" &&
      x.args[0]!.value.length === 1
        ? x.args[0]!.value.charCodeAt(0)
        : null;
    const operandOf = (x: IrExpr): IrExpr | null =>
      x.kind === "libCall" &&
      x.fn === "js.fromDyn" &&
      x.args.length === 1 &&
      x.args[0]!.kind === "dynFrom" &&
      tagsOf(x.args[0]!.value)
        ? x.args[0]!.value
        : null;
    // The comparison with the operand on the left.
    const left = operandOf(a);
    const right = operandOf(b);
    const code = left ? literalOf(b) : right ? literalOf(a) : null;
    const operand = left ?? right;
    if (operand === null || code === null) return null;
    const ordered = left ? op : FLIPPED[op];
    return { operand, test: (unit) => compare(ordered, unit(), num(code)) };
  }
  if (e.kind === "unionIsTag") {
    const tags = tagsOf(e.value);
    if (!tags || tags.unionId !== e.unionId) return null;
    if (e.tag !== tags.undefinedTag && e.tag !== tags.stringTag) return null;
    // Undefined is a NaN unit; a character is any other.
    const present = (e.tag === tags.stringTag) !== e.negated;
    return {
      operand: e.value,
      twice: true,
      test: (unit) => compare(present ? "===" : "!==", unit(), unit()),
    };
  }
  return null;
}

function rewriteFunction(fn: IrFunction): IrFunction {
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const candidates = new Set(
    fn.locals
      .filter(
        (l) => !l.mutable && !l.boxed && (l.type.kind === "string" || l.type.kind === "union"),
      )
      .map((l) => l.id),
  );
  // The optional reads candidate union locals are declared from, directly
  // or as copies of another such local (a switch's discriminant temp).
  const reads = new Map<string, OptionalCharRead>();
  const copyOf = new Map<string, string>();
  // Whether a candidate string is declared from a charAt.
  let charAtDeclared = false;
  // The declarations, in the order a walk of every field finds them.
  const collector: IrFieldWalker = {
    node: (node) => {
      if (node.kind !== "varDecl" || !candidates.has(node.localId) || !node.init) return;
      const id = node.localId;
      const init = node.init;
      if (locals.get(id)?.type.kind === "string" && isCharAt(init)) charAtDeclared = true;
      const read = optionalCharRead(init);
      if (read) reads.set(id, read);
      else if (init.kind === "varRef" && reads.has(init.localId)) {
        reads.set(id, reads.get(init.localId)!);
        copyOf.set(id, init.localId);
      }
    },
    string: () => {},
  };
  // Both walks only record candidates: a function without one holds none.
  if (candidates.size > 0) for (const stmt of fn.body) walkStmtFields(stmt, collector, false);
  const localTags = (operand: IrExpr): OptionalCharRead | null =>
    operand.kind === "varRef" ? (reads.get(operand.localId) ?? null) : null;

  // Every mention of a candidate, in any field, against the mentions the
  // rewrite understands.
  const mentions = new Map<string, number>();
  const understood = new Map<string, number>();
  const declarations = new Map<string, number>();
  const note = (map: Map<string, number>, id: string): void => {
    map.set(id, (map.get(id) ?? 0) + 1);
  };
  const counter: IrFieldWalker = {
    node: (node) => {
      const id = understoodMention(node, locals, reads, localTags);
      if (id !== null && candidates.has(id)) {
        note(understood, id);
        if (node.kind === "varDecl") note(declarations, id);
      }
    },
    string: (value) => {
      if (candidates.has(value)) note(mentions, value);
    },
  };
  // Only candidates declared from a charAt or an optional read can be held
  // (understoodMention), and the count only decides which are.
  if (reads.size > 0 || charAtDeclared)
    for (const stmt of fn.body) walkStmtFields(stmt, counter, false);
  // A copy is held only with its source, and the source's mention in the
  // copy's initializer is understood only while the copy is held.
  const held = new Set<string>();
  for (const id of candidates)
    if (declarations.get(id) === 1 && (mentions.get(id) ?? 0) > 0) held.add(id);
  for (let settled = false; !settled;) {
    settled = true;
    for (const id of held) {
      let copies = 0;
      for (const [copy, source] of copyOf) if (source === id && held.has(copy)) copies++;
      const source = copyOf.get(id);
      if (
        mentions.get(id) !== (understood.get(id) ?? 0) + copies ||
        (source !== undefined && !held.has(source))
      ) {
        held.delete(id);
        settled = false;
      }
    }
  }

  const unitRef = (id: string, loc: IrExpr["loc"]): IrExpr => ({
    kind: "varRef",
    localId: id,
    type: F64,
    loc,
  });
  // Operands of optional unit tests: held union locals and reads in place.
  const operandTags = (operand: IrExpr): OptionalCharRead | null =>
    operand.kind === "varRef"
      ? held.has(operand.localId)
        ? localTags(operand)
        : null
      : optionalCharRead(operand);
  let changed = false;
  const rewriteExpr = (e: IrExpr): IrExpr => {
    if (e.kind === "strEq" || e.kind === "strCmp") {
      const use = unitUse(e);
      if (use && held.has(use.id)) {
        changed = true;
        return charUnitTest(e, unitRef(use.id, e.loc), use.code, use.left);
      }
      // `s.charAt(i)` in place: its unit read, `s.charCodeAt(i)`.
      const direct = charAtTest(e);
      if (direct) {
        changed = true;
        const read: IrExpr = {
          ...direct.charAt,
          method: "charCodeAt",
          receiver: rewriteExpr(direct.charAt.receiver),
          args: direct.charAt.args.map(rewriteExpr),
          type: F64,
        };
        return charUnitTest(e, read, direct.code, direct.left);
      }
    }
    const optional = optionalUnitTest(e, operandTags);
    if (optional) {
      const operand = optional.operand;
      if (operand.kind === "varRef") {
        changed = true;
        return optional.test(() => unitRef(operand.localId, e.loc));
      }
      // A read that keeps its temps declares them once: one unit read.
      const read = optionalCharRead(operand)!;
      if (read.plain || !optional.twice) {
        changed = true;
        const rewritten = rewriteRead(read);
        return optional.test(() => unitRead(rewritten, operand.loc));
      }
    }
    return mapExprChildren(e, rewriteExpr, rewriteStmt);
  };
  // A read's receiver and index may test other held locals.
  const rewriteRead = (read: OptionalCharRead): OptionalCharRead => {
    const [str, idx] = read.temps;
    return {
      ...read,
      temps: [
        { ...str, init: rewriteExpr(str.init!) },
        { ...idx, init: rewriteExpr(idx.init!) },
      ],
      receiver: rewriteExpr(read.receiver),
      index: rewriteExpr(read.index),
    };
  };
  const rewriteStmt = (s: IrStmt): IrStmt => {
    if (s.kind === "varDecl" && held.has(s.localId) && s.init) {
      changed = true;
      const source = copyOf.get(s.localId);
      if (source !== undefined) return { ...s, init: unitRef(source, s.init.loc) };
      const read = reads.get(s.localId);
      if (read) return { ...s, init: unitRead(rewriteRead(read), s.init.loc) };
      if (s.init.kind === "strIntrinsic")
        return {
          ...s,
          init: {
            ...s.init,
            method: "charCodeAt",
            receiver: rewriteExpr(s.init.receiver),
            args: s.init.args.map(rewriteExpr),
            type: F64,
          },
        };
    }
    if (s.kind === "switch" && s.disc.kind === "varRef" && held.has(s.disc.localId)) {
      changed = true;
      return {
        ...s,
        disc: unitRef(s.disc.localId, s.disc.loc),
        cases: s.cases.map((c) => ({
          ...c,
          test:
            c.test?.kind === "strLit"
              ? { kind: "numLit", value: c.test.value.charCodeAt(0), type: F64, loc: c.test.loc }
              : c.test,
          body: c.body.map(rewriteStmt),
        })),
      };
    }
    return mapStmtChildren(s, rewriteExpr, rewriteStmt);
  };
  const body = fn.body.map(rewriteStmt);
  if (!changed) return fn;
  return {
    ...fn,
    body,
    locals: fn.locals.map((l) => (held.has(l.id) ? unitLocal(l) : l)),
  };
}

/** The local, holding the code unit instead of the one-character string. */
function unitLocal(local: IrLocal): IrLocal {
  return { ...local, type: F64 };
}

/** The local a node mentions in a form the rewrite handles: a string
 * local's declaration from a one-argument charAt, one-unit test, or switch
 * over one-unit cases; a union local's declaration from an optional read,
 * or its test against a one-unit literal or for undefined. */
function understoodMention(
  n: IrExpr | IrStmt,
  locals: ReadonlyMap<string, IrLocal>,
  reads: ReadonlyMap<string, OptionalCharRead>,
  localTags: (operand: IrExpr) => OptionalCharRead | null,
): string | null {
  const kind = n.kind;
  if (
    kind !== "varDecl" &&
    kind !== "strEq" &&
    kind !== "strCmp" &&
    kind !== "switch" &&
    kind !== "unionEq" &&
    kind !== "libCall" &&
    kind !== "unionIsTag"
  )
    return null;
  if (n.kind === "varDecl") {
    if (!n.init) return null;
    const local = locals.get(n.localId);
    if (local?.type.kind === "string") return isCharAt(n.init) ? n.localId : null;
    const read = reads.get(n.localId);
    return read && local?.type.kind === "union" && local.type.unionId === read.unionId
      ? n.localId
      : null;
  }
  if (n.kind === "strEq" || n.kind === "strCmp") return unitUse(n)?.id ?? null;
  if (n.kind === "switch") {
    if (n.disc.kind !== "varRef" || n.disc.type.kind !== "string") return null;
    if (!n.cases.some((c) => c.test !== null)) return null;
    const units = n.cases.every(
      (c) => c.test === null || (c.test.kind === "strLit" && c.test.value.length === 1),
    );
    return units ? n.disc.localId : null;
  }
  const optional = optionalUnitTest(n as IrExpr, localTags);
  return optional?.operand.kind === "varRef" ? optional.operand.localId : null;
}

/** A one-unit test of a string that reads one character or "" (charAt),
 * on its unit `unit`, which reads NaN for "": an equality, or an ordered
 * comparison with the unit on the left when `unitLeft`. "" is below every
 * one-unit literal, and NaN fails every ordered comparison, so `c < "x"`
 * becomes `!(c >= 120)`. */
function charUnitTest(e: UnitUse, unit: IrExpr, code: number, unitLeft: boolean): IrExpr {
  const literal: IrExpr = { kind: "numLit", value: code, type: F64, loc: e.loc };
  if (e.kind === "strEq")
    return {
      kind: "bin",
      op: e.negated ? "!==" : "===",
      left: unit,
      right: literal,
      type: BOOL,
      loc: e.loc,
    };
  const op = unitLeft ? e.op : FLIPPED[e.op];
  if (op === ">" || op === ">=")
    return { kind: "bin", op, left: unit, right: literal, type: BOOL, loc: e.loc };
  const negation: IrExpr = {
    kind: "bin",
    op: op === "<" ? ">=" : ">",
    left: unit,
    right: literal,
    type: BOOL,
    loc: e.loc,
  };
  return { kind: "unary", op: "!", operand: negation, type: BOOL, loc: e.loc };
}

/** A test between `s.charAt(i)` and a literal of one code unit. */
function charAtTest(e: UnitUse): { charAt: CharAt; code: number; left: boolean } | null {
  const literalRight = e.right.kind === "strLit";
  const literal = literalRight ? e.right : e.left;
  const other = literalRight ? e.left : e.right;
  if (literal.kind !== "strLit" || literal.value.length !== 1 || !isCharAt(other)) return null;
  return { charAt: other, code: literal.value.charCodeAt(0), left: literalRight };
}

function isCharAt(e: IrExpr): e is CharAt {
  return e.kind === "strIntrinsic" && e.method === "charAt" && e.args.length === 1;
}

/** A test between a local and a literal of one code unit. */
function unitUse(e: UnitUse): { id: string; code: number; left: boolean } | null {
  const literalRight = e.right.kind === "strLit";
  const literal = literalRight ? e.right : e.left;
  const other = literalRight ? e.left : e.right;
  if (literal.kind !== "strLit" || literal.value.length !== 1 || other.kind !== "varRef")
    return null;
  return { id: other.localId, code: literal.value.charCodeAt(0), left: literalRight };
}
