import {
  isRefCounted,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyExpr, everyStmt, everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { ReferenceEffects } from "./reference-effects.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import {
  emitCompactMapSlot,
  emitNumberMapGetRef,
  emitNumberMapGetScalar,
  emitNumberMapSlot,
  emitStringMapEntry,
  emitStringMapGetScalar,
  emitStringMapGetRef,
  compactMapValues,
  noteNumberMapKey,
} from "./map-number-lookup.js";
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { mapKeyAccess, mapKeyParamType } from "./shapes.js";
import { rememberMapEntry } from "./map-entry-fusion.js";

function hasTypedCollectionReceiver(
  expr: IrExpr,
): expr is Extract<IrExpr, { kind: "mapIntrinsic" | "setIntrinsic" }> {
  if (expr.kind !== "mapIntrinsic" && expr.kind !== "setIntrinsic") return false;
  const receiver = expr.receiver.type;
  if (receiver.kind === "map") {
    if (receiver.key.kind === "dyn" || receiver.value.kind === "dyn") return false;
  } else if (receiver.kind === "set") {
    if (receiver.elem.kind === "dyn") return false;
  } else return false;
  return true;
}

/** Typed reads neither invoke callbacks nor consume their inputs. Reference
 * results carry their own owner. Generic views keep the adapter path. */
export function borrowsMapReadInputs(expr: IrExpr): boolean {
  if (!hasTypedCollectionReceiver(expr)) return false;
  switch (expr.method) {
    case "get":
    case "has":
    case "size":
    case "iterCount":
    case "iterStart":
    case "iterLive":
    case "iterKey":
    case "iterValue":
      return true;
    default:
      return false;
  }
}

/** Native typed mutations borrow their receiver and invoke no user code.
 * Stored arguments still acquire ownership, and the mutation itself must
 * never be classified as preserving the collection's reference edges. */
export function borrowsMapMutationReceiver(expr: IrExpr): boolean {
  if (!hasTypedCollectionReceiver(expr)) return false;
  return (
    expr.method === "set" ||
    expr.method === "add" ||
    expr.method === "delete" ||
    expr.method === "clear"
  );
}

export interface LocalMapRead {
  /** The Map.get expression itself. */
  expr: IrExpr;
  /** A local's reference result may stay the entry's own reference: every
   * use of the local runs before anything that can change a reference
   * edge (findMapReadBorrows), so the entry still holds the value. */
  borrowed?: boolean;
  type: IrType;
  receiver: IrExpr;
  key: IrExpr;
  value: IrType;
  presentTag: number;
  missingTag: number;
}

export function matchMapRead(
  expr: IrExpr,
  unions: ReadonlyMap<string, IrUnionDef>,
): LocalMapRead | null {
  if (
    expr.kind !== "mapIntrinsic" ||
    expr.method !== "get" ||
    expr.args.length !== 1 ||
    expr.receiver.type.kind !== "map" ||
    expr.type.kind !== "union" ||
    !borrowsMapReadInputs(expr)
  )
    return null;
  const value = expr.receiver.type.value;
  // An already-boxed union is the stored value itself. Its identity and
  // ownership stay on the existing path instead of constructing a new box.
  if (
    value.kind === "union" ||
    (!isRefCounted(value) && value.kind !== "f64" && value.kind !== "bool")
  )
    return null;
  const arms = unions.get(expr.type.unionId)?.arms;
  if (!arms || arms.length !== 2) return null;
  const presentTag = arms.findIndex((arm) => typeEquals(arm, value));
  const missingTag = arms.findIndex((arm) => arm.kind === "undefinedT");
  if (presentTag < 0 || missingTag < 0) return null;
  return {
    expr,
    type: expr.type,
    receiver: expr.receiver,
    key: expr.args[0]!,
    value,
    presentTag,
    missingTag,
  };
}

export interface MapReadLifetimes {
  locals: Map<string, LocalMapRead>;
  arguments: Map<IrExpr, LocalMapRead>;
}

/** Reuse the box-use proof for both lexical locals and direct arguments.
 * Each read owns an independent payload snapshot: changing or clearing the
 * map later cannot invalidate an earlier result. No map purity assumption
 * is needed, including for reference-valued entries. */
