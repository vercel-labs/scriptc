import {
  BOOL,
  DYN,
  F64,
  VOID,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "./ir.js";
import { numLit, strLit, varRef } from "./build.js";
import { everyStmtList, mapExprChildren, mapStmtChildren, transformStmtList } from "./traverse.js";
import { reparseExpr, reparseStmt } from "./serialize.js";
import { type IrNodeIndex } from "./node-index.js";

/** Largest body (IR nodes) a clone is made from. */
const MAX_FUNCTION_NODES = 300;
/** Clones of one function: one per parameter and argument type. */
const MAX_CLONES_PER_FUNCTION = 4;
/** Module-wide cloned nodes: at least this many, or this share of the module. */
const MIN_CLONED_NODES = 4000;
const CLONED_NODE_FRACTION = 0.05;

type RecordType = Extract<IrType, { kind: "record" }>;
type CallExpr = Extract<IrExpr, { kind: "call" }>;
type VarRef = Extract<IrExpr, { kind: "varRef" }>;

/** What a dynamic property helper does with its arguments, read from the
 * helper's body (see `propertyOp`). `receiver`, `key` and `value` are
 * parameter indexes of the helper, which are argument indexes of its calls.
 * `key` is a constant when the helper's operation names one. */
interface PropertyOp {
  kind: "get" | "set" | "has";
  receiver: number;
  key: number | { literal: string } | null;
  value?: number;
  /** The operation's source range in the helper: the key a sloppy-mode
   * write is listed under (IrModule.sloppyDynWrites). */
  loc: SrcLoc;
}

/** The dynamic operations that read a value's properties without retaining
 * it or observing its identity, so a capsule built for them is
 * interchangeable with the one the caller passed. */
const PROPERTY_OBSERVERS: ReadonlySet<string> = new Set(["dyn.in", "dyn.hasKeyComputed"]);

/** The conversion calls that wrap a static value before a dynamic store. */
const STORE_CONVERSIONS: ReadonlySet<string> = new Set([
  "js.fromF64",
  "js.fromStr",
  "js.fromBool",
  "js.fromBigInt",
]);

/** Thrown when the parameter's uses do not fit a clone; a clone that hits
 * one is not made. */
const NOT_A_CLONE = Symbol("not a clone");

function reject(): never {
  throw NOT_A_CLONE;
}

function countNodes(fn: IrFunction, index?: IrNodeIndex): number {
  const recorded = index?.nodeCount(fn);
  if (recorded !== undefined) return recorded;
  let count = 0;
  everyStmtList(fn.body, {
    stmt: () => ++count <= MAX_FUNCTION_NODES,
    expr: () => ++count <= MAX_FUNCTION_NODES,
  });
  return count;
}

/** The single parameter a dynamic operation reaches through its operand, or
 * null when the operand names none or several. */
function operandParam(operand: IrExpr, params: ReadonlyMap<string, number>): number | null {
  let found: number | null = null;
  let several = false;
  const visit = (node: IrExpr): void => {
    if (node.kind !== "varRef") return;
    const index = params.get(node.localId);
    if (index === undefined) return;
    if (found === null) found = index;
    else if (found !== index) several = true;
  };
  walkExpr(operand, visit);
  return several ? null : found;
}

/** Calls `visit` on `node` and every expression below it. */
function walkExpr(node: IrExpr, visit: (node: IrExpr) => void): void {
  visit(node);
  mapExprChildren(
    node,
    (child) => {
      walkExpr(child, visit);
      return child;
    },
    (statement) => {
      walkStmt(statement, visit);
      return statement;
    },
  );
}

function walkStmt(node: IrStmt, visit: (node: IrExpr) => void): void {
  mapStmtChildren(
    node,
    (child) => {
      walkExpr(child, visit);
      return child;
    },
    (child) => {
      walkStmt(child, visit);
      return child;
    },
  );
}

/** The key a dynamic operation reads: a constant the helper names, the
 * parameter it passes, or null. */
function keyOperand(
  key: IrExpr | undefined,
  params: ReadonlyMap<string, number>,
): number | { literal: string } | null {
  if (!key) return null;
  if (key.kind === "strLit") return { literal: key.value };
  return operandParam(key, params);
}

/** What `fn` does, when it is one of the dynamic object helpers the
 * frontend emits for a `dyn` receiver (`%dyn.class.*`). The operation is
 * read from the helper's own generic tail — the last dynamic property
 * operation in its body — and its receiver, key and value from the
 * parameters those operands reach, never from the helper's name, because
 * the same name carries different operations in different modules. */
function propertyOp(fn: IrFunction): PropertyOp | null {
  if (!fn.name.startsWith("%dyn.class.")) return null;
  if (fn.captures !== undefined || fn.classCaptures?.length) return null;
  const params = new Map(fn.params.map((param, index) => [param.localId, index]));
  let found: PropertyOp | null = null;
  const consider = (node: IrExpr): void => {
    const op = operationOf(node, params);
    if (op) found = op;
  };
  for (const statement of fn.body) walkStmt(statement, consider);
  return found;
}

function operationOf(node: IrExpr, params: ReadonlyMap<string, number>): PropertyOp | null {
  if (node.kind === "dynKeyGet") {
    const receiver = operandParam(node.value, params);
    if (receiver === null) return null;
    const key = keyOperand(node.key, params);
    return key === null ? null : { kind: "get", receiver, key, loc: node.loc };
  }
  if (node.kind !== "libCall") return null;
  const args = node.args;
  const receiver = args[0] === undefined ? null : operandParam(args[0]!, params);
  if (receiver === null) return null;
  if (node.fn === "dyn.keySet" || node.fn === "dyn.keySetComputed") {
    const key = keyOperand(args[1], params);
    const value = args[2] === undefined ? null : operandParam(args[2]!, params);
    if (key === null || value === null) return null;
    return { kind: "set", receiver, key, value, loc: node.loc };
  }
  if (node.fn === "dyn.in" || node.fn === "dyn.hasKeyComputed" || node.fn === "dyn.hasOwnComputed")
    return { kind: "has", receiver, key: keyOperand(args[1], params), loc: node.loc };
  return null;
}

/** The record shapes a partial record assertion names: a value asserted to
 * one may lack fields the shape declares (`{ hits: 1 } as Stats`), and the
 * runtime answers a partial view whose absent fields a typed read throws on
 * (record-views.ts). The helper's read of such a field is a dynamic read,
 * which answers undefined as JavaScript does, so a clone — whose read is a
 * typed one — would change the program's answer. Calls that pass one of
 * these shapes keep the original function. */
function partialAssertionTargets(mod: IrModule): Set<string> {
  const targets = new Set<string>();
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind === "dynCheck" && expr.partialView === true && expr.type.kind === "record")
          targets.add(expr.type.shapeId);
        return true;
      },
    });
  return targets;
}

