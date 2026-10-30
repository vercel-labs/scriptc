import type * as ts from "../ts7/adapter.js";
import type { IrBindingSource, IrLocal, IrParam, IrStmt, IrType } from "../../ir/ir.js";
import { InternalCompilerError } from "../../errors.js";

/** Per-function lowering context. A stack of these models nested functions:
 * identifier resolution walks outward, and a hit in an enclosing context
 * turns into a capture (boxing the binding at its origin and threading it
 * through every function in between). */
export interface FnCtx {
  locals: IrLocal[];
  scopes: Map<ts.Symbol, IrLocal>[];
  /** Lexical this has no checker symbol and one binding per function.
   * Direct parameters and threaded captures use this same slot. */
  thisLocal: IrLocal | null;
  /** Set when a lookup of `this` returned thisLocal, from this function's
   * body or from a nested function that captures it. */
  thisRead?: true;
  /** Derived constructors initialize fields at the actual super() site,
   * including sites nested in a try/finally block. Nested functions do not
   * inherit this hook. */
  superInitialized?: IrLocal;
  superCall?: (call: ts.CallExpression) => unknown;
  localCounters: Map<string, number>;
  /** Bindings belong to this lowering of the body. Generic specializations
   * share checker symbols and AST declarations, but never local storage. */
  hoistedVars: Map<ts.Symbol, IrLocal>;
  hoistedFnDecls: Set<ts.FunctionDeclaration>;
  /** Forward captures waiting for their source declaration to initialize
   * the TDZ box. The declaration's owner retains this entry while nested
   * functions lower and capture its slot. */
  tdzPredeclared: Map<ts.Symbol, IrLocal>;
  /** Lifted functions only: capture entries (also present in `locals`,
   * boxed), in closure caps[] order. undefined ⇔ plain declared function. */
  captures: IrParam[] | null;
  /** Parent-function localIds feeding each capture, parallel to captures. */
  captureSources: string[];
  captureBySymbol: Map<ts.Symbol, IrLocal>;
  /** Named function expressions/declarations: the function's own name
   * symbol. Self-references become `selfRef` (NOT a capture — a box holding
   * its own closure would be an RC cycle and leak). */
  selfSymbol: ts.Symbol | null;
  selfType: IrType | null;
  /** Await is legal here (async function body). */
  isAsync?: boolean;
  /** Yield is legal here (generator function body): the yield/next value
   * channels the yield lowering types itself against. */
  generator?: { yieldT: IrType; nextT: IrType; resultType: IrType & { kind: "record" } } | null;
  /** VARIADIC `arguments` form (rest-marked func type with no declared
   * rest param): the synthetic trailing dyn-array param `arguments`
   * reads resolve to. */
  argumentsLocal?: IrLocal | null;
  /** The count `arguments.length` reads in a top-level function declaration
   * that is also used as a value (argument-counts.ts). */
  argumentCount?: IrLocal;
  /** Arrows inherit the nearest ordinary function's arguments binding. */
  inheritsArguments?: boolean;
  /** A function lowered on demand on top of an unrelated caller's frames
   * (a generic instance): lexical `this` resolution stops here, so the
   * body sees what it sees when lowered alone. */
  thisBoundary?: true;
  /** Tuple bindings of this function that are only forwarded
   * (typed-arguments.ts onlyForwarded): binding local id → the native
   * slots forwarding reads. Such a binding is never materialized. Local ids
   * are unique within one function only, and nested functions never read
   * these bindings (a read there needs the tuple). */
  pureTuples: Map<string, IrLocal[]>;
  /** Declared return type — lets `return` detect record-shape mismatches
   * (SC2002) before the validator would ICE on them. */
  returnType: IrType;
  /** Implicit-any instance RETURN INFERENCE (resolveInferredReturn):
   * present ⇔ `return` statements lower their values BARE (no coercion)
   * and record themselves here; the post-pass unifies the types and wraps
   * each return onto the settled one. `returnType` holds the DYN pin. */
  inferReturn?: { entries: { stmt: IrStmt; node: ts.Expression | null }[] } | null;
  /** Enclosing jump targets, innermost last. `labels` carries the source
   * statement's JS label names so labeled break/continue resolve. Finally
   * regions do not appear here: the backends route every abrupt completion
   * through the cleanup regions it crosses. Per function, so a nested
   * function's jumps never bind to enclosing constructs. */
  ctl: { kind: "loop" | "switch" | "block"; labels?: string[] }[];
}

export function newFnCtx(
  lifted: boolean,
  selfSymbol: ts.Symbol | null,
  selfType: IrType | null,
  returnType: IrType,
): FnCtx {
  return {
    locals: [],
    scopes: [new Map()],
    thisLocal: null,
    localCounters: new Map(),
    hoistedVars: new Map(),
    hoistedFnDecls: new Set(),
    tdzPredeclared: new Map(),
    captures: lifted ? [] : null,
    captureSources: [],
    captureBySymbol: new Map(),
    pureTuples: new Map(),
    selfSymbol,
    selfType,
    returnType,
    ctl: [],
  };
}

