import {
  isRefCounted,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { borrowsStringInputs } from "./string-lifetimes.js";
import { borrowsMapReadInputs } from "./map-read-lifetimes.js";
import { LazyCaptures } from "./lazy-captures.js";
import { BodyLastUses, storedLastUseRead } from "./local-extents.js";
import { InternalCompilerError } from "../../errors.js";

interface ForwardedUse {
  callee: string;
  index: number;
  /** The binding reached the call inside a nullable-pointer union
   * (PointerWrapTest): the callee's parameter holds the binding itself as
   * its payload, so the callee must keep the payload, not only the union,
   * in place. */
  wrapped: boolean;
}

interface Uses {
  invalid: Set<string>;
  written: Set<string>;
  declarations: Map<string, number>;
  forwards: Map<string, ForwardedUse[]>;
  /** Union bindings whose payload a use may keep: a narrowed read that is
   * not projected or passed on, a narrowed nullish read, a store into a
   * nullable-pointer field. The union itself can still be only projected. */
  payloadKept: Set<string>;
  /** Narrowed payloads of union bindings passed directly as call arguments:
   * the payload stays in place if the callee's parameter is proved. */
  payloadForwards: Map<string, ForwardedUse[]>;
  /** Union bindings whose whole value initializes or is assigned to
   * another union local (`const x = y`, `x = y` as a statement), with the
   * locals it is copied to. */
  copies: Map<string, string[]>;
}

interface Parameter {
  safe: boolean;
  callers: Set<Parameter>;
}

export interface CallLifetimes {
  /** Unchanged heap bindings can borrow the caller's owner. Copies that
   * escape through returns, stores or other calls still acquire ownership.
   * This does not permit passing a stack box to the parameter. */
  borrowed: Map<string, Set<number>>;
  /** Locals initialized once and never assigned or captured. A source let
   * binding may be stable too; source mutability alone is not a write. */
  bindings: Map<string, Set<string>>;
  /** Parameters consumed only by projections, borrowing string operations,
   * callable invocation, or other proven parameters.
   * This is a lifetime fact, not a purity or nonthrowing guarantee. */
  parameters: Map<string, Set<number>>;
  /** Stable locals with the same use restriction. Their initialization
   * and ownership still need a separate representation proof. */
  locals: Map<string, Set<string>>;
  /** Projection-only local uses, allowing statement assignments. Each
   * initializer and assignment still needs a separate storage proof. */
  projectedLocals: Map<string, Set<string>>;
  /** Locals that projectedLocals leaves out only because their whole value
   * is copied to other union locals, with those locals. Such a local is
   * only projected when every local it is copied to snapshots the copy
   * (local-union-storage.ts) instead of keeping the box. */
  copiedLocals: Map<string, Map<string, readonly string[]>>;
  /** Generator bodies own their parameters for the whole body, including
   * every suspension: the frame releases them only on its final exit. A
   * reference parameter nothing rebinds, declares or captures is therefore
   * a stable owner that reads may borrow, as a borrowed parameter is in a
   * synchronous body. These parameters keep their owned convention. */
  generatorParameters: Map<string, Set<string>>;
}

function eligible(local: IrLocal): boolean {
  // Source parameters are writable bindings even when the body never
  // assigns them. Actual writes are rejected by collectUses below.
  return (
    !local.boxed &&
    !local.tdz &&
    (local.type.kind === "union" ||
      local.type.kind === "object" ||
      local.type.kind === "record" ||
      local.type.kind === "string" ||
      local.type.kind === "func")
  );
}

/** Read each function once. A whole-value use is unsafe unless it is an
 * explicitly supported projection, invocation, borrowing string operation, or direct-call
 * argument whose target parameter can be proved separately. Traversal of every other consumer
 * reaches the ordinary varRef rejection, including future IR nodes.
 *
 * Projection results may escape: the existing emitter retains extracted
 * payloads. The enclosing union box itself must never be retained, released,
 * stored, returned, captured, or passed to arbitrary runtime code. */
/** True for class fields stored as nullable instance pointers: a store
 * extracts and retains the payload, so the stored union is only projected. */
export type NullableFieldTest = (className: string, field: string) => boolean;

function scalarValue(value: IrExpr): boolean {
  return value.type.kind === "f64" || value.type.kind === "bool";
}

/** Record and class fields that store a scalar union's tag and bits inline
 * (inline-unions.ts): a store copies the bits, so the stored union is only
 * projected, and like a number it leaves the object where it is. */
export interface InlineFieldTest {
  record(shapeId: string, field: string): boolean;
  classField(className: string, field: string): boolean;
}

const NO_INLINE_FIELDS: InlineFieldTest = { record: () => false, classField: () => false };

/** Record shapes whose to-dyn conversion copies the fields into a fresh
 * checked-dynamic value (dyn.ts recordDynKeepsIdentity): the conversion
 * reads the record and keeps no reference to it. */
export type RecordDynCopyTest = (shapeId: string) => boolean;

/** Wraps into a nullable-pointer union whose value is the payload pointer
 * itself (LlEmitter.borrowableNullableWrap): the wrapped binding reaches the
 * callee's parameter unchanged. */
export type PointerWrapTest = (wrap: IrExpr & { kind: "unionWrap" }) => boolean;

function collectUses(
  fn: IrFunction,
  nullableField: NullableFieldTest,
  registerReturn: boolean,
  inlineField: InlineFieldTest,
  recordDynCopy: RecordDynCopyTest,
  pointerWrap: PointerWrapTest,
): Uses {
  const uses: Uses = {
    invalid: new Set(),
    written: new Set(),
    declarations: new Map(),
    forwards: new Map(),
    payloadKept: new Set(),
    payloadForwards: new Map(),
    copies: new Map(),
  };
  const forward = (
    table: Map<string, ForwardedUse[]>,
    localId: string,
    use: ForwardedUse,
  ): void => {
    let forwards = table.get(localId);
    if (!forwards) table.set(localId, (forwards = []));
    forwards.push(use);
  };
  /** The union binding `x` whose payload `value` is: `unionNarrow(x)`, or a
   * checked narrowing `unionIsTag(x) ? <libCall> : unionNarrow(x)` (either
   * order), whose other branch is visited as any use. */
  function narrowedBinding(value: IrExpr): string | null {
    if (value.kind === "unionNarrow")
      return value.value.kind === "varRef" ? value.value.localId : null;
    if (
      value.kind !== "ternary" ||
      value.cond.kind !== "unionIsTag" ||
      value.cond.value.kind !== "varRef"
    )
      return null;
    const id = value.cond.value.localId;
    if (value.else_.kind === "libCall" && narrowedBinding(value.then) === id)
      return expr(value.else_) ? id : null;
    if (value.then.kind === "libCall" && narrowedBinding(value.else_) === id)
      return expr(value.then) ? id : null;
    return null;
  }
  const aliases: { alias: string; source: string }[] = [];
  const stringInput = (value: IrExpr): boolean => {
    if (value.kind === "varRef" && value.type.kind === "string") return true;
    return expr(value);
  };
  // A store through the binding (`obj.f = value`): numbers, booleans and
  // inline unions leave the object where it is, the write itself staying
  // visible to effect proofs, and an inline union local is only projected.
  const fieldStore = (obj: IrExpr, value: IrExpr, inline: boolean): boolean | null => {
    const projectedValue = inline && value.kind === "varRef";
    if (obj.kind === "varRef" && (inline || scalarValue(value)))
      return projectedValue || expr(value);
    return projectedValue ? expr(obj) : null;
  };
  function expr(node: IrExpr): boolean {
    switch (node.kind) {
      case "toBool":
      case "toString":
        if (node.operand.kind === "varRef" && node.operand.type.kind === "union") return true;
        break;
      case "strEq":
      case "strCmp":
      case "strConcat":
        return stringInput(node.left) && stringInput(node.right);
      case "strIntrinsic":
        if (borrowsStringInputs(node.method))
          return stringInput(node.receiver) && node.args.every(stringInput);
        break;
      case "mapIntrinsic":
      case "setIntrinsic":
        if (borrowsMapReadInputs(node)) return expr(node.receiver) && node.args.every(stringInput);
        break;
      case "unionNarrow":
        // The payload may escape; the union itself does not.
        if (node.value.kind === "varRef") {
          uses.payloadKept.add(node.value.localId);
          return true;
        }
        break;
      case "unionIsTag":
        if (node.value.kind === "varRef") return true;
        break;
      case "unionEq": {
        // Tag compare plus a borrowed arm compare; neither box escapes.
        const operand = (value: IrExpr): boolean =>
          (value.kind === "varRef" && value.type.kind === "union") || expr(value);
        return operand(node.left) && operand(node.right);
      }
      case "nullish":
        // The narrowed shape only tests the tag and extracts the payload.
        // The pass-through shape returns the box itself.
        if (
          node.left.kind === "varRef" &&
          node.left.type.kind === "union" &&
          node.type.kind !== "union"
        ) {
          uses.payloadKept.add(node.left.localId);
          return expr(node.right);
        }
        break;
      case "fieldGet":
      case "recordGet":
        // A field read of a binding, or of a union binding's narrowed
        // payload, keeps neither.
        if (node.obj.kind === "varRef" || narrowedBinding(node.obj) !== null) return true;
        break;
      case "dynFrom":
        // A copied record converts field by field; a live capsule keeps it.
        if (
          !node.liveRef &&
          node.value.kind === "varRef" &&
          node.value.type.kind === "record" &&
          recordDynCopy(node.value.type.shapeId)
        )
          return true;
        break;
      case "recordClone":
        // A same-shape spread copies the source's fields (retaining the
        // references) and keeps no reference to the source itself.
        if (node.source.kind !== "varRef") break;
        for (const field of node.overrides) expr(field.value);
        return true;
      case "recordLit":
        if (node.type.kind !== "record") break;
        for (const field of node.fields)
          if (
            field.overflow ||
            field.value.kind !== "varRef" ||
            !inlineField.record(node.type.shapeId, field.name)
          )
            expr(field.value);
        return true;
      case "callValue":
        if (node.callee.kind !== "varRef") expr(node.callee);
        if (node.receiver) expr(node.receiver);
        return node.args.every(expr);
      case "call":
        node.args.forEach((arg, index) => {
          const narrowed = narrowedBinding(arg);
          if (narrowed !== null) {
            forward(uses.payloadForwards, narrowed, { callee: node.callee, index, wrapped: false });
            return;
          }
          const wrapped =
            arg.kind === "unionWrap" && arg.value.kind === "varRef" && pointerWrap(arg);
          const value = wrapped ? arg.value : arg;
          if (value.kind !== "varRef") {
            expr(arg);
            return;
          }
          forward(uses.forwards, value.localId, { callee: node.callee, index, wrapped });
        });
        return true;
      case "assignExpr":
      case "incDec":
        uses.written.add(node.localId);
        uses.invalid.add(node.localId);
        break;
      case "varRef":
        uses.invalid.add(node.localId);
        break;
      case "closure":
      case "classRef":
        for (const id of node.captures ?? []) {
          uses.invalid.add(id);
          uses.written.add(id);
        }
        break;
    }
    return everyExprChild(node, expr, (node) => stmt(node, true));
  }
  /** `const x = y` or a statement `x = y` of union locals: the copy is
   * recorded instead of rejecting `y`. A parameter's copy still rejects it,
   * since callers may lend projection-only parameters a stack box. */
  const params = new Set(fn.params.map((param) => param.localId));
  const unionCopy = (target: string, value: IrExpr | null | undefined): boolean => {
    if (value?.kind !== "varRef" || value.type.kind !== "union" || params.has(value.localId))
      return false;
    let targets = uses.copies.get(value.localId);
    if (!targets) uses.copies.set(value.localId, (targets = []));
    targets.push(target);
    return true;
  };
  function stmt(node: IrStmt, inExpression: boolean): boolean {
    switch (node.kind) {
      case "return":
        // A register result reads the returned binding's tag and bits.
        if (registerReturn && node.value?.kind === "varRef") return true;
        break;
      case "varDecl":
        uses.declarations.set(node.localId, (uses.declarations.get(node.localId) ?? 0) + 1);
        if (unionCopy(node.localId, node.init)) return true;
        // A receiver temporary (`%compoundReceiver = this`) projects its
        // source as long as the temporary itself is only projected.
        if (
          node.init?.kind === "varRef" &&
          (node.init.type.kind === "object" || node.init.type.kind === "record")
        ) {
          aliases.push({ alias: node.localId, source: node.init.localId });
          return true;
        }
        break;
      case "fieldSet": {
        if (
          node.value.kind === "varRef" &&
          node.value.type.kind === "union" &&
          nullableField(node.className, node.field)
        ) {
          // The field retains the payload.
          uses.payloadKept.add(node.value.localId);
          return expr(node.obj);
        }
        const stored = fieldStore(
          node.obj,
          node.value,
          inlineField.classField(node.className, node.field),
        );
        if (stored !== null) return stored;
        break;
      }
      case "recordSet": {
        const stored = fieldStore(
          node.obj,
          node.value,
          inlineField.record(node.shapeId, node.field),
        );
        if (stored !== null) return stored;
        break;
      }
      case "assign":
        uses.written.add(node.localId);
        // Sequence expressions can rebind a previous call argument before
        // its consumer runs. Those locals need an owned heap snapshot.
        if (inExpression) uses.invalid.add(node.localId);
        else if (unionCopy(node.localId, node.value)) return true;
        break;
      case "forOf":
        // The binding is initialized afresh for each iteration. Its uses
        // can project a borrowed element while the loop owns the array.
        uses.declarations.set(node.localId, (uses.declarations.get(node.localId) ?? 0) + 1);
        break;
      case "rethrow":
        uses.invalid.add(node.localId);
        uses.written.add(node.localId);
        break;
      case "tryCatch":
        if (node.catchLocalId !== null) {
          uses.invalid.add(node.catchLocalId);
          uses.written.add(node.catchLocalId);
        }
        break;
    }
    return everyStmtChild(node, expr, (node) => stmt(node, inExpression));
  }
  fn.body.forEach((node) => stmt(node, false));
  // An alias of a rebound source would keep the old object; chains of
  // aliases settle to a fixpoint.
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  for (let changed = aliases.length > 0; changed;) {
    changed = false;
    for (const { alias, source } of aliases) {
      const local = locals.get(alias);
      if (
        !uses.invalid.has(source) &&
        (!local ||
          local.boxed ||
          local.tdz ||
          uses.invalid.has(alias) ||
          uses.written.has(alias) ||
          uses.written.has(source) ||
          uses.declarations.get(alias) !== 1 ||
          uses.forwards.has(alias))
      ) {
        uses.invalid.add(source);
        changed = true;
      }
    }
  }
  for (const capture of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])]) {
    uses.invalid.add(capture.localId);
    uses.written.add(capture.localId);
  }
  return uses;
}