/** The helper bodies' shapes, by helper name. */
function helperOperations(mod: IrModule): Map<string, PropertyOp> {
  const ops = new Map<string, PropertyOp>();
  for (const fn of mod.functions) {
    const op = propertyOp(fn);
    if (op) ops.set(fn.name, op);
  }
  return ops;
}

/** The locals that hold the parameter `paramIndex` and nothing else: the
 * parameter itself and every local whose every definition copies one of
 * them. A cast that lowers to a plain copy (`const r = x as any`) is one of
 * these; a local written by anything else is not. Null when the parameter
 * or a copy can be observed through a closure. */
function receiverLocals(fn: IrFunction, paramIndex: number): Set<string> | null {
  const param = fn.params[paramIndex]!;
  const types = new Map(fn.locals.map((local) => [local.id, local]));
  const definitions = new Map<string, IrExpr[]>();
  const otherWrites = new Set<string>();
  const captured = new Set<string>();
  const note = (id: string, value: IrExpr | null): void => {
    if (value === null) {
      otherWrites.add(id);
      return;
    }
    const list = definitions.get(id);
    if (list === undefined) definitions.set(id, [value]);
    else list.push(value);
  };
  for (const statement of fn.body) {
    walkStmt(statement, (node) => {
      if (node.kind !== "closure") return;
      for (const id of node.captures) captured.add(id);
    });
  }
  // A write can sit at any depth of an expression, so every expression
  // below a statement is walked: an assignment the clone would leave in
  // place stores a dynamic value into the record-typed local.
  const scanExpr = (node: IrExpr): void => {
    if (node.kind === "assignExpr" || node.kind === "incDec") note(node.localId, null);
    mapExprChildren(
      node,
      (child) => {
        scanExpr(child);
        return child;
      },
      (child) => {
        scan(child);
        return child;
      },
    );
  };
  const scan = (statement: IrStmt): void => {
    if (statement.kind === "varDecl") note(statement.localId, statement.init);
    else if (statement.kind === "assign") note(statement.localId, statement.value);
    else if (statement.kind === "forOf") note(statement.localId, null);
    else if (statement.kind === "tryCatch" && statement.catchLocalId !== null)
      note(statement.catchLocalId, null);
    mapStmtChildren(
      statement,
      (child) => {
        scanExpr(child);
        return child;
      },
      (child) => {
        scan(child);
        return child;
      },
    );
  };
  for (const statement of fn.body) scan(statement);
  const members = new Set<string>([param.localId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, list] of definitions) {
      if (members.has(id) || otherWrites.has(id)) continue;
      const local = types.get(id);
      if (!local || local.type.kind !== "dyn" || local.boxed) continue;
      if (!list.length) continue;
      if (list.every((value) => value.kind === "varRef" && members.has(value.localId))) {
        members.add(id);
        changed = true;
      }
    }
  }
  const paramLocal = types.get(param.localId);
  if (paramLocal?.boxed) return null;
  // A parameter that is ever written holds something other than the
  // caller's value by then, so no typed use of it is exact.
  if (otherWrites.has(param.localId) || definitions.has(param.localId)) return null;
  for (const id of members) if (captured.has(id)) return null;
  return members;
}