export function findMapReadLifetimes(
  fn: IrFunction,
  unions: ReadonlyMap<string, IrUnionDef>,
  lifetimes: CallLifetimes,
  effects?: ReferenceEffects,
): MapReadLifetimes {
  const result: MapReadLifetimes = { locals: new Map(), arguments: new Map() };
  if (fn.async || fn.generator) return result;
  const locals = lifetimes.locals.get(fn.name);
  everyStmtList(fn.body, {
    stmt: (stmt) => {
      if (stmt.kind === "varDecl" && stmt.init && locals?.has(stmt.localId)) {
        const read = matchMapRead(stmt.init, unions);
        if (read) result.locals.set(stmt.localId, read);
      }
      return true;
    },
    expr: (expr) => {
      if (expr.kind !== "call") return true;
      const parameters = lifetimes.parameters.get(expr.callee);
      if (parameters)
        expr.args.forEach((arg, index) => {
          if (!parameters.has(index)) return;
          const read = matchMapRead(arg, unions);
          if (read) result.arguments.set(arg, read);
        });
      return true;
    },
  });
  if (effects) {
    const borrowed = findMapReadBorrows(fn, effects, (decl) => {
      const read = result.locals.get(decl.localId);
      return read !== undefined && isRefCounted(read.value);
    });
    for (const id of borrowed) result.locals.get(id)!.borrowed = true;
  }
  return result;
}

/** Whether a map read's receiver keeps the map past its own statement: a
 * local or a field of one. Changing either is an edge change the borrow
 * proof sees. A temporary map (a call's result, `new Map()`) is released at
 * the end of the declaration, and its entries with it. */
function heldReceiver(expr: IrExpr): boolean {
  if (expr.kind === "varRef") return true;
  if (expr.kind === "fieldGet" || expr.kind === "recordGet") return heldReceiver(expr.obj);
  if (expr.kind === "unionNarrow" || expr.kind === "downcast") return heldReceiver(expr.value);
  return false;
}

/** The locals, declared by statements `candidate` accepts, that can hold a
 * map entry's own reference instead of a +1 copy. The statements after the
 * declaration run in order, and every one that names the local must
 * preserve reference edges (ReferenceEffects) and run before any statement
 * that may not, so no write, deletion or unknown call can release the value
 * while the local is read. An `if` passes its condition's state to both
 * branches and joins them; any other statement that names the local is
 * judged whole. A later pass of an enclosing loop declares the local again,
 * so only the rest of its own statement list matters. The map must be held
 * by a local or a field (heldReceiver), the read itself must preserve
 * reference edges (a key whose evaluation replaces the receiver's field
 * leaves the read on a map the statement releases), and locals declared
 * from the local count as its uses. An update such as
 * `const c = m.get(k); if (c === undefined) m.set(k, v); else c.n++` keeps
 * the borrow: the write runs only on the branch that does not read `c`. */
export function findMapReadBorrows(
  fn: IrFunction,
  effects: ReferenceEffects,
  candidate: (decl: IrStmt & { kind: "varDecl" }) => boolean,
): Set<string> {
  const result = new Set<string>();
  if (fn.async || fn.generator) return result;
  // `ids` holds the local and the locals declared from it: a stable alias
  // (`const d = c`) reads the same entry without a reference of its own.
  const names = (node: IrStmt | IrExpr, ids: ReadonlySet<string>, isStmt: boolean): boolean => {
    let found = false;
    const visitor = {
      stmt: () => !found,
      expr: (expr: IrExpr) => {
        if (expr.kind === "varRef" && ids.has(expr.localId)) found = true;
        return !found;
      },
    };
    if (isStmt) everyStmt(node as IrStmt, visitor);
    else everyExpr(node as IrExpr, visitor);
    return found;
  };
  // Adds the reference locals that `stmt` declares from one in `ids`, at any
  // depth: a `var` inside a loop or a try stays in scope after it.
  const alias = (stmt: IrStmt, ids: Set<string>): void => {
    everyStmt(stmt, {
      stmt: (node) => {
        if (
          node.kind === "varDecl" &&
          node.init !== null &&
          isRefCounted(node.init.type) &&
          names(node.init, ids, false)
        )
          ids.add(node.localId);
        return true;
      },
      expr: () => true,
    });
  };
  // Whether an edge may have changed after `list`, or null when a statement
  // names the local after such a change (or changes edges itself).
  const walk = (list: readonly IrStmt[], ids: Set<string>, changed: boolean): boolean | null => {
    for (const stmt of list) {
      if (stmt.kind === "if") {
        const preserving = effects.preserves(stmt.cond);
        if (names(stmt.cond, ids, false) && (changed || !preserving)) return null;
        const condition = changed || !preserving;
        const then = walk(stmt.then, ids, condition);
        const otherwise = stmt.else_ === null ? condition : walk(stmt.else_, ids, condition);
        if (then === null || otherwise === null) return null;
        changed = then || otherwise;
        continue;
      }
      if (stmt.kind === "block") {
        const inner = walk(stmt.body, ids, changed);
        if (inner === null) return null;
        changed = inner;
        continue;
      }
      const preserving = effects.preservesScope([stmt]);
      if (names(stmt, ids, true)) {
        if (changed || !preserving) return null;
        alias(stmt, ids);
      }
      changed ||= !preserving;
    }
    return changed;
  };
  const visit = (list: readonly IrStmt[]): void => {
    list.forEach((stmt, index) => {
      if (
        stmt.kind === "varDecl" &&
        stmt.init?.kind === "mapIntrinsic" &&
        heldReceiver(stmt.init.receiver) &&
        effects.preserves(stmt.init) &&
        candidate(stmt) &&
        walk(list.slice(index + 1), new Set([stmt.localId]), false) !== null
      )
        result.add(stmt.localId);
      for (const nested of nestedStmtLists(stmt)) visit(nested);
    });
  };
  visit(fn.body);
  return result;
}