/** Solve dependencies between individual parameters, rather than marking
 * every argument unsafe when one parameter escapes. Begin optimistically
 * inside recursive groups, then propagate each rejection through reverse
 * edges. Every parameter enters the worklist at most once; deep call chains
 * do not recurse on the compiler stack or repeatedly rescan function bodies.
 *
 * The result is private to one emission of the finalized IR. No fact is
 * serialized or reused after a compiler transformation. Parameter facts
 * cover synchronous bodies without environments only; closure bodies get
 * local facts alone. */
export function analyzeCallLifetimes(
  functions: ReadonlyMap<string, IrFunction>,
  nullableField: NullableFieldTest = () => false,
  /** Rebound parameters that only ever hold borrowed walk pointers
   * (walk-borrows.ts): they keep the borrowed convention although written. */
  walkParameters: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  /** Functions returning a scalar union as tag and payload bits
   * (Int32Abi.union): `return x` only projects `x`. */
  registerReturns: ReadonlySet<string> = new Set(),
  inlineField: InlineFieldTest = NO_INLINE_FIELDS,
  recordDynCopy: RecordDynCopyTest = () => false,
  pointerWrap: PointerWrapTest = () => false,
): CallLifetimes {
  const usesByFunction = new Map<string, Uses>();
  const lazyCaptures = new LazyCaptures(functions);
  const nodes = new Map<string, Parameter[]>();
  /** Union parameters that keep their payload in place too, which a
   * pointer-wrapped argument needs (ForwardedUse.wrapped). */
  const payloadNodes = new Map<string, (Parameter | undefined)[]>();
  const unsafe: Parameter[] = [];
  const consumed: { fn: string; index: number }[] = [];
  const result: CallLifetimes = {
    parameters: new Map(),
    locals: new Map(),
    borrowed: new Map(),
    bindings: new Map(),
    projectedLocals: new Map(),
    copiedLocals: new Map(),
    generatorParameters: new Map(),
  };
  for (const fn of functions.values()) {
    if (fn.generator !== undefined && fn.classCaptures === undefined) {
      const uses = collectUses(fn, nullableField, false, inlineField, recordDynCopy, pointerWrap);
      const locals = new Map(fn.locals.map((local) => [local.id, local]));
      const stable = new Set<string>();
      for (const param of fn.params) {
        const local = locals.get(param.localId);
        if (
          local &&
          isRefCounted(param.type) &&
          !local.boxed &&
          !local.tdz &&
          !uses.written.has(local.id) &&
          !uses.declarations.has(local.id)
        )
          stable.add(local.id);
      }
      if (stable.size > 0) result.generatorParameters.set(fn.name, stable);
      continue;
    }
    if (fn.async || fn.generator) continue;
    const uses = collectUses(
      fn,
      nullableField,
      registerReturns.has(fn.name),
      inlineField,
      recordDynCopy,
      pointerWrap,
    );
    usesByFunction.set(fn.name, uses);
    // Class-capturing bodies get only local facts (computed below from
    // their uses; class captures are already invalid). Binding and
    // parameter facts stay limited to plain functions and closures.
    if (fn.classCaptures !== undefined) continue;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    const stable = (local: IrLocal): boolean =>
      !local.boxed && !local.tdz && !uses.written.has(local.id);
    result.bindings.set(
      fn.name,
      new Set(
        fn.locals
          .filter((local) => stable(local) && uses.declarations.get(local.id) === 1)
          .map((local) => local.id),
      ),
    );
    if (fn.captures !== undefined) {
      // A closure body is invoked through its environment: its owned entry
      // adapts the closure ABI to a body that borrows every unchanged
      // reference parameter, and callers that know the body (or the
      // runtime, through the closure's borrowing entry) may lend instead.
      // No direct call can forward to these parameters. Its own unboxed
      // locals follow the same rules as any synchronous body; captured
      // cells are boxed and marked invalid.
      const borrowed = new Set<number>();
      fn.params.forEach((param, index) => {
        const local = locals.get(param.localId);
        if (local && isRefCounted(param.type) && stable(local) && !uses.declarations.has(local.id))
          borrowed.add(index);
      });
      if (borrowed.size > 0) result.borrowed.set(fn.name, borrowed);
      continue;
    }
    const borrowed = new Set<number>(walkParameters.get(fn.name));
    // A captured parameter that nothing rebinds keeps its entry value; its
    // environment box takes a reference of its own when it is created.
    const unchangedCaptures = lazyCaptures.parameters(fn);
    const walks = walkParameters.get(fn.name);
    // One walk of the body answers every parameter's last use (consumedParameter).
    let lastUses: BodyLastUses | undefined;
    const bodyLastUses = (): BodyLastUses => (lastUses ??= new BodyLastUses(fn.body));
    fn.params.forEach((param, index) => {
      const local = locals.get(param.localId);
      if (
        local &&
        !param.owned &&
        isRefCounted(param.type) &&
        (stable(local) || unchangedCaptures.has(local.id)) &&
        !uses.declarations.has(local.id)
      ) {
        borrowed.add(index);
        if (
          !walks?.has(index) &&
          !unchangedCaptures.has(local.id) &&
          param.name !== "this" &&
          consumedParameter(fn, param.localId, bodyLastUses)
        )
          consumed.push({ fn: fn.name, index });
      }
    });
    if (borrowed.size > 0) result.borrowed.set(fn.name, borrowed);
    nodes.set(
      fn.name,
      fn.params.map((param) => {
        const local = locals.get(param.localId);
        const safe =
          local !== undefined &&
          eligible(local) &&
          !uses.written.has(param.localId) &&
          !uses.invalid.has(param.localId) &&
          !uses.declarations.has(param.localId);
        const node: Parameter = { safe, callers: new Set() };
        if (!safe) unsafe.push(node);
        return node;
      }),
    );
    payloadNodes.set(
      fn.name,
      fn.params.map((param) => {
        if (param.type.kind !== "union") return undefined;
        const node: Parameter = { safe: !uses.payloadKept.has(param.localId), callers: new Set() };
        if (!node.safe) unsafe.push(node);
        return node;
      }),
    );
  }
  /** The fact a forwarded use needs from the callee's parameter. */
  const target = (use: ForwardedUse): Parameter | undefined =>
    use.wrapped ? payloadNodes.get(use.callee)?.[use.index] : nodes.get(use.callee)?.[use.index];
  for (const fn of functions.values()) {
    const params = nodes.get(fn.name);
    const uses = usesByFunction.get(fn.name);
    if (!params || !uses) continue;
    const depend = (node: Parameter, callees: (Parameter | undefined)[]): void => {
      if (!node.safe) return;
      for (const callee of callees) {
        if (!callee) {
          node.safe = false;
          unsafe.push(node);
          return;
        }
        callee.callers.add(node);
      }
    };
    fn.params.forEach((param, index) => {
      const node = params[index]!;
      const forwards = uses.forwards.get(param.localId) ?? [];
      depend(node, forwards.map(target));
      const payload = payloadNodes.get(fn.name)?.[index];
      if (!payload) return;
      // The payload stays in place when the union does, when every callee
      // the union reaches keeps its payload too, and when every callee its
      // narrowed payload reaches proves that parameter.
      depend(payload, [
        node,
        ...forwards.map((use) => payloadNodes.get(use.callee)?.[use.index]),
        ...(uses.payloadForwards.get(param.localId) ?? []).map(
          (use) => nodes.get(use.callee)?.[use.index],
        ),
      ]);
    });
  }
  for (let i = 0; i < unsafe.length; i++) {
    for (const caller of unsafe[i]!.callers) {
      if (!caller.safe) continue;
      caller.safe = false;
      unsafe.push(caller);
    }
  }
  for (const [name, params] of nodes) {
    const safe = new Set<number>();
    params.forEach((param, index) => {
      if (param.safe) safe.add(index);
    });
    if (safe.size > 0) result.parameters.set(name, safe);
  }
  for (const fn of functions.values()) {
    const uses = usesByFunction.get(fn.name);
    if (!uses) continue;
    const params = new Set(fn.params.map((param) => param.localId));
    const safe = new Set<string>();
    const projected = new Set<string>();
    const copied = new Map<string, readonly string[]>();
    for (const local of fn.locals) {
      if (
        params.has(local.id) ||
        !eligible(local) ||
        uses.invalid.has(local.id) ||
        uses.declarations.get(local.id) !== 1
      )
        continue;
      const forwards = uses.forwards.get(local.id) ?? [];
      if (!forwards.every((use) => target(use)?.safe === true)) continue;
      const copies = uses.copies.get(local.id);
      if (copies) {
        copied.set(local.id, copies);
        continue;
      }
      projected.add(local.id);
      if (eligible(local) && !uses.written.has(local.id)) safe.add(local.id);
    }
    result.locals.set(fn.name, safe);
    result.projectedLocals.set(fn.name, projected);
    if (copied.size > 0) result.copiedLocals.set(fn.name, copied);
  }
  // Consumed parameters take the owned convention, unless only projected.
  for (const { fn, index } of consumed) {
    if (result.parameters.get(fn)?.has(index) === true) continue;
    const borrowed = result.borrowed.get(fn);
    if (!borrowed) continue;
    borrowed.delete(index);
    if (borrowed.size === 0) result.borrowed.delete(fn);
  }
  return result;
}

/** SCRIPTC_EMIT_FACTS_VERIFY=1: every BodyLastUses answer is checked against storedLastUseRead. */
const verifiesLastUses = process.env["SCRIPTC_EMIT_FACTS_VERIFY"] === "1";

/** A parameter whose last use in the body stores it (a field, record or
 * element store, a record literal field, a push) and moves its reference
 * there (lastUseRead). Its owned convention lets a caller hand over a
 * temporary or its own last use; a borrowed one would retain the stored
 * copy while the caller releases its temporary right after the call. The
 * read must be the only node of its kind in the function, like every
 * moved read. */
function consumedParameter(fn: IrFunction, localId: string, lastUses: () => BodyLastUses): boolean {
  const read = lastUses().storedRead(localId);
  if (verifiesLastUses && read !== storedLastUseRead(fn.body, -1, localId, true))
    throw new InternalCompilerError(
      `call lifetimes: the body's last use of ${localId} in ${fn.name} differs`,
    );
  if (read === null) return false;
  let count = 0;
  const expr = (e: IrExpr): boolean => {
    if (e === read) count++;
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  fn.body.every(stmt);
  return count === 1;
}