interface RewriteContext {
  helpers: ReadonlyMap<string, PropertyOp>;
  records: ReadonlyMap<string, IrRecordShape>;
  /** IrModule.sloppyDynWrites: the source ranges of untyped property writes
   * in sloppy-mode code, which leave a frozen record unchanged. */
  sloppyWrites: ReadonlySet<string>;
}

/** The key a write's source range is listed under in
 * IrModule.sloppyDynWrites. */
function writeKey(loc: SrcLoc): string {
  return `${loc.file}\0${loc.start}\0${loc.end}`;
}

/** A clone of `origin` in which parameter `paramIndex` is `type`, its
 * dynamic property operations rewritten to typed record operations and
 * every other use taking a capsule built in place. Null when no operation
 * can be rewritten or a use of the parameter is not one the clone keeps
 * exact. */
function buildClone(
  context: RewriteContext,
  origin: IrFunction,
  paramIndex: number,
  type: RecordType,
): IrFunction | null {
  const members = receiverLocals(origin, paramIndex);
  if (members === null) return null;
  const declared = context.records.get(type.shapeId);
  if (!declared || declared.tuple) return null;
  const shape: IrRecordShape = declared;
  const extras: { id: string; name: string; type: IrType; mutable: boolean }[] = [];
  let rewritten = 0;

  const local = (name: string, localType: IrType, loc: SrcLoc): VarRef => {
    const id = `${name}.${origin.locals.length + extras.length}`;
    extras.push({ id, name, type: localType, mutable: false });
    return varRef(id, localType, loc) as VarRef;
  };
  const capsule = (value: IrExpr, loc: SrcLoc): IrExpr => ({
    kind: "dynFrom",
    value,
    type: DYN,
    liveRef: true,
    loc,
  });
  const typed = (ref: VarRef): IrExpr => ({ ...ref, type });

  function field(name: string): { name: string; type: IrType } | undefined {
    return shape.fields.find((candidate) => candidate.name === name);
  }

  function recordGet(receiver: IrExpr, declared: { name: string; type: IrType }): IrExpr {
    return {
      kind: "recordGet",
      obj: receiver,
      shapeId: shape.id,
      field: declared.name,
      type: declared.type,
      loc: receiver.loc,
    };
  }

  /** The record write, behind the frozen-bit test when the shape has values
   * that can be frozen. A frozen record takes no write: strict-mode code
   * throws Node's TypeError, as the dynamic write this replaces does, and
   * sloppy-mode code leaves the record unchanged. */
  function recordStore(
    receiver: IrExpr,
    declared: { name: string; type: IrType },
    value: IrExpr,
    loc: SrcLoc,
    sloppy: boolean,
  ): IrStmt {
    const store = (obj: IrExpr, stored: IrExpr): IrStmt => ({
      kind: "recordSet",
      obj,
      shapeId: shape.id,
      field: declared.name,
      value: stored,
      loc,
    });
    if (!shape.freezable) return store(receiver, value);
    const receiverSlot = local("%typedReceiver", receiver.type, loc);
    const valueSlot = local("%typedValue", value.type, loc);
    const receiverRef = varRef(receiverSlot.localId, receiver.type, loc);
    const refused: IrStmt[] = sloppy
      ? []
      : [
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "record.throwFrozen",
              args: [strLit(declared.name, loc), strLit("#<Object>", loc), numLit(0, loc)],
              type: VOID,
              loc,
            },
            loc,
          },
        ];
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: receiverSlot.localId, init: receiver, loc },
        { kind: "varDecl", localId: valueSlot.localId, init: value, loc },
        {
          kind: "if",
          cond: { kind: "libCall", fn: "record.isFrozen", args: [receiverRef], type: BOOL, loc },
          then: refused,
          else_: [store(receiverRef, varRef(valueSlot.localId, value.type, loc))],
          loc,
        },
      ],
      loc,
    };
  }

  /** The static value a dynamic store carries, when the store's argument is
   * a conversion of one. */
  function storedValue(arg: IrExpr): IrExpr | null {
    if (arg.kind === "dynFrom") return arg.value;
    if (arg.kind === "libCall" && STORE_CONVERSIONS.has(arg.fn)) return arg.args[0] ?? null;
    return null;
  }

  /** A call the rewrite leaves dynamic, on a capsule of the typed
   * receiver — the operation exactly as it runs today. */
  function genericCall(call: CallExpr, op: PropertyOp, receiver: IrExpr): IrExpr {
    return {
      ...call,
      args: call.args.map((arg, index) =>
        index === op.receiver ? capsule(receiver, call.loc) : (rewriteExpr(arg, call) as IrExpr),
      ),
    };
  }

  function rewriteStore(call: CallExpr, op: PropertyOp): IrStmt {
    const recv = call.args[op.receiver] as VarRef;
    const receiver = typed(recv);
    const loc = call.loc;
    const sloppy = context.sloppyWrites.has(writeKey(op.loc));
    const fallback = (): IrStmt => ({
      kind: "exprStmt",
      expr: genericCall(call, op, receiver),
      loc,
    });
    const valueArg = op.value === undefined ? undefined : call.args[op.value];
    const stored = valueArg === undefined ? null : storedValue(valueArg);
    if (stored === null || op.key === null) return fallback();
    // The value is rewritten before the arms are chosen: a read of the
    // receiver inside it becomes a typed read, so the arm's field type is
    // the type the store moves.
    const value = rewriteExpr(stored, null);
    const keyArg = typeof op.key === "number" ? call.args[op.key] : undefined;
    const literal =
      typeof op.key === "object" ? op.key.literal : keyArg?.kind === "strLit" ? keyArg.value : null;
    /** Fields a store of `value` can take: the ones whose type it holds. */
    const fits = (declared: { name: string; type: IrType }): boolean =>
      typeKey(declared.type) === typeKey(value.type);
    if (literal !== null) {
      const declared = field(literal);
      if (!declared || !fits(declared)) return fallback();
      rewritten++;
      return recordStore(receiver, declared, value, loc, sloppy);
    }
    if (!keyArg || keyArg.kind !== "varRef" || keyArg.type.kind !== "string") return fallback();
    const arms = shape.fields.filter(fits);
    if (!arms.length) return fallback();
    rewritten += arms.length;
    let chain: IrStmt = fallback();
    for (let index = arms.length - 1; index >= 0; index--) {
      const declared = arms[index]!;
      chain = {
        kind: "if",
        cond: {
          kind: "strEq",
          negated: false,
          left: reparseExpr(keyArg),
          right: strLit(declared.name, loc),
          type: BOOL,
          loc,
        },
        then: [recordStore(receiver, declared, reparseExpr(value), loc, sloppy)],
        else_: [chain],
        loc,
      };
    }
    return chain;
  }

  function rewriteLoad(call: CallExpr, op: PropertyOp, parent: IrExpr | IrStmt | null): IrExpr {
    const recv = call.args[op.receiver] as VarRef;
    const receiver = typed(recv);
    const loc = call.loc;
    const fallback = (): IrExpr => genericCall(call, op, receiver);
    // Only a number read is rewritten: the view the caller reads through is
    // the `js.toF64` conversion around this call.
    const wrapped =
      parent !== null &&
      parent.kind === "libCall" &&
      parent.fn === "js.toF64" &&
      parent.args.length === 1 &&
      parent.args[0] === call;
    if (!wrapped || op.key === null) return fallback();
    const keyArg = typeof op.key === "number" ? call.args[op.key] : undefined;
    const literal =
      typeof op.key === "object" ? op.key.literal : keyArg?.kind === "strLit" ? keyArg.value : null;
    if (literal !== null) {
      const declared = field(literal);
      if (!declared || typeKey(declared.type) !== typeKey(F64)) return fallback();
      rewritten++;
      return recordGet(receiver, declared);
    }
    if (!keyArg || keyArg.kind !== "varRef" || keyArg.type.kind !== "string") return fallback();
    const arms = shape.fields.filter((declared) => typeKey(declared.type) === typeKey(F64));
    if (!arms.length) return fallback();
    rewritten += arms.length;
    let result: IrExpr = {
      kind: "libCall",
      fn: "js.toF64",
      args: [fallback()],
      type: F64,
      loc,
    };
    for (let index = arms.length - 1; index >= 0; index--) {
      const declared = arms[index]!;
      result = {
        kind: "ternary",
        cond: {
          kind: "strEq",
          negated: false,
          left: reparseExpr(keyArg),
          right: strLit(declared.name, loc),
          type: BOOL,
          loc,
        },
        then: recordGet(reparseExpr(receiver), declared),
        else_: result,
        type: F64,
        loc,
      };
    }
    return result;
  }

  /** The receiver as the operand of a local that keeps the type it copies:
   * a typed local takes the typed receiver, a dynamic one a capsule. */
  function copyInto(ref: VarRef, target: IrType): IrExpr {
    const value = typed(ref);
    if (typeKey(target) === typeKey(value.type)) return value;
    if (target.kind === "dyn") return capsule(value, ref.loc);
    return reject();
  }

  /** The declared type of a local of the origin or of the clone's extras.
   * A local that holds the parameter carries the caller's type in the
   * clone, whether it is the parameter or a copy of it. */
  function localType(id: string): IrType | null {
    if (members!.has(id)) return type;
    const extra = extras.find((candidate) => candidate.id === id);
    if (extra !== undefined) return extra.type;
    return origin.locals.find((candidate) => candidate.id === id)?.type ?? null;
  }

  function memberUse(ref: VarRef, parent: IrExpr | IrStmt | null): IrExpr {
    if (parent === null) reject();
    const value = typed(ref);
    if (parent.kind === "varDecl" && parent.init === ref) {
      const target = localType(parent.localId);
      return target === null ? reject() : copyInto(ref, target);
    }
    if (parent.kind === "assign" && parent.value === ref) {
      const target = localType(parent.localId);
      return target === null ? reject() : copyInto(ref, target);
    }
    if (parent.kind === "libCall" && PROPERTY_OBSERVERS.has(parent.fn) && parent.args[0] === ref)
      return capsule(value, ref.loc);
    if (parent.kind === "dynTest" && parent.value === ref) return capsule(value, ref.loc);
    if (parent.kind === "toBool" && parent.operand === ref) return capsule(value, ref.loc);
    if (parent.kind === "dynKeyGet" && parent.value === ref) return capsule(value, ref.loc);
    return reject();
  }

  function rewriteExpr(expr: IrExpr, parent: IrExpr | IrStmt | null): IrExpr {
    if (expr.kind === "varRef" && members!.has(expr.localId))
      return memberUse(expr as VarRef, parent);
    if (expr.kind === "libCall" && expr.fn === "js.toF64" && expr.args.length === 1) {
      // A number read the rewrite turned into a typed field read is f64
      // already: the conversion that wrapped the dynamic read is elided.
      const inner = rewriteExpr(expr.args[0]!, expr);
      if (inner === expr.args[0]) return expr;
      return inner.type.kind === "f64" ? inner : { ...expr, args: [inner] };
    }
    if (expr.kind === "call") {
      const op = context.helpers.get(expr.callee);
      const recv = op ? expr.args[op.receiver] : undefined;
      if (op && recv?.kind === "varRef" && members!.has(recv.localId) && op.kind !== "set")
        return rewriteLoad(expr, op, parent);
    }
    const next = mapExprChildren(
      expr,
      (child) => rewriteExpr(child, expr),
      (statement) => rewriteStmt(statement),
    );
    return next === expr ? reparseExpr(expr) : next;
  }

  /** The expression a sequence's hoisted local was initialised with, put in
   * place of every reference to that local. */
  function substitute(expr: IrExpr, hoists: ReadonlyMap<string, IrExpr>): IrExpr {
    if (expr.kind === "varRef") {
      const init = hoists.get(expr.localId);
      if (init !== undefined) return reparseExpr(init);
    }
    return mapExprChildren(
      expr,
      (child) => substitute(child, hoists),
      (statement) => statement,
    );
  }

  /** A keyed write lowered as a sequence of hoisted operands followed by the
   * dynamic set call, rewritten with those operands put back in place. */
  function storeStatement(statement: IrStmt): IrStmt | null {
    if (statement.kind !== "exprStmt" || statement.expr.kind !== "seqExpr") return null;
    const sequence = statement.expr;
    if (sequence.generatorDelegate !== undefined || sequence.diverges !== undefined) return null;
    const last = sequence.stmts[sequence.stmts.length - 1];
    if (!last || last.kind !== "exprStmt" || last.expr.kind !== "call") return null;
    const call = last.expr;
    const op = context.helpers.get(call.callee);
    if (!op || op.kind !== "set") return null;
    const hoists = new Map<string, IrExpr>();
    for (const hoisted of sequence.stmts.slice(0, -1))
      if (hoisted.kind === "varDecl" && hoisted.init !== null)
        hoists.set(hoisted.localId, hoisted.init);
    const resolved: CallExpr = {
      ...call,
      args: call.args.map((arg) => substitute(arg, hoists)),
    };
    const recv = resolved.args[op.receiver];
    if (!recv || recv.kind !== "varRef" || !members!.has(recv.localId)) return null;
    return rewriteStore(resolved, op);
  }

  function rewriteStmt(statement: IrStmt): IrStmt {
    const store = storeStatement(statement);
    if (store !== null) return store;
    if (statement.kind === "exprStmt" && statement.expr.kind === "call") {
      const op = context.helpers.get(statement.expr.callee);
      const recv = op ? statement.expr.args[op.receiver] : undefined;
      if (op?.kind === "set" && recv?.kind === "varRef" && members!.has(recv.localId))
        return rewriteStore(statement.expr, op);
    }
    const next = mapStmtChildren(
      statement,
      (child) => rewriteExpr(child, statement),
      (child) => rewriteStmt(child),
    );
    return next === statement ? reparseStmt(statement) : next;
  }

  let body: IrStmt[];
  try {
    body = origin.body.map((statement) => rewriteStmt(statement));
  } catch (error) {
    if (error === NOT_A_CLONE) return null;
    throw error;
  }
  if (!rewritten || !body.length) return null;
  const { ownsPrototype: _ownsPrototype, ...implementation } = origin;
  return {
    ...implementation,
    name: "",
    params: origin.params.map((candidate, index) =>
      index === paramIndex ? { ...candidate, type } : candidate,
    ),
    locals: [
      ...origin.locals.map((candidate) =>
        members.has(candidate.id) ? { ...candidate, type } : candidate,
      ),
      ...extras,
    ],
    body,
  };
}