/** The operand's expression tree without source locations: equal strings
 * name equal expressions. A match only selects the lookup form; both forms
 * are correct for any operands. */
function operandKey(expr: IrExpr): string {
  return JSON.stringify(expr, (name, value: unknown) =>
    name === "loc" ? undefined : Object.is(value, -0) ? "-0" : value,
  );
}

/** The receiver|key pair of a typed number-key collection call. */
function numberKeyPair(expr: IrExpr): string | null {
  if (!hasTypedCollectionReceiver(expr) || expr.args.length === 0) return null;
  const receiver = expr.receiver.type;
  const key =
    receiver.kind === "map" ? receiver.key : receiver.kind === "set" ? receiver.elem : null;
  if (key?.kind !== "f64") return null;
  return `${operandKey(expr.receiver)}|${operandKey(expr.args[0]!)}`;
}

/** The receiver|key pairs that get and has read anywhere in `node`. */
function numberKeyReads(node: IrStmt | IrExpr, isStmt: boolean): Set<string> {
  const reads = new Set<string>();
  const visitor = {
    stmt: () => true,
    expr: (expr: IrExpr) => {
      if (
        (expr.kind === "mapIntrinsic" || expr.kind === "setIntrinsic") &&
        (expr.method === "get" || expr.method === "has")
      ) {
        const pair = numberKeyPair(expr);
        if (pair !== null) reads.add(pair);
      }
      return true;
    },
  };
  if (isStmt) everyStmt(node as IrStmt, visitor);
  else everyExpr(node as IrExpr, visitor);
  return reads;
}

function nestedStmtLists(stmt: IrStmt): IrStmt[][] {
  switch (stmt.kind) {
    case "if":
      return stmt.else_ === null ? [stmt.then] : [stmt.then, stmt.else_];
    case "while":
    case "doWhile":
    case "forOf":
    case "block":
      return [stmt.body];
    case "for":
      return [stmt.body];
    case "switch":
      return stmt.cases.map((c) => c.body);
    case "tryCatch":
      return [stmt.tryBody, stmt.catchBody ?? [], stmt.finallyBody ?? []];
    default:
      return [];
  }
}

/** Number-key Map.set and Set.add statements that follow a get or has of
 * the same collection and key: inside their own arguments (`m.set(k,
 * (m.get(k) ?? 0) + 1)`) or in the statement just before them. Such a
 * write usually finds its key, so it looks the key up inline
 * (emitNumberMapSetScalar) and stores into the found entry; the lookup is
 * read-only, so LLVM merges it with the read's when no store intervenes.
 * Other writes, including those guarded by an absent key, keep the single
 * runtime call, which finds the insertion bucket in the same probe. */