/** Allocate one function-local name. Symbol identity controls lexical
 * binding; textual names only determine the emitted local identifier. */
export function declareContextLocal(
  ctx: FnCtx,
  name: string,
  type: IrType,
  mutable: boolean,
  symbol: ts.Symbol | undefined,
  source: IrBindingSource | undefined,
): IrLocal {
  const count = ctx.localCounters.get(name) ?? 0;
  ctx.localCounters.set(name, count + 1);
  const local: IrLocal = { id: `${name}.${count}`, name, type, mutable };
  if (source !== undefined) local.source = source;
  ctx.locals.push(local);
  if (symbol !== undefined) ctx.scopes[ctx.scopes.length - 1]!.set(symbol, local);
  return local;
}

/** This has one ABI slot per method and no checker symbol. Nested arrow
 * functions thread that slot through the ordinary capture mechanism. */
export function declareContextThis(ctx: FnCtx, type: IrType): IrLocal {
  const local: IrLocal = { id: "this.0", name: "this", type, mutable: false };
  ctx.locals.push(local);
  ctx.thisLocal = local;
  return local;
}

/** Look up a binding without allocating captures or boxing its source. */
export function bindingInContext(
  ctx: FnCtx,
  symbol: ts.Symbol | "arguments" | undefined,
): IrLocal | null {
  if (symbol === undefined) {
    if (ctx.thisLocal !== null) ctx.thisRead = true;
    return ctx.thisLocal;
  }
  if (symbol === "arguments") return ctx.argumentsLocal ?? null;
  for (let i = ctx.scopes.length - 1; i >= 0; i--) {
    const local = ctx.scopes[i]!.get(symbol);
    if (local) return local;
  }
  return ctx.captureBySymbol.get(symbol) ?? null;
}

export interface ContextBindingResult {
  local: IrLocal | null;
  origin: IrLocal | null;
  error: "plain" | null;
}

/** Resolve a declared binding across function boundaries. Checker queries,
 * diagnostics and forward-declaration discovery belong to the caller; this
 * module owns the scope and capture storage used by every lowering pass.
 *
 * The origin and every intermediate capture share a box. A captured
 * forward declaration carries its TDZ marker into each child context.
 * onCapture runs once per newly allocated edge so analyses can attach
 * metadata to the same binding without duplicating the lookup algorithm. */
export function captureContextBinding(
  stack: FnCtx[],
  symbol: ts.Symbol | "arguments" | undefined,
  onCapture: (parent: IrLocal, child: IrLocal) => void,
): ContextBindingResult {
  const current = stack[stack.length - 1];
  if (current === undefined)
    throw new InternalCompilerError("lowerer bug: no active function context");
  const direct = bindingInContext(current, symbol);
  if (direct !== null) return { local: direct, origin: direct, error: null };
  let floor = 0;
  if (symbol === undefined) {
    for (let depth = stack.length - 1; depth >= 0; depth--) {
      if (stack[depth]!.thisBoundary) {
        floor = depth;
        break;
      }
    }
  }
  for (let depth = stack.length - 2; depth >= floor; depth--) {
    const origin = bindingInContext(stack[depth]!, symbol);
    if (origin === null) continue;

    // references use the backends' box tracing for capture cycles.
    origin.boxed = true;
    let parentEntry = origin;
    for (let j = depth + 1; j < stack.length; j++) {
      const ctx = stack[j]!;
      let entry =
        symbol === undefined
          ? ctx.thisLocal
          : symbol === "arguments"
            ? ctx.argumentsLocal
            : ctx.captureBySymbol.get(symbol);
      if (!entry) {
        if (ctx.captures === null) return { local: null, origin, error: "plain" };
        entry = declareContextLocal(
          ctx,
          origin.name,
          origin.type,
          origin.mutable,
          undefined,
          origin.source,
        );
        entry.boxed = true;
        if (origin.tdz) entry.tdz = true;
        if (symbol === undefined) ctx.thisLocal = entry;
        else if (symbol === "arguments") ctx.argumentsLocal = entry;
        else ctx.captureBySymbol.set(symbol, entry);
        ctx.captures.push({ localId: entry.id, name: entry.name, type: entry.type });
        ctx.captureSources.push(parentEntry.id);
        onCapture(parentEntry, entry);
      }
      parentEntry = entry;
    }
    return { local: parentEntry, origin, error: null };
  }
  return { local: null, origin: null, error: null };
}

export function captureContextArguments(stack: FnCtx[]): IrLocal | null {
  let owner = stack.length - 1;
  while (owner > 0 && stack[owner]!.inheritsArguments) owner--;
  return captureContextBinding(stack.slice(owner), "arguments", () => {}).local;
}