/** Direct calls that pass a statically typed record to an `unknown`
 * parameter call a clone of the callee in which the parameter carries the
 * caller's type while its body uses the parameter only through property
 * operations.
 *
 * A callee qualifies when the parameter and every local that copies it (a
 * cast to `any` or to a record view lowers to a copy) is used only as the
 * receiver of dynamic property reads and writes, an `in` operand, a
 * `typeof` operand or a truthiness test — never stored, returned, compared,
 * passed on, captured, spread or enumerated — and the callee is an ordinary
 * function of at most MAX_FUNCTION_NODES nodes with no captures.
 *
 * Inside the clone the receiver is the caller's record type: a read or write
 * whose key the clone knows compiles to a typed field access, and a keyed
 * operation compares the key against the shape's declared field names and
 * takes the typed field arm when one matches, updating the value type it was
 * given. Every other key, and every operation on a shape that has no such
 * field, takes the operation exactly as it runs today, on a capsule built at
 * that point. A write to a shape whose values can be frozen tests the frozen
 * bit first: a frozen record takes the TypeError the dynamic operation
 * throws in strict-mode code, and is left unchanged in sloppy-mode code.
 * Calls that do not qualify keep the original function.
 *
 * Code growth is bounded: at most MAX_CLONES_PER_FUNCTION clones per
 * function and MIN_CLONED_NODES (or CLONED_NODE_FRACTION of the module) of
 * cloned nodes module-wide. `symbolName` spells names after mangling, and
 * `index`, an index of `mod`, gives node counts without walking bodies. */