export function findReadNumberMapWrites(fn: IrFunction): Set<IrExpr> {
  const writes = new Set<IrExpr>();
  const visitList = (list: IrStmt[]): void => {
    list.forEach((stmt, index) => {
      for (const nested of nestedStmtLists(stmt)) visitList(nested);
      if (stmt.kind !== "exprStmt") return;
      const write = stmt.expr;
      if (
        (write.kind !== "mapIntrinsic" || write.method !== "set") &&
        (write.kind !== "setIntrinsic" || write.method !== "add")
      )
        return;
      const pair = numberKeyPair(write);
      if (pair === null) return;
      const before = index > 0 ? list[index - 1]! : null;
      if (
        write.args.some((arg) => numberKeyReads(arg, false).has(pair)) ||
        (before !== null && numberKeyReads(before, true).has(pair))
      )
        writes.add(write);
    });
  };
  visitList(fn.body);
  return writes;
}

export function emitMapLookupKey(
  host: LlvmEmitterContext,
  key: IrExpr,
  borrow: boolean,
): { access: string; types: string; args: string; value?: string } {
  const span =
    borrow && key.kind === "varRef" && key.type.kind === "string"
      ? host.splitSpans.get(key.localId)
      : undefined;
  if (span)
    return {
      access: "span",
      types: `ptr, ${host.sizeType}`,
      args: `ptr ${span.bytes}, ${host.sizeType} ${span.length}`,
    };
  const value = borrow ? host.emitReadReceiver(key) : host.emitExpr(key);
  const access = mapKeyAccess(key.type);
  const type = mapKeyParamType(access);
  if (access === "f64") noteNumberMapKey(host, value, key);
  return { access, types: type, args: `${type} ${value.name}`, value: value.name };
}

/** The key's double operand when the lookup can take the inline number path. */
export function inlineNumberKey(key: { access: string; value?: string }): string | null {
  return key.access === "f64" && key.value !== undefined ? key.value : null;
}

/** The key's string operand when a reference read can take the entry path. */
export function entryStringKey(key: { access: string; value?: string }): string | null {
  return key.access === "str" && key.value !== undefined ? key.value : null;
}

export interface StackMapRead {
  value: LlValue;
  owner: { slot: string; type: IrType } | null;
}

/** Preserve Map.get's ordinary lookup and tag ABI, with the temporary box
 * on the stack. The reference getter supplies +1 directly to the payload
 * slot; its lexical or call frame releases that slot on every exit. Scalar
 * results have no owner. A missing reference initializes the owner to null. */
export function emitStackMapRead(host: LlvmEmitterContext, read: LocalMapRead): StackMapRead {
  const B = host.B;
  const receiver = host.emitStableReceiver(read.receiver, [read.key]);
  const key = emitMapLookupKey(host, read.key, true);
  const access = key.access;
  const keyType = key.types;
  const box = B.slot(),
    payload = B.slot(),
    tag = B.slot();
  B.entryAllocas.push(`${box} = alloca %ScrUnion`);
  B.entryAllocas.push(`${payload} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`);
  B.entryAllocas.push(`${tag} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 1`);
  let found = B.tmp();
  let owner: StackMapRead["owner"] = null;
  const number = inlineNumberKey(key);
  const string = entryStringKey(key);
  const borrow = read.borrowed === true;
  if (number !== null) {
    if (isRefCounted(read.value)) {
      const raw = emitNumberMapGetRef(host, receiver.name, number, read.value, borrow);
      B.line(`${found} = icmp ne ptr ${raw}, null`);
      B.line(`store i64 0, ptr ${payload}`);
      B.line(`store ptr ${raw}, ptr ${payload}`);
      if (!borrow) owner = { slot: payload, type: read.value };
    } else {
      // Booleans are stored as 0/1, already the widened union payload.
      const scalar = emitNumberMapGetScalar(host, receiver.name, number);
      found = scalar.found;
      rememberMapEntry(host, read.expr, receiver.name, number, scalar.entry, "double");
      B.line(`store i64 ${scalar.bits}, ptr ${payload}`);
    }
  } else if (string !== null && !isRefCounted(read.value)) {
    const scalar = emitStringMapGetScalar(host, receiver.name, string);
    found = scalar.found;
    rememberMapEntry(host, read.expr, receiver.name, string, scalar.entry);
    B.line(`store i64 ${scalar.bits}, ptr ${payload}`);
  } else if (isRefCounted(read.value)) {
    const stringKey = entryStringKey(key);
    let raw: string;
    const mapType = read.receiver.type;
    const compact = mapType.kind === "map" && compactMapValues(host, mapType.key, mapType.value);
    // The runtime's other key kinds return +1, which the frame then owns.
    const borrowed = borrow && stringKey !== null;
    if (stringKey !== null)
      raw = emitStringMapGetRef(host, receiver.name, stringKey, read.value, compact, borrowed);
    else {
      raw = B.tmp();
      host.declare(`declare ptr @scr_map_get_${access}_ref(ptr, ${keyType})`);
      B.line(`${raw} = call ptr @scr_map_get_${access}_ref(ptr ${receiver.name}, ${key.args})`);
    }
    B.line(`${found} = icmp ne ptr ${raw}, null`);
    B.line(`store i64 0, ptr ${payload}`);
    B.line(`store ptr ${raw}, ptr ${payload}`);
    if (!borrowed) owner = { slot: payload, type: read.value };
  } else {
    const scalar = read.value.kind === "f64" ? "f64" : "bool";
    B.line(`store i64 0, ptr ${payload}`);
    host.declare(`declare zeroext i1 @scr_map_get_${access}_${scalar}(ptr, ${keyType}, ptr)`);
    B.line(
      `${found} = call zeroext i1 @scr_map_get_${access}_${scalar}(ptr ${receiver.name}, ${key.args}, ptr ${payload})`,
    );
    if (read.value.kind === "bool") {
      // The runtime writes a byte; union projections read an i64. Widen
      // explicitly rather than depending on the target's byte order.
      const byte = B.tmp(),
        bits = B.tmp();
      B.line(`${byte} = load i8, ptr ${payload}`);
      B.line(`${bits} = zext i8 ${byte} to i64`);
      B.line(`store i64 ${bits}, ptr ${payload}`);
    }
  }
  const selected = B.tmp();
  B.line(`${selected} = select i1 ${found}, i32 ${read.presentTag}, i32 ${read.missingTag}`);
  B.line(`store i32 ${selected}, ptr ${tag}`);
  return { value: { name: box, type: read.type }, owner };
}

/** A string-keyed Map.get whose result is a nullable-pointer union over the
 * map's own value type (`Map<string, F>` read as `F | undefined`): a hit is
 * the stored pointer itself and a miss the immortal undefined encoding, so
 * the read can lend the stored value (emitBorrowedMapGet). */
export function pointerMapGet(host: LlvmEmitterContext, e: IrExpr): boolean {
  if (
    e.kind !== "mapIntrinsic" ||
    e.method !== "get" ||
    e.args.length !== 1 ||
    e.type.kind !== "union" ||
    e.receiver.type.kind !== "map" ||
    e.receiver.type.key.kind !== "string" ||
    !borrowsMapReadInputs(e)
  )
    return false;
  const nullable = host.nullableUnions.single(e.type.unionId);
  return (
    nullable !== null &&
    typeEquals(nullable.arm, e.receiver.type.value) &&
    undefinedArmTag(e.type, host.unionsById) >= 0
  );
}

/** A pointerMapGet read without a reference: the map (and through it the
 * stored value) must stay unchanged and alive until the consumer is done
 * with the pointer (canBorrowReceiver). */
export function emitBorrowedMapGet(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "mapIntrinsic" },
): LlValue {
  const B = host.B;
  const mapType = e.receiver.type;
  if (e.type.kind !== "union" || mapType.kind !== "map")
    throw new InternalCompilerError("llvm emitter bug: borrowed Map.get shape");
  const receiver = host.emitReadReceiver(e.receiver);
  const keyExpr = e.args[0]!;
  const key = host.canBorrowReceiver(keyExpr)
    ? host.emitReadReceiver(keyExpr)
    : host.emitExpr(keyExpr);
  const compact = compactMapValues(host, mapType.key, mapType.value);
  const entry = emitStringMapEntry(host, receiver.name, key.name, compact);
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapb.hit"),
    miss = B.newLabel("mapb.miss"),
    join = B.newLabel("mapb.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const value = compact ? emitCompactMapSlot(host, entry) : emitNumberMapSlot(host, entry, "ptr");
  B.br(join);
  B.startBlock(miss);
  B.br(join);
  B.startBlock(join);
  const absent = host.unitInstanceRef(e.type.unionId, undefinedArmTag(e.type, host.unionsById));
  const result = B.tmp();
  B.line(`${result} = phi ptr [ ${value}, %${hit} ], [ ${absent}, %${miss} ]`);
  return { name: result, type: e.type };
}