export function specializeTypedArguments(
  mod: IrModule,
  symbolName: (name: string) => string = (name) => name,
  index?: IrNodeIndex,
): IrModule {
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const context: RewriteContext = {
    helpers: helperOperations(mod),
    records: new Map((mod.records ?? []).map((shape) => [shape.id, shape])),
    sloppyWrites: new Set(mod.sloppyDynWrites ?? []),
  };
  if (!context.helpers.size || !context.records.size) return mod;
  let moduleNodes = 0;
  for (const fn of mod.functions) moduleNodes += countNodes(fn, index);
  let budget = Math.max(MIN_CLONED_NODES, moduleNodes * CLONED_NODE_FRACTION);
  const names = new Set(mod.functions.map((fn) => symbolName(fn.name)));
  const partialTargets = partialAssertionTargets(mod);
  const cloneCounts = new Map<string, number>();
  const clones = new Map<string, IrFunction | null>();
  const pending: IrFunction[] = [];

  /** The static record value an argument passes, or null. */
  function staticArgument(arg: IrExpr): IrExpr | null {
    const value = arg.kind === "dynFrom" ? arg.value : arg;
    if (value.type.kind !== "record") return null;
    const shape = context.records.get(value.type.shapeId);
    if (!shape || shape.tuple) return null;
    // A shape a partial record assertion names may hold a value its own
    // fields are absent from; the clone would read one natively.
    if (partialTargets.has(value.type.shapeId)) return null;
    return value;
  }

  function cloneFor(target: IrFunction, paramIndex: number, type: RecordType): IrFunction | null {
    const key = `${target.name}\0${paramIndex}\0${typeKey(type)}`;
    const known = clones.get(key);
    if (known !== undefined) return known;
    let clone: IrFunction | null = null;
    const count = cloneCounts.get(target.name) ?? 0;
    if (
      count < MAX_CLONES_PER_FUNCTION &&
      target !== functions.get(mod.entry) &&
      !target.async &&
      target.generator === undefined &&
      target.captures === undefined &&
      !target.classCaptures?.length &&
      !target.fastRead &&
      !target.speculativeDispatch
    ) {
      const candidate = buildClone(context, target, paramIndex, type);
      if (candidate) {
        const size = countNodes(candidate);
        if (size <= budget) {
          budget -= size;
          let name = `${target.name}.typedArg`;
          while (names.has(symbolName(name))) name += "_";
          names.add(symbolName(name));
          clone = { ...candidate, name };
          cloneCounts.set(target.name, count + 1);
          pending.push(clone);
        }
      }
    }
    clones.set(key, clone);
    return clone;
  }

  /** Rewrites one call: its first qualifying argument passes a qualified
   * clone, and the argument becomes the record itself. */
  function specializeCall(call: CallExpr): CallExpr {
    const target = functions.get(call.callee);
    if (!target) return call;
    for (let paramIndex = 0; paramIndex < target.params.length; paramIndex++) {
      const param = target.params[paramIndex]!;
      if (param.type.kind !== "dyn" || param.owned) continue;
      const arg = call.args[paramIndex];
      if (!arg) continue;
      const value = staticArgument(arg);
      if (!value) continue;
      const clone = cloneFor(target, paramIndex, value.type as RecordType);
      if (!clone) continue;
      return {
        ...call,
        callee: clone.name,
        args: call.args.map((candidate, index) => (index === paramIndex ? value : candidate)),
      };
    }
    return call;
  }

  function qualifies(call: CallExpr): boolean {
    const target = functions.get(call.callee);
    if (!target) return false;
    return target.params.some((param, paramIndex) => {
      if (param.type.kind !== "dyn" || param.owned) return false;
      const arg = call.args[paramIndex];
      return arg !== undefined && staticArgument(arg) !== null;
    });
  }

  function rewriteFunction(fn: IrFunction): IrFunction {
    let found = false;
    const candidates: CallExpr[] = [];
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind === "call" && qualifies(expr)) {
          found = true;
          candidates.push(expr);
        }
        return true;
      },
    });
    if (!found) return fn;
    const byNode = new Map<IrExpr, CallExpr>();
    for (const call of candidates) {
      const rewritten = specializeCall(call);
      if (rewritten !== call) byNode.set(call, rewritten);
    }
    let mutated = false;
    const body = transformStmtList(fn.body, {
      expr: (expr) => {
        const replacement = byNode.get(expr);
        if (replacement) mutated = true;
        return replacement ?? expr;
      },
      stmt: (statement) => statement,
    });
    return mutated ? { ...fn, body } : fn;
  }

  const rewritten = mod.functions.map(rewriteFunction);
  const additions: IrFunction[] = [];
  for (let position = 0; position < pending.length; position++)
    additions.push(rewriteFunction(pending[position]!));
  if (!additions.length) return mod;
  return { ...mod, functions: [...rewritten, ...additions] };
}
