/* Statement lowering: the statement dispatch (lowerStmt), variable
 * declarations including destructuring patterns, scoped blocks, control
 * flow (if/while/for/for-of/do, switch, try/catch, jumps with the
 * finally-crossing fence), and blocked-binding poisoning. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { lowerForOfGenerator, lowerYieldStarStatement } from "./lower-generators.js";
import { BOOL, BYTES_U8, CAUGHT, DYN, F64, IrExpr, IrGlobal, IrJsOp, IrLocal, IrStmt, IrType, JSVAL, STRING, SrcLoc, UNDEFINED_T, VOID, arrayOf, isUnitType, shapeHasAccessorSlots, typeEquals } from "../../ir/nodes.js";
import { PoisonError, boundIdentifiersOf, dynFallbackType, dynUndefinedExpr, importCallHandleType, neverTaintedJsType, stmtUsesIsland, uncheckedOverloadHandleCall } from "./lowerer.js";
import { enforceLibBoundary } from "./lib-boundary.js";
import { cjsExportAssignmentOf, cjsExportDiscardReason, cjsExportTargetLiteral, isCjsJsFile, isJsSourceFile, locOf, requireSpecOf } from "../program.js";
import { COMPOUND_ASSIGN_OPS, CompoundOp, STR_METHODS, UNSUPPORTED_STMT, isStdlibMember, sideEffectFreeOptionValue, stdlibGlobalAliasDecl, stdlibGlobalNameOf } from "./surfaces.js";
import { isProvenanceSourceFile } from "../provenance-registry.js";
import { ambientUndefVarRootOf, lowerImportEquals, nsUndefRead, nsWritableTarget, trapDeclRootOf } from "./lower-namespaces.js";
import { expandoWritableTarget, lowerExpandoAssignStmt } from "./lower-expando.js";
import { ForOfIterProjection, lowerForOfArrayIter, lowerForOfMap, lowerForOfSearchParams, lowerForOfSet, objectIterOverIndexShape, strCharsCall } from "./lower-containers.js";
import { bindingContextualGenericFnNodeOf, bindingGenericFnAliasInfoOf, bindingGenericFnInfoOf, bindingGenericFnNodeOf, deadUnmappableBinding, implicitLocalFnInfoOf, implicitLocalFnNodeOf, nullishExprUnitOf, nullishGenericBindingUnitOf, recordKeysArrayCall } from "./lower-calls.js";
import { isMixinFnBinding, mixinResultBindingClassOf } from "./lower-mixins.js";
import type { ClassInfo, ClassIteratorInfo } from "./lower-classes.js";
import { genericIfaceBindingKeepsClass } from "./lower-classes.js";
import { lowerStreamUnderscoreAssign, streamClassAliasDecl, streamSidesOf } from "./lower-stream.js";
import { lowerHttpResPropertyAssignment, lowerHttpServerTimeoutAssignment, lowerServerCloseOverrideAssignment } from "./lower-server.js";
import { builtinMemberRequireDecl, builtinNamespaceDestructureModuleOf, createRequireBindingDecl, createRequireCalleeFileOf, createRequireNamespaceDecl, textCodecBindingDecl } from "./lower-builtins.js";
import { lowerEnumDeclaration } from "./lower-enums.js";
import { abstractPropertyDeclOf, aliasTypeofNarrows, isMatchSliceType, lowerAbsenceProbe, lowerGroupsProjection, matchResultNamedGroupsOf, probeLower, pureReemittable, runtimeOptionalTrueIds, symbolFieldInfo, withRuntimeOptionalNarrowed } from "./lower-exprs.js";
import { UNSUPPORTED, checkerPanicDiag, isCheckerPanic, requiresDynamicDiag } from "../../diagnostics/diagnostic.js";
import { isParseArgsDynTypeName, isUnitOnlyTsType, unitOnlyUnion } from "../types.js";
import { canonicalBuiltinModule, isRelativeSpecifier } from "../shared.js";
import { probeNodeRequireRefusal } from "../npm.js";

/** `const X = /* @__PURE__ *\/ makeX()` at a module's top level: every
 * declarator initialized by a call (or `new`) carrying the bundler PURE
 * annotation in its leading trivia — the shape --provenance-sources may
 * elide when the whole statement fences (see the catch path below). */
function pureAnnotatedDeadConst(stmt: ts.Statement, sf: ts.SourceFile): boolean {
  if (!ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent)) return false;
  if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
  const decls = stmt.declarationList.declarations;
  if (decls.length === 0) return false;
  return decls.every((d) => {
    let init = d.initializer;
    if (init === undefined) return false;
    const trivia = sf.text.slice(init.pos, init.getStart(sf));
    if (!trivia.includes("@__PURE__") && !trivia.includes("#__PURE__")) return false;
    // `as` casts are type-world wrappers (`(() => {...})() as unknown as
    // { new (): any }` — cookie's NullObject shape); the runtime
    // expression under them decides.
    while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
    return ts.isCallExpression(init) || ts.isNewExpression(init);
  });
}

/** --provenance-sources: true when `decl` is a declarator of a
 * pureAnnotatedDeadConst statement in a FETCHED SOURCE module whose
 * declared type has no static mapping — the declaration ELIDES: no
 * global registers, no code emits, no build diagnostic. The `@__PURE__`
 * annotation is the author's own declaration that dropping the unused
 * initializer is safe (the bundler contract — tree-shaken dists of these
 * packages genuinely ship without it), and a REACHED use of the binding
 * still fails the build through its per-site fence (no storage exists to
 * resolve to), so only genuinely-unused bindings ride this. Third-party
 * fetched source only: the program's own TypeScript keeps its compile
 * fences. The type probe's diagnostics roll back — elision must not leak
 * them onto the build — and the elision records ONCE (by position) into
 * provenanceElided for the coverage report's provenance section. Both
 * collectGlobals and lowerVarDecl gate on this, BEFORE the mixin/alias
 * probes that would otherwise claim (and diagnose) the call-initializer
 * shape. */
export function provenanceElidedConstDecl(L: Lowerer, decl: ts.VariableDeclaration): boolean {
  const sf = decl.getSourceFile();
  if (!isProvenanceSourceFile(sf.fileName)) return false;
  const stmt = decl.parent.parent;
  if (!ts.isVariableStatement(stmt) || !pureAnnotatedDeadConst(stmt, sf)) return false;
  const diagsBefore = L.diags.length;
  let mapped = false;
  try {
    for (const nameNode of boundIdentifiersOf(decl.name)) {
      if (L.mapTypeOf(L.typeOf(nameNode)) !== null) {
        mapped = true;
        break;
      }
    }
  } catch (e) {
    if (!(e instanceof PoisonError)) throw e;
  }
  L.diags.length = diagsBefore;
  if (mapped) return false;
  const loc = locOf(decl);
  if (!L.provenanceElided.some((d) => d.loc.file === loc.file && d.loc.start === loc.start)) {
    const name = ts.isIdentifier(decl.name) ? `'${decl.name.text}'` : "a destructured";
    L.provenanceElided.push({
      code: "SC2001",
      message: `the ${name} declaration is a '@__PURE__'-annotated const whose type has no static lowering — elided (the bundler contract licenses dropping the unused initializer); any reached use fences per site`,
      loc,
    });
  }
  return true;
}

/** Lowers statements, one poison catch per statement so one unsupported
   * construct doesn't hide the rest of the file's diagnostics. A single
   * source statement may expand to several IR statements (multi-declaration
   * `let a = 1, b = a + 1;`) but is counted once. */
  export function lowerStmts(L: Lowerer, stmts: readonly ts.Statement[]): IrStmt[] {
    const out: IrStmt[] = [];
    // JAVASCRIPT sources defer their compile fences to runtime (the
    // JS-input design: no annotations exist to change what lowers, so a
    // statement whose construct has no static lowering compiles to a
    // runtimeFence — a catchable, SC-coded throw at the statement's
    // position — instead of failing the whole build). TypeScript keeps
    // compile fences. ICEs (SC9001) always stay compile errors.
    const sf = stmts[0]?.getSourceFile();
    const deferFences = sf !== undefined && isJsSourceFile(sf);
    // Register this list as open for the forward-capture machinery: a
    // nested function lowering mid-list may pre-declare a LATER const of
    // this list as a TDZ box (predeclareForwardCapture), pushing the
    // scope-entry varDecl into `out` before the current statement's IR.
    const entry = {
      stmts,
      index: 0,
      ctx: L.ctx,
      frame: L.scopes[L.scopes.length - 1]!,
      out,
    };
    L.activeStmtLists.push(entry);
    try {
      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i]!;
        entry.index = i;
        if (!L.suppressStats) {
          L.stats.statementsTotal++;
          if (sf !== undefined) L.bumpFileStat(sf.fileName, "total");
        }
        const diagsBefore = L.diags.length;
        try {
          const lowered = L.lowerStmt(stmt);
          // The lib-boundary chokepoint (lib-boundary.ts): checked-dynamic
          // arguments that reached builtin-call slots without the checked
          // coercion get their dynCheck here, and the uncoercible ones
          // fence — inside this statement's poison window, so a JS fence
          // becomes the statement's runtimeFence exactly like every other
          // deferred rejection.
          if (lowered) enforceLibBoundary(L, lowered);
          if (Array.isArray(lowered)) out.push(...lowered);
          else if (lowered) out.push(lowered);
          // Island accounting (--dynamic coverage): a statement that lowered
          // but carries island constructs compiles DYNAMICALLY — its work
          // runs in the embedded engine, and the report says so instead of
          // counting it as static.
          if (!L.suppressStats && lowered && stmtUsesIsland(lowered)) {
            L.stats.statementsIsland++;
            if (sf !== undefined) L.bumpFileStat(sf.fileName, "island");
          }
          // A JS statement that lowered CLEAN can still have flushed
          // DEFERRED collection diagnostics (a symbol lookup on an alias
          // resolves through flushDeferred — informational here, not a
          // blocker of THIS statement): those belong to the runtime-fence
          // ledger, not the build — real uses of the broken declaration
          // meet their own per-site fences.
          if (deferFences && L.diagSink === null && L.diags.length > diagsBefore) {
            const flushed = L.diags.splice(diagsBefore);
            const ice = flushed.filter((d) => d.code === "SC9001");
            L.diags.push(...ice);
            L.runtimeFences.push(...flushed.filter((d) => d.code !== "SC9001"));
          }
        } catch (e) {
          // A Go panic inside tsgo, surfaced by the sync channel as a
          // thrown Error (server intact — the prefetch fence's finding):
          // an upstream checker bug reached through this statement's
          // queries. It poisons the statement under a source-anchored
          // diagnostic exactly like a fence — never a crashed CLI.
          if (isCheckerPanic(e)) {
            L.pushDiag(checkerPanicDiag(e.message.split("\n", 1)[0]!, locOf(stmt)));
          } else if (!(e instanceof PoisonError)) {
            throw e;
          }
          if (!L.suppressStats) {
            L.stats.statementsFailed++;
            if (sf !== undefined) L.bumpFileStat(sf.fileName, "failed");
          }
          L.noteBlockedBindings(stmt);
          // The runtime-fence conversion (JS sources, direct diagnostics
          // only — a capture wrapper in force means collection owns the
          // report). The statement's diagnostics move OFF the build and
          // onto the fence: executing the statement throws the first
          // one's message, so nothing is ever silently dropped — either
          // the statement never runs (Node parity: the construct never
          // executed) or it reports exactly what the compile fence would
          // have said.
          if (deferFences && L.diagSink === null) {
            const captured = L.diags.splice(diagsBefore);
            if (captured.some((d) => d.code === "SC9001")) {
              L.diags.push(...captured); // ICEs stay compile errors
            } else {
              const first = captured[0];
              L.runtimeFences.push(...captured);
              // The thrown message carries the fence's own position (the
              // statement's line when the capture was empty) — a run-phase
              // failure must name its blocker as precisely as a compile
              // diagnostic would have.
              const at = (d?: { loc: { file: string; start: number } }): string => {
                const loc = d?.loc ?? { file: sf!.fileName, start: stmt.getStart(sf) };
                const pos = ts.getLineAndCharacterOfPosition(
                  d ? L.program.getSourceFile(loc.file) ?? sf! : sf!,
                  loc.start,
                );
                return `${loc.file}:${pos.line + 1}`;
              };
              out.push({
                kind: "runtimeFence",
                code: first?.code ?? "SC1090",
                message: first
                  ? `${first.message} [${first.code} at ${at(first)}]`
                  : `this statement uses a construct with no static lowering [SC1090 at ${at()}]`,
                loc: locOf(stmt),
              });
            }
          }
        }
      }
    } finally {
      L.activeStmtLists.pop();
    }
    return out;
  }

/** The TDZ kinds: pointer-backed representations, where the box's empty
   * NULL slot IS the not-yet-initialized sentinel — plus the scalars
   * (f64/bool), whose TDZ boxes store a one-element ARRAY cell so the
   * empty-slot sentinel still works (a scalar slot has no spare state:
   * every bit pattern is a legal value — the setTimeout-handle shape,
   * `clearTimeout(timer)` captured above `const timer = setTimeout(...)`).
   * dyn/caught/jsval keep their existing capture fences. Unit-only types
   * never carry a useful forward capture. */
  const TDZ_KINDS = new Set<IrType["kind"]>([
    "func", "string", "array", "record", "object", "union", "map", "set", "regex", "bytes",
    "f64", "bool",
    // The runtime HANDLE kinds — heap, refcounted, pointer-backed like
    // `object`, so the box's NULL sentinel works unchanged. The canonical
    // shape is the const's own initializer capturing the const:
    // `const server = http.createServer(h).listen(0, done)` with `done`
    // reading `server` — a TDZ read until the assign completes, JS exactly.
    "child", "childStream", "netServer", "netSocket", "dgramSocket", "testCtx",
    "httpReq", "httpRes", "httpClientReq",
    // The h2 handles — `const client = http2.connect(url, mustCall(() =>
    // ...client...))` is the suite's canonical self-capturing const.
    "http2Session", "http2Stream",
  ]);

/** The hoisted-handler shape: a function declared BEFORE a const it
   * captures, in the same (or an enclosing) statement list —
   *
   *   const cleanup = () => { process.removeListener("SIGINT", onSigInt); };
   *   const onSigInt = () => handleSignal("SIGINT");
   *
   * JS hoists the BINDING to scope entry (TDZ) and initializes it at the
   * declaration; a read before initialization throws ReferenceError. Model
   * exactly that: when a reference fails to resolve anywhere on the
   * function stack, look for its declaration LATER in an open statement
   * list — a const with an initializer, pointer-backed type — and
   * pre-declare it there as a TDZ box (varDecl init:null, boxed, tdz),
   * registered in the list's scope frame so resolution finds it and
   * threads captures normally. The source declaration later becomes the
   * initializing `assign` (lowerVarDecl consumes tdzPredeclared). Reads
   * test the box and throw Node's exact catchable ReferenceError while it
   * is empty. CONST ONLY: `let` would need the same trap on writes, a
   * surface nothing yet needs. */
  export function predeclareForwardCapture(L: Lowerer, symbol: ts.Symbol): boolean {
    const decl = L.checker.valueDeclarationOf(symbol);
    if (!decl || !ts.isVariableDeclaration(decl) || decl.name === undefined || !ts.isIdentifier(decl.name)) return false;
    if (!decl.initializer) return false;
    if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return false;
    if (L.tdzPredeclared.has(symbol)) return false; // defensive: never twice
    // MODULE-scope consts are pre-registered globals (collectGlobals):
    // references resolve through globalOf after the local search fails, so
    // a TDZ box here would SHADOW the global and never fill (the top-level
    // `const id = setInterval(cb)` self-capture — the global slot is the
    // binding). Function-scope declarations have no global; they predeclare.
    if (L.globalsBySymbol.has(symbol)) return false;
    const varStmt = decl.parent.parent;
    if (!ts.isVariableStatement(varStmt)) return false; // for-initializers stay out
    for (let i = L.activeStmtLists.length - 1; i >= 0; i--) {
      const entry = L.activeStmtLists[i]!;
      const idx = entry.stmts.indexOf(varStmt);
      if (idx < 0) continue;
      // Not forward (already lowered — resolution would have found it) or
      // a direct same-function forward read (tsc's TS2448 rejects those;
      // only reads from NESTED functions belong here). The declaration
      // CURRENTLY lowering counts as forward too: a callback inside the
      // const's own initializer capturing the const (`const server =
      // createServer(h).listen(0, go)` with `go` reading `server`) is a
      // TDZ read until the initializing assign completes — JS exactly.
      if (idx < entry.index || entry.ctx === L.ctx) return false;
      const type = L.irTypeOf(decl.name);
      if (!TDZ_KINDS.has(type.kind) || isUnitType(type)) return false;
      const name = decl.name.text;
      const count = entry.ctx.localCounters.get(name) ?? 0;
      entry.ctx.localCounters.set(name, count + 1);
      const local: IrLocal = { id: `${name}.${count}`, name, type, mutable: false, boxed: true, tdz: true };
      entry.ctx.locals.push(local);
      entry.frame.set(symbol, local);
      entry.out.push({ kind: "varDecl", localId: local.id, init: null, loc: locOf(decl) });
      L.tdzPredeclared.set(symbol, local);
      return true;
    }
    return false;
  }

/** The FUNCTION-DECLARATION twin of predeclareForwardCapture: JS hoists a
   * nested `function f() {}` to scope entry — the binding is LIVE from the
   * first statement, so a reference lexically above the declaration in the
   * SAME function lowers the declaration eagerly at the reference (varDecl
   * pushed before the current statement's IR, registered in the list's
   * scope frame) and the statement loop skips the source statement when it
   * arrives (L.hoistedFnDecls). Same-function only: the declaration's own
   * lowering runs under the ctx that owns its statement list, and a
   * cross-function early capture would need lowering under a DIFFERENT
   * ctx than the one currently open — that shape keeps the honest fence. */
  export function predeclareForwardFnDecl(L: Lowerer, symbol: ts.Symbol): boolean {
    const decl = L.checker.valueDeclarationOf(symbol);
    if (!decl || !ts.isFunctionDeclaration(decl) || !decl.body || decl.typeParameters) return false;
    if (L.hoistedFnDecls.has(decl)) return false; // defensive: never twice
    for (let i = L.activeStmtLists.length - 1; i >= 0; i--) {
      const entry = L.activeStmtLists[i]!;
      const idx = entry.stmts.indexOf(decl);
      if (idx < 0) continue;
      // Not forward — already lowered; resolution would have found it.
      if (idx <= entry.index) return false;
      // The declaration may live in an ENCLOSING function's open list (a
      // sibling hoisted function calling a later one — mutual recursion):
      // lower it under the OWNER's lexical environment by truncating the
      // function stack to the owning ctx and its scope stack to the list's
      // frame, so the local declares in the right scope and the body's
      // captures thread from the right parents. Both stacks restore
      // afterwards; the reference that triggered this then resolves the
      // fresh local and threads its own captures normally.
      const depth = L.fnStack.indexOf(entry.ctx);
      const frameIdx = entry.ctx.scopes.indexOf(entry.frame);
      if (depth < 0 || frameIdx < 0) return false;
      L.hoistedFnDecls.add(decl);
      const fnTail = L.fnStack.splice(depth + 1);
      const scopeTail = entry.ctx.scopes.splice(frameIdx + 1);
      try {
        entry.out.push(L.lowerNestedFunctionDecl(decl));
      } catch (e) {
        L.hoistedFnDecls.delete(decl);
        throw e;
      } finally {
        entry.ctx.scopes.push(...scopeTail);
        L.fnStack.push(...fnTail);
      }
      return true;
    }
    return false;
  }

/** True when `decl` (a variable declaration or a pattern name inside one)
   * was declared with `var` — no const/let/using flag anywhere on its
   * binding chain. */
  export function isVarDeclared(decl: ts.Node): boolean {
    return (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) === 0;
  }

/** The VariableDeclaration hosting a binding name (walking out of any
   * enclosing binding patterns), or null when the name belongs to some
   * other declaration form — a parameter pattern, a catch binding. */
  function hostVariableDeclarationOf(name: ts.Identifier): ts.VariableDeclaration | null {
    let n: ts.Node = name.parent;
    while (ts.isBindingElement(n) || ts.isArrayBindingPattern(n) || ts.isObjectBindingPattern(n)) {
      n = n.parent;
    }
    return ts.isVariableDeclaration(n) ? n : null;
  }

/** `for (var x of ...)` loop variables: the ONE function-scoped binding
   * every for-of desugar must ASSIGN per iteration instead of declaring a
   * fresh per-pass local — a captured `var` loop variable is shared by
   * every closure made in the loop (where `let` gets a fresh binding per
   * iteration), and it persists after the loop. Returns the write target
   * (a module global for top-level loops, the hoisted function slot
   * otherwise); null when the binding isn't a `var` identifier. */
  export function forOfVarTarget(L: Lowerer, decl: ts.VariableDeclaration): { id: string; type: IrType } | null {
    if (!ts.isIdentifier(decl.name) || !isVarDeclared(decl)) return null;
    const symbol = L.checker.getSymbolAtLocation(decl.name);
    if (!symbol) return null;
    const g = L.globalsBySymbol.get(symbol);
    if (g) return g;
    return hoistVarBinding(L, symbol, decl.name);
  }

/** The `var` symbol's function-scoped binding TYPE — the declared type at
   * the binding name, with the JS-source fallbacks every mutable binding
   * takes (an empty-object-literal type is checked-dynamic because tsc
   * admits ANY later assignment to it; an unmappable strict type in a JS
   * file rides the dyn fallback). Null when no static type can hold the
   * binding. */
  function varBindingType(L: Lowerer, nameNode: ts.Identifier): IrType | null {
    let type = L.mapTypeOf(L.typeOf(nameNode));
    if (type?.kind === "record" && isJsSourceFile(nameNode.getSourceFile())) {
      const shape = L.shapes.get(type.shapeId);
      if (shape && shape.fields.length === 0 && !shape.indexValue && !shape.tuple) type = DYN;
    }
    if (!type) type = dynFallbackType(L, nameNode, L.typeOf(nameNode));
    // `var p = import("./m")` in a function body: the hoisted slot holds
    // the island promise/handle — the import expression's only production
    // (lowerVarDecl's rule for block-scoped bindings).
    if (L.dynamic && ts.isVariableDeclaration(nameNode.parent) && nameNode.parent.name === nameNode) {
      type =
        importCallHandleType(nameNode.parent.initializer) ??
        // An unchecked-overload call result stores the handle, exactly the
        // let/const rule (see uncheckedOverloadHandleCall).
        (uncheckedOverloadHandleCall(L, nameNode.parent.initializer) ? JSVAL : null) ??
        type;
    }
    if (!type || type.kind === "void") return null;
    return type;
  }

/** `var` declarations hoist to their FUNCTION: the binding exists across
   * the whole enclosing function body regardless of block position, and
   * every same-name `var` in that function is the SAME binding (tsc merges
   * the declarations into one symbol, so symbol-keyed resolution gets the
   * merge for free). This mints the one function-scoped slot on first
   * encounter: an IrLocal registered in the function's ROOT scope frame
   * (never popped by block exits) whose `varDecl` is PUSHED into the
   * function-root statement list at the current position — everything
   * already lowered never referenced the symbol (resolution would have
   * found it), so the position is observationally function entry. Types
   * with an undefined arm initialize to the interned undefined (JS's
   * hoisted value — reads before the first assignment are `undefined`, and
   * tsc's flow analysis rejects such reads for every OTHER type); the rest
   * start empty, their pre-assignment reads impossible by that analysis.
   * A `var` merging with a PARAMETER of the same name (one symbol in JS
   * and in tsc's binder) resolves to the parameter's slot — `var x = 2`
   * simply overwrites the argument, exactly Node. The source declaration
   * lowers to a plain `assign` (see lowerVarDecl), so a declaration inside
   * a loop re-ASSIGNS the one binding per pass and never resets it — the
   * classic capture semantics fall out: closures made in a loop share the
   * single boxed binding, where `let` gets a fresh box per iteration. */
  export function hoistVarBinding(L: Lowerer, symbol: ts.Symbol, nameNode: ts.Identifier): IrLocal {
    const existing = L.hoistedVars.get(symbol);
    if (existing) return existing;
    // The parameter merge: the symbol already binds a function-root local.
    const bound = L.bindingIn(L.ctx, symbol);
    if (bound) {
      L.hoistedVars.set(symbol, bound);
      return bound;
    }
    const type = varBindingType(L, nameNode);
    if (!type) L.badType(nameNode, L.typeOf(nameNode));
    const root = L.activeStmtLists.find((e) => e.ctx === L.ctx);
    if (!root) throw new Error("lowerer bug: var hoisting with no open statement list");
    const name = nameNode.text;
    const count = L.ctx.localCounters.get(name) ?? 0;
    L.ctx.localCounters.set(name, count + 1);
    const local: IrLocal = { id: `${name}.${count}`, name, type, mutable: true };
    L.ctx.locals.push(local);
    L.ctx.scopes[0]!.set(symbol, local);
    // A checked-dynamic slot holds the dyn undefined (a NULL dyn is a
    // trap); everything else rides unassignedSlotInit (interned union arm,
    // engine undefined for jsval).
    const wrapped = type.kind === "dyn" ? dynUndefinedExpr(locOf(nameNode)) : L.unassignedSlotInit(type, locOf(nameNode));
    root.out.push({ kind: "varDecl", localId: local.id, init: wrapped, loc: locOf(nameNode) });
    L.hoistedVars.set(symbol, local);
    return local;
  }

/** The forward twin of hoistVarBinding, entered from resolution failure: a
   * reference to a `var` whose declaration statement has not lowered yet —
   * a read/write lexically above the declaration in the same function
   * (legal under tsc exactly when the type carries `undefined`), or a
   * nested function created above it that captures the binding. JS gives
   * such reads `undefined`, never a TDZ error, so the hoisted slot must
   * hold `undefined` from function entry — which is only honest for
   * undefined-armed union types (the interned arm) and checked-dynamic
   * bindings (the dyn undefined). Everything else returns false
   * and the reference lands on the named fence in rejectUnresolvedSymbol:
   * a slot of a narrower type has no bit pattern for the `undefined` Node
   * would yield if the capture ran early, and guessing "it won't" is the
   * silent-wrong-output sin. */
  export function predeclareForwardVar(L: Lowerer, symbol: ts.Symbol): boolean {
    if (L.hoistedVars.has(symbol)) return false; // would have resolved
    const decl = L.checker.valueDeclarationOf(symbol);
    if (!decl || !ts.isVariableDeclaration(decl) || !isVarDeclared(decl)) return false;
    const nameNode = ts.isIdentifier(decl.name) ? decl.name : null;
    if (!nameNode) {
      // Pattern-declared vars forward-hoist per bound NAME; find this
      // symbol's own identifier inside the pattern.
      return false;
    }
    // The owning function: the innermost OPEN statement list containing an
    // ancestor of the declaration (statement lists never cross function
    // boundaries, so its ctx is the var's function).
    const ancestors = new Set<ts.Node>();
    for (let n: ts.Node | undefined = decl; n !== undefined; n = n.parent) ancestors.add(n);
    let owner: (typeof L.activeStmtLists)[number] | null = null;
    for (let i = L.activeStmtLists.length - 1; i >= 0 && owner === null; i--) {
      const entry = L.activeStmtLists[i]!;
      if (entry.stmts.some((s) => ancestors.has(s))) owner = entry;
    }
    if (!owner) return false;
    const ctx = owner.ctx;
    // Only a slot that can hold `undefined` can carry the pre-
    // initialization reads: an undefined-armed union (the interned arm),
    // a checked-dynamic binding (the dyn undefined), or a jsval 'any'
    // binding (the engine's undefined).
    const type = varBindingType(L, nameNode);
    if (!type) return false;
    const wrapped = type.kind === "dyn" ? dynUndefinedExpr(locOf(decl)) : L.unassignedSlotInit(type, locOf(decl));
    if (!wrapped) return false;
    const root = L.activeStmtLists.find((e) => e.ctx === ctx)!;
    const name = nameNode.text;
    const count = ctx.localCounters.get(name) ?? 0;
    ctx.localCounters.set(name, count + 1);
    const local: IrLocal = { id: `${name}.${count}`, name, type, mutable: true };
    ctx.locals.push(local);
    ctx.scopes[0]!.set(symbol, local);
    root.out.push({ kind: "varDecl", localId: local.id, init: wrapped, loc: locOf(decl) });
    L.hoistedVars.set(symbol, local);
    return true;
  }

/** Records the symbols a poisoned DECLARATION statement would have bound
   * (identifier and pattern names alike, for-initializers included) so
   * later references report the SC2004 cascade. Registered bindings win:
   * lowerVarDecl's salvage path declares the local when it can, and
   * resolution checks locals/globals before the fallthroughs consult
   * blockedBindings. */
  export function noteBlockedBindings(L: Lowerer, stmt: ts.Statement): void {
    let list: ts.VariableDeclarationList | null = null;
    if (ts.isVariableStatement(stmt)) list = stmt.declarationList;
    else if (
      (ts.isForStatement(stmt) || ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) &&
      stmt.initializer !== undefined &&
      ts.isVariableDeclarationList(stmt.initializer)
    ) {
      list = stmt.initializer;
    }
    if (!list) return;
    for (const decl of list.declarations) {
      for (const nameNode of boundIdentifiersOf(decl.name)) {
        const symbol = L.checker.getSymbolAtLocation(nameNode);
        if (symbol) L.blockedBindings.add(symbol);
      }
    }
  }

/** True when a reference/assignment fell through resolution because the
   * binding's DECLARATION never compiled: a poisoned declaration statement
   * (blockedBindings) or a deferred-diagnostic declaration (a blocked
   * signature/class/global — deferred now, flushed earlier this pass, or
   * flushed by the emit pass). */
  export function isBlockedBinding(L: Lowerer, symbol: ts.Symbol | null): boolean {
    if (!symbol) return false;
    return (
      L.blockedBindings.has(symbol) ||
      L.deferredDiags.has(symbol) ||
      L.flushedSymbols.has(symbol) ||
      L.alreadyFlushed.has(symbol)
    );
  }

/** Lowers a statement in a fresh lexical scope (if/while/for bodies). */
  export function lowerScopedBlock(L: Lowerer, stmt: ts.Statement): IrStmt[] {
    L.scopes.push(new Map());
    try {
      const stmts = ts.isBlock(stmt) ? L.lowerStmts(stmt.statements) : L.lowerStmts([stmt]);
      return stmts;
    } finally {
      L.scopes.pop();
    }
  }

/** The finally fences. `return` crossing OUT of a try/catch body guarded
   * by a finally is SUPPORTED now (the backend's pending-return path runs
   * every crossed finally inner-to-outer before the function returns, the
   * value snapshotted first — Node-exact); what stays rejected is (a) any
   * jump out of a finally BLOCK itself (a return there would REPLACE a
   * pending completion — clearing a still-propagating exception or
   * abandoning a pending return, a model the emitter doesn't implement),
   * and (b) break/continue crossing a try-with-finally (their targets bind
   * inside the function; the pending-action plumbing exists only for
   * return, the shape real code needs). Rejected, not miscompiled. Plain
   * try/catch is transparent to jumps (it never appears in ctl). A LABELED
   * jump walks outward past every construct (labeled targets can be
   * arbitrarily far out) until the entry carrying its label, applying the
   * same finally fences to everything crossed on the way. */
  export function rejectJumpCrossingFinally(L: Lowerer, kw: "break" | "continue" | "return", stmt: ts.Statement, label?: string): void {
    const ctl = L.ctx.ctl;
    for (let i = ctl.length - 1; i >= 0; i--) {
      const c = ctl[i]!;
      if (c.kind === "finallyBlock") {
        L.unsupported(
          "SC1090",
          stmt,
          `'${kw}' out of a 'finally' block (it would replace the pending completion — restructure so the finally only cleans up)`,
        );
      }
      if (c.kind === "tryFinally") {
        if (kw !== "return") {
          L.unsupported("SC1090", stmt, `'${kw}' crossing a 'finally' block`);
        }
        continue; // return runs the finally on the way out — supported
      }
      if (kw === "return") continue; // return crosses every construct
      if (label !== undefined) {
        if (c.labels?.includes(label)) return; // the labeled target — binds here
        continue; // an inner construct the labeled jump exits
      }
      if (c.kind === "loop" || (kw === "break" && c.kind === "switch")) return; // binds inside the region
    }
  }

/** `lbl: stmt` — labeled statements. A label chain collapses to one name
   * list (`a: b: while ...` — both names target the same loop, JS-exact).
   * Loops and switches take the labels DIRECTLY (a labeled continue needs
   * the loop's own continue point — the condition/update — and a labeled
   * switch-break its end): pendingLabels hands them to the construct's own
   * lowering, which consumes them before lowering anything nested (so an
   * inner loop can never steal them). Every other labeled statement wraps
   * in a labeled BLOCK — `break lbl` exits it (the only jump tsc allows to
   * target a non-loop label), and a label nothing jumps to is just the
   * statement itself. Loop shapes whose lowering is a label-free desugar
   * (container/matchAll/stdin for-ofs, union switches) DROP the labels
   * after consuming them: an unused label costs nothing, and a labeled
   * jump naming one fences by name at the jump site instead of compiling
   * against the wrong target. */
  export function lowerLabeled(L: Lowerer, stmt: ts.LabeledStatement): IrStmt | IrStmt[] | null {
    const labels: string[] = [];
    let inner: ts.Statement = stmt;
    while (ts.isLabeledStatement(inner)) {
      labels.push(inner.label.text);
      inner = inner.statement;
    }
    if (
      ts.isWhileStatement(inner) ||
      ts.isDoStatement(inner) ||
      ts.isForStatement(inner) ||
      ts.isForOfStatement(inner) ||
      ts.isForInStatement(inner) ||
      ts.isSwitchStatement(inner)
    ) {
      L.pendingLabels = labels;
      try {
        return L.lowerStmt(inner);
      } finally {
        // Defensive: a path that never consumed them must not leak labels
        // into whatever lowers next.
        L.pendingLabels = null;
      }
    }
    const body = L.inCtl("block", () => L.lowerScopedBlock(inner), labels);
    return { kind: "block", body, labels, loc: locOf(stmt) };
  }

export function lowerStmt(L: Lowerer, stmt: ts.Statement): IrStmt | IrStmt[] | null {
    if (ts.isVariableStatement(stmt)) {
      // `declare const` — ambient: no storage, no init (collectGlobals
      // skipped it; reads throw Node's ReferenceError at the access).
      const first = stmt.declarationList.declarations[0];
      if (first && ts.getCombinedModifierFlags(first) & ts.ModifierFlags.Ambient) return null;
      return L.lowerVarStatement(stmt);
    }
    if (ts.isExpressionStatement(stmt)) return L.lowerExprStatement(stmt.expression);
    // `export default <expr>` (top-level only — preflight admitted it):
    // the assignment of the module's pre-registered `default` global.
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      return L.lowerDefaultExport(stmt);
    }
    if (ts.isIfStatement(stmt)) {
      const cond = L.lowerCondition(stmt.expression);
      // Aliased-typeof narrows (ms's `var type = typeof val` guard): the
      // then-branch lowers under what a TRUE condition proves, the
      // else-branch under a FALSE one — the var/let alias narrowing the
      // checker only performs for consts (aliasTypeofNarrows).
      const then = L.narrowingAliases(aliasTypeofNarrows(L, stmt.expression, true), () =>
        withRuntimeOptionalNarrowed(L, runtimeOptionalTrueIds(L, stmt.expression), () =>
          L.lowerScopedBlock(stmt.thenStatement)),
      );
      const else_ = stmt.elseStatement
        ? L.narrowingAliases(aliasTypeofNarrows(L, stmt.expression, false), () =>
            L.lowerScopedBlock(stmt.elseStatement!),
          )
        : null;
      const narrowedAfter = falsyExitRuntimeOptionalLocal(L, stmt);
      if (narrowedAfter !== null) L.runtimeOptionalLocals.delete(L.runtimeOptionalRootOf(narrowedAfter));
      return { kind: "if", cond, then, else_, loc: locOf(stmt) };
    }
    if (ts.isWhileStatement(stmt)) {
      const labels = L.takeLabels();
      const cond = L.lowerCondition(stmt.expression);
      const body = L.inCtl("loop", () =>
        withRuntimeOptionalNarrowed(L, runtimeOptionalTrueIds(L, stmt.expression), () =>
          L.lowerScopedBlock(stmt.statement)), labels);
      return { kind: "while", cond, body, ...(labels && { labels }), loc: locOf(stmt) };
    }
    if (ts.isDoStatement(stmt)) {
      // Source order: body first, then the condition.
      const labels = L.takeLabels();
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      const cond = L.lowerCondition(stmt.expression);
      return { kind: "doWhile", body, cond, ...(labels && { labels }), loc: locOf(stmt) };
    }
    if (ts.isSwitchStatement(stmt)) return L.lowerSwitch(stmt);
    if (ts.isForStatement(stmt)) return L.lowerForStatement(stmt);
    if (ts.isForOfStatement(stmt)) return L.lowerForOf(stmt);
    if (ts.isLabeledStatement(stmt)) return lowerLabeled(L, stmt);
    if (ts.isReturnStatement(stmt)) {
      L.rejectJumpCrossingFinally("return", stmt);
      // Implicit-any instance RETURN INFERENCE (lower-calls'
      // resolveInferredReturn): the value lowers BARE and the statement
      // records itself — the post-pass settles the instance's return type
      // over every recorded return and wraps them in place. A VOID-typed
      // value (`return log(x)`) evaluates for effect and returns JS's
      // undefined: the expression statement plus a recorded bare return.
      if (L.ctx.inferReturn) {
        const value = stmt.expression ? L.lowerExpr(stmt.expression) : null;
        if (value !== null && value.type.kind === "void") {
          const bare: IrStmt = { kind: "return", value: null, loc: locOf(stmt) };
          L.ctx.inferReturn.entries.push({ stmt: bare, node: null });
          return {
            kind: "block",
            body: [{ kind: "exprStmt", expr: value, loc: locOf(stmt) }, bare],
            loc: locOf(stmt),
          };
        }
        const rec: IrStmt = { kind: "return", value, loc: locOf(stmt) };
        L.ctx.inferReturn.entries.push({ stmt: rec, node: stmt.expression ?? null });
        return rec;
      }
      // A bare `return;` in a union-returning function yields undefined
      // (JS), which the undefined arm carries — tsc only allows the bare
      // form when the return type includes undefined/void. A CHECKED-
      // DYNAMIC return slot holds the dyn undefined directly (the
      // appendImplicitUndefinedReturn rule). What remains is JS-only —
      // a JSDoc return claim the body contradicts (ms's parse: `@return
      // {Number}` with a bare early `return;`): no undefined fits the
      // declared representation, so the statement fences honestly (the
      // per-statement JS deferral — the claimed paths still run) instead
      // of slipping an empty return past the validator.
      let value: IrExpr | null = null;
      if (stmt.expression) {
        return L.lowerReturnStmt(stmt.expression, locOf(stmt));
      } else if (L.ctx.returnType.kind === "union") {
        value = L.wrappedUndefined(L.ctx.returnType, locOf(stmt));
        if (value === null) {
          L.unsupported(
            "SC1090",
            stmt,
            `bare 'return' where the declared return type is '${L.fmt(L.ctx.returnType)}' (JS hands the caller undefined, which this representation cannot hold — return a value, or widen the declared return type with undefined)`,
          );
        }
      } else if (L.ctx.returnType.kind === "dyn") {
        value = dynUndefinedExpr(locOf(stmt));
      } else if (L.ctx.returnType.kind !== "void") {
        L.unsupported(
          "SC1090",
          stmt,
          `bare 'return' where the declared return type is '${L.fmt(L.ctx.returnType)}' (JS hands the caller undefined, which this representation cannot hold — return a value, or widen the declared return type with undefined)`,
        );
      }
      return { kind: "return", value, loc: locOf(stmt) };
    }
    if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
      const kw = ts.isBreakStatement(stmt) ? ("break" as const) : ("continue" as const);
      if (stmt.label) {
        // tsc already validated the label RESOLVES (a matching enclosing
        // labeled statement exists; continue's target is a loop). What can
        // still be missing is OUR side: a labeled statement whose lowering
        // is a desugar that doesn't carry labels (the exotic for-of
        // desugars) never registered them in ctl — fence by name there
        // rather than compile the jump against the wrong target.
        const label = stmt.label.text;
        const target = [...L.ctx.ctl].reverse().find((c) => c.labels?.includes(label));
        if (!target || (kw === "continue" && target.kind !== "loop")) {
          L.unsupported(
            "SC1050",
            stmt,
            `'${kw} ${label}' targeting this statement form (the labeled statement lowers through a desugar that has no label point)`,
          );
        }
        L.rejectJumpCrossingFinally(kw, stmt, label);
        return { kind: kw, label, loc: locOf(stmt) };
      }
      L.rejectJumpCrossingFinally(kw, stmt);
      // tsc rejects break outside loops/switches and continue outside loops,
      // so the context is always valid here (the validator re-checks).
      return { kind: kw, loc: locOf(stmt) };
    }
    if (ts.isThrowStatement(stmt)) {
      // `throw e` of a catch binding is a RETHROW: the saved exception is
      // re-raised exactly (kind and payload preserved), whatever the
      // checker narrowed e to at this point (same value either way, and
      // the snapshot keeps un-narrowed rethrows working).
      const caughtLocal = L.caughtLocalOf(stmt.expression);
      if (caughtLocal) {
        return { kind: "rethrow", localId: caughtLocal.id, loc: locOf(stmt) };
      }
      // Exception-representable values move into the runtime's exception
      // cell. `throw f()` of a void call has no value; Date has numeric
      // storage internally, but cannot preserve its object kind through the
      // untyped catch boundary. Reject both rather than changing JS identity.
      const value = L.lowerExpr(stmt.expression);
      if (value.type.kind === "void") L.badType(stmt.expression, L.typeOf(stmt.expression));
      if (value.type.kind === "date") {
        L.unsupported(
          "SC1090",
          stmt.expression,
          "throwing Date values (catch bindings cannot preserve Date's object kind; throw an Error or primitive instead)",
        );
      }
      // A dyn throw rides the REF cell arm (scr_throw_ref over the checked-dynamic tree
      // node — identity preserved through catch bindings, caughtToDyn
      // passes it back by reference). The JS-lane traced-call shape:
      // `throw err` where err arrived as a dyn argument. instanceof
      // narrowing over the payload stays false (the checked-dynamic tree's %error encoding
      // is not a hierarchy object — SEMANTICS.md).
      return { kind: "throw", value, loc: locOf(stmt) };
    }
    if (ts.isTryStatement(stmt)) return L.lowerTry(stmt);
    if (ts.isBlock(stmt)) {
      return { kind: "block", body: L.lowerScopedBlock(stmt), loc: locOf(stmt) };
    }
    if (ts.isEmptyStatement(stmt)) return null;
    // Type-world declarations in statement position (an interface/alias
    // inside a block or function — the top-level ones never reach
    // lowerStmt): no runtime artifact; shapes intern on demand at use
    // sites through mapType.
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) return null;
    // `export = x` — the CommonJS export-assignment form (tsc only accepts
    // it in CJS-shaped modules/.d.ts): named, not the generic syntax
    // fence.
    if (ts.isExportAssignment(stmt) && stmt.isExportEquals) {
      L.unsupported(
        "SC1090",
        stmt,
        "'export =' assignments (use named ESM exports: export function f() {} / export const x = ...)",
      );
    }
    // A body-less nested declaration is an OVERLOAD SIGNATURE (nested
    // `declare` is a parse error, so nothing else is body-less here):
    // type-world, lowers to nothing — the implementation's statement
    // declares the local, and calls flow through its ABI.
    if (ts.isFunctionDeclaration(stmt) && !stmt.body) return null;
    if (ts.isFunctionDeclaration(stmt)) {
      // Already lowered eagerly by the forward-hoisting machinery
      // (predeclareForwardFnDecl) — the varDecl is in the list's output.
      if (L.hoistedFnDecls.has(stmt)) return null;
      return L.lowerNestedFunctionDecl(stmt);
    }
    // Enum declarations: constant-member enums emit nothing (member reads
    // fold at their sites); computed members fence — see lower-enums.ts.
    if (ts.isEnumDeclaration(stmt)) return lowerEnumDeclaration(L, stmt);

    if (ts.isForInStatement(stmt)) return lowerForIn(L, stmt);

    // `import a = A` / `export import a = N.y` (entity form): pure alias
    // plumbing — references resolve through the checker; the require form
    // and mutable-target aliases fence (lower-namespaces.ts).
    if (ts.isImportEqualsDeclaration(stmt)) return lowerImportEquals(L, stmt);

    const entry = UNSUPPORTED_STMT[stmt.kind];
    if (entry) L.unsupported(entry.code as `SC${number}` & keyof typeof UNSUPPORTED, stmt, entry.feature);
    L.unsupported("SC1090", stmt, `syntax '${ts.SyntaxKind[stmt.kind]}'`);
  }

/** A variable statement may carry several declarators (`let a = 1,
   * b = a + 1;`): each lowers to its own varDecl IN ORDER, so later
   * initializers see earlier bindings (JS-exact). `var` declarators ride
   * the same path — their "declaration" is an assignment into the
   * function-scoped hoisted slot (hoistVarBinding), so the mutability flag
   * passed down covers let AND var. */
  export function lowerVarStatement(L: Lowerer, stmt: ts.VariableStatement): IrStmt[] {
    const list = stmt.declarationList;
    if ((list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.BlockScoped) === 0;
    return list.declarations.flatMap((decl) => {
      // CommonJS require declarations (JS files): at the module's top
      // level the BINDINGS are alias plumbing (no storage;
      // resolveValueSymbol routes the reads), but the require itself is
      // Node's inline module evaluation — a relative require lowers to the
      // required module's guarded %init call at exactly this position
      // (first require runs the body, later ones are cache hits; builtins
      // load nothing). Binding requires anywhere else would need lazily-
      // initialized alias storage this model doesn't represent; named
      // fence.
      if (
        decl.initializer !== undefined &&
        requireSpecOf(decl.initializer) !== null &&
        isJsSourceFile(decl.getSourceFile())
      ) {
        const spec = requireSpecOf(decl.initializer)!;
        if (L.externalTypes.has(spec)) L.externalHostFence(spec, decl, false);
        if (ts.isSourceFile(stmt.parent)) {
          const init = L.requireInitStmt(spec, decl);
          return init ? [init] : [];
        }
        // A nested BUILTIN require (`get inFreeBSDJail() { const { execSync }
        // = require('child_process'); ... }` — test/common's lazy-getter
        // idiom): builtins load nothing, so the statement is PURE alias
        // plumbing wherever it sits — the bindings resolve through the
        // same routing top-level requires use, and no statement remains.
        // Relative requires keep the fence: their module-init-at-position
        // semantics needs storage this model doesn't represent.
        if (canonicalBuiltinModule(spec) !== null) {
          return [];
        }
        L.unsupported(
          "SC1090",
          decl,
          "require() with bindings outside the module's top level (move it to the top of the file)",
        );
      }
      // `const { NGHTTP2_CANCEL } = http2.constants` — a destructure over
      // the baked constants table: alias plumbing, no storage (uses read
      // their literals via builtinConstantBindingOf; collectGlobals skipped
      // the globals by the same test).
      if (L.builtinConstantsDestructureDecl(decl.name, decl.initializer)) return [];
      if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
        // `const { createSign } = crypto` over a builtin NAMESPACE binding:
        // alias plumbing (builtinImportOf routes the reads) — no statement.
        if (builtinNamespaceDestructureModuleOf(L, decl) !== null) return [];
        return L.lowerDestructuringDecl(decl, isLet);
      }
      // STORED protocol values with statically closed representations:
      // numeric value iterators retain source/cursor/done hidden locals; a
      // matchAll drain retains its companion index array so a later
      // for-of can serve `m.index`. Both are const-only interceptions.
      const numericIterator = lowerNumericIteratorDecl(L, decl, isConst);
      if (numericIterator) return numericIterator;
      const drained = lowerMatchAllDrainDecl(L, decl, isConst);
      if (drained) return drained;
      const lowered = L.lowerVarDecl(decl, isLet);
      return lowered ? [lowered] : [];
    });
  }

/** The numeric indexed source of a built-in value-iterator expression:
   * `numbers.values()` or the equivalent
   * `numbers[Symbol.iterator]()`, where numbers is number[] or one of the
   * represented typed arrays (including Uint8Array). This is deliberately
   * a syntax + provenance test rather than a mapping for the iterator
   * object: it has observable mutable protocol state, represented by
   * hidden locals only while a stored binding stays in one function. */
  export function numericIteratorSourceOf(L: Lowerer, expr: ts.Expression | undefined): ts.Expression | null {
    if (expr === undefined) return null;
    let init = expr;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (!ts.isCallExpression(init) || init.questionDotToken || init.arguments.length !== 0) return null;

    let receiver: ts.Expression | null = null;
    if (
      ts.isPropertyAccessExpression(init.expression) &&
      !init.expression.questionDotToken &&
      init.expression.name.text === "values" &&
      L.isStdlibMember(init.expression)
    ) {
      receiver = init.expression.expression;
    } else if (
      ts.isElementAccessExpression(init.expression) &&
      !init.expression.questionDotToken &&
      init.expression.argumentExpression !== undefined
    ) {
      let key = init.expression.argumentExpression;
      while (ts.isParenthesizedExpression(key)) key = key.expression;
      if (
        ts.isPropertyAccessExpression(key) &&
        L.stdlibGlobalMember(key, "Symbol") === "iterator"
      ) {
        receiver = init.expression.expression;
      }
    }
    if (receiver === null) return null;
    const sourceT = L.mapTypeOf(L.typeOf(receiver));
    return (
      (sourceT?.kind === "array" && sourceT.elem.kind === "f64") ||
      sourceT?.kind === "bytes"
    ) ? receiver : null;
  }

/** A stored numeric value iterator does not become a first-class IR
   * value. Its standard-library provenance proves the built-in iterator
   * shape, so the declaration snapshots the indexed source and initializes
   * the exact mutable protocol state:
   *
   *   const %source = numbers; let %index = 0; let %done = false;
   *
   * A same-function for-of resolves the binding symbol through
   * numericIterators and drives these locals. Other value uses retain the
   * iterator-object fence. */
  function lowerNumericIteratorDecl(
    L: Lowerer,
    decl: ts.VariableDeclaration,
    isConst: boolean,
  ): IrStmt[] | null {
    if (!isConst || !ts.isIdentifier(decl.name)) return null;
    const sourceNode = numericIteratorSourceOf(L, decl.initializer);
    if (sourceNode === null) return null;
    const sym = L.checker.getSymbolAtLocation(decl.name);
    if (!sym || L.tdzPredeclared.has(sym)) return null;
    const source = L.lowerExpr(sourceNode);
    if (
      !(
        (source.type.kind === "array" && source.type.elem.kind === "f64") ||
        source.type.kind === "bytes"
      )
    ) {
      L.badType(sourceNode, L.typeOf(sourceNode));
    }
    const loc = locOf(decl);
    const indexedSource = L.declareHiddenLocal("%numiterSource", source.type);
    const index = L.declareHiddenLocal("%numiterIndex", F64);
    const done = L.declareHiddenLocal("%numiterDone", BOOL);
    index.mutable = true;
    done.mutable = true;
    L.numericIterators.set(sym, {
      sourceLocalId: indexedSource.id,
      sourceType: source.type,
      indexLocalId: index.id,
      doneLocalId: done.id,
      ctx: L.ctx,
    });
    return [
      { kind: "varDecl", localId: indexedSource.id, init: source, loc },
      { kind: "varDecl", localId: index.id, init: { kind: "numLit", value: 0, type: F64, loc }, loc },
      { kind: "varDecl", localId: done.id, init: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
    ];
  }

/** The stored-drain interception behind lowerVarStatement: lowers
   * `const rows = s.matchAll(re)` (a direct stdlib matchAll initializer on
   * a plain const identifier local) as the companion-index drain and
   * registers the binding symbol in matchAllDrainIndexes. Null when the
   * shape doesn't apply — the ordinary declaration path owns it. */
  function lowerMatchAllDrainDecl(L: Lowerer, decl: ts.VariableDeclaration, isConst: boolean): IrStmt[] | null {
    if (!isConst || !ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
    const call = directMatchAllCallOf(L, decl.initializer);
    if (!call) return null;
    const sym = L.checker.getSymbolAtLocation(decl.name);
    if (!sym || L.globalsBySymbol.has(sym) || L.tdzPredeclared.has(sym)) return null;
    const rowsT = arrayOf(arrayOf(STRING));
    const declared = L.mapTypeOf(L.typeOf(decl.name));
    if (!declared || !typeEquals(declared, rowsT)) return null;
    const loc = locOf(decl);
    const access = call.expression as ts.PropertyAccessExpression;
    const receiver = L.lowerExpr(access.expression);
    const re = L.lowerExpr(call.arguments[0]!);
    const idxsT = arrayOf(F64);
    const idxs = L.declareHiddenLocal("%midxs", idxsT);
    const local = L.declareLocal(decl.name, decl.name.text, rowsT, false);
    L.matchAllDrainIndexes.set(sym, { idxsLocalId: idxs.id, ctx: L.ctx });
    return [
      { kind: "varDecl", localId: idxs.id, init: { kind: "arrayLit", elems: [], type: idxsT, loc }, loc },
      {
        kind: "varDecl",
        localId: local.id,
        init: {
          kind: "regexIntrinsic",
          method: "matchAllInto",
          receiver,
          args: [re, { kind: "varRef", localId: idxs.id, type: idxsT, loc }],
          type: rowsT,
          loc,
        },
        loc,
      },
    ];
  }

/** Whether a checker type belongs to node:util.parseArgs's dyn-backed
 * declaration family. Module ancestry disambiguates short private helper
 * names such as `Token` from names in other standard-library modules. */
export function isParseArgsDynCheckerType(L: Lowerer, type: ts.Type): boolean {
  const widened = L.checker.getBaseTypeOfLiteralType(type);
  const declarationBelongs = (d: ts.Node): boolean => {
    if (!L.isStdlibFile(d.getSourceFile())) return false;
    let inParseArgsType = false;
    for (let node: ts.Node | undefined = d.parent; node; node = node.parent) {
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        isParseArgsDynTypeName(node.name.text)
      ) {
        inParseArgsType = true;
      }
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        return inParseArgsType && (node.name.text === "util" || node.name.text === "node:util");
      }
    }
    return false;
  };
  const sym = widened.getAliasSymbol() ?? widened.getSymbol();
  if (
    sym && isParseArgsDynTypeName(sym.name) &&
    L.checker.declarationsOf(sym).some(declarationBelongs)
  ) {
    return true;
  }
  // A discriminant check erases the token alias and leaves one anonymous
  // object arm. Its properties still point into the parseArgs alias, which
  // is the same stable signal the dotted-member bridge uses.
  return L.checker.getPropertiesOfType(widened).some((p) =>
    L.checker.declarationsOf(p).some(declarationBelongs),
  );
}

/** Destructuring declarations, desugared as sugar over indexed/field
   * reads: the initializer evaluates ONCE into a hidden temp, then each
   * bound name declares (or assigns its pre-registered module global) from
   * a read of that temp — `const [a, b] = arr` reads indices 0 and 1,
   * `const { x, y: z } = rec` reads the fields, nested patterns recurse
   * through their own temps. Sources are arrays and records; array reads
   * inherit the array divergence (a pattern longer than the array traps
   * where JS binds undefined). Defaults, rest elements, and computed keys
   * are fenced — each would need machinery beyond a read (an undefined
   * test, surplus packing, dynamic lookup). */
  export function lowerDestructuringDecl(L: Lowerer, decl: ts.VariableDeclaration, isLet: boolean): IrStmt[] {
    const loc = locOf(decl);
    if (!decl.initializer) {
      // tsc already rejects this (TS1182); defensive.
      L.unsupported("SC1031", decl);
    }
    // A STDLIB-GLOBAL source in a JavaScript file (`const { subtle } =
    // globalThis.crypto`, `const { Console } = console` — the suite's
    // webcrypto/console prologues): each element binds a member IDENTITY
    // TOKEN, the identifier chokepoint's rule one member deep — see
    // stdlibGlobalTokenDestructure. Checked before the initializer
    // lowers: the whole-global spelling would answer the global's own
    // token (a string), and the pattern would meet the string fences
    // below blaming the token's carrier type instead of the global.
    {
      const tokenBound = stdlibGlobalTokenDestructure(L, decl, isLet);
      if (tokenBound !== null) return tokenBound;
    }
    let init = L.lowerExpr(decl.initializer);
    const parseArgsDynObject =
      init.type.kind === "dyn" && isParseArgsDynCheckerType(L, L.typeOf(decl.initializer));
    // A TS `any`-origin source whose lowered value is NOT a destructurable
    // shape (`var { x } = <any>0` — the cast erases to the f64; a dyn
    // value — the checked-dynamic tree has no destructure): JS reads the properties off
    // whatever the value is (a number answers undefined) — engine
    // semantics, the dynamic-family fence. Record and array sources fall
    // through to their lowerings, island handles to theirs (--dynamic
    // owns this construct), and JS files keep their per-site runtime
    // fences unchanged.
    if (
      L.anyOrigin(decl.initializer) &&
      !isJsSourceFile(decl.getSourceFile()) &&
      init.type.kind !== "record" && init.type.kind !== "array" && init.type.kind !== "jsval"
    ) {
      L.anyOpFence("destructuring", decl);
    }
    // An IR-string source the CHECKER does not type as a string is a
    // builtin identity token that leaked through a JS local (`const c =
    // globalThis.crypto; const { x } = c` — the local adopted the token's
    // carrier type): the value is a token, not a string — the string
    // lowerings below would read the CARRIER (its length, its code
    // points), numbers and characters Node never sees. The fence names
    // the checker's own type instead of the carrier.
    if (
      init.type.kind === "string" &&
      isJsSourceFile(decl.getSourceFile()) &&
      !checkerStringSource(L, decl.initializer)
    ) {
      L.unsupported(
        "SC1031",
        decl.name,
        ts.isArrayBindingPattern(decl.name)
          ? `array destructuring of non-array values (the source is '${L.checker.typeToString(L.typeOf(decl.initializer))}'-typed)`
          : `object destructuring of non-record values (the source is '${L.checker.typeToString(L.typeOf(decl.initializer))}'-typed)`,
      );
    }
    // PRIMITIVE and unit sources (`let { toString } = 1`, `const [c] =
    // "xy"`, `var [] = null`): JS destructures any value by reading
    // through its wrapper object — prototype members included — or throws
    // its TypeError on null/undefined; both live in the engine. When the
    // pattern has an engine form, --dynamic marshals the value in and
    // runs the REAL pattern (lowerJsvalBindingPattern); a static build
    // reports the dynamic-family choice instead of the dead-end type
    // recitation. STRING sources whose pattern the static path claims
    // whole (staticStringPattern — code-point positions, `length`
    // bindings) skip the gate in STATIC builds: lowerBindingPattern's
    // string branches are exact there, and the diagnostic would report a
    // dynamic-engine dependency the program does not have. --dynamic
    // keeps the engine route for every string pattern — the engine binds
    // undefined past the last code point where the static chars array
    // inherits the array divergence's trap.
    if (
      (init.type.kind === "f64" || init.type.kind === "bool" || init.type.kind === "string" || isUnitType(init.type)) &&
      !isJsSourceFile(decl.getSourceFile()) &&
      !(!L.dynamic && init.type.kind === "string" &&
        staticStringPattern(L, decl.name as ts.ArrayBindingPattern | ts.ObjectBindingPattern)) &&
      enginePatternSpec(L, decl.name as ts.ArrayBindingPattern | ts.ObjectBindingPattern) !== null
    ) {
      if (!L.dynamic) {
        L.pushDiag(requiresDynamicDiag(
          `destructuring '${L.fmt(init.type)}' values (the engine reads through JS's wrapper coercion)`,
          locOf(decl),
        ));
        throw new PoisonError();
      }
      init = L.coerceToExpected(init, JSVAL);
    }
    const out: IrStmt[] = [];
    // JS: a union source with exactly ONE destructurable arm beside unit
    // arms (`nameAndArgs.match(re)` — `RegExpMatchArray | null`, the
    // always-matches idiom) destructures through a VALIDATED narrow: the
    // unit arms throw at runtime exactly where Node's TypeError would
    // (the message is the fence's — a unit value here is the failure
    // path either way). TypeScript keeps the fence: narrowing first is
    // the annotated fix.
    if (isJsSourceFile(decl.getSourceFile()) && init.type.kind === "union") {
      const def = L.unions.get(init.type.unionId);
      const dataArms = (def?.arms ?? []).filter((a) => !isUnitType(a));
      const arm = dataArms[0];
      if (
        def !== undefined && dataArms.length === 1 && arm !== undefined &&
        def.arms.every((a) => a === arm || isUnitType(a)) &&
        (arm.kind === "array" || arm.kind === "record")
      ) {
        const tag = def.arms.indexOf(arm);
        const utmp = L.declareHiddenLocal("%destrU", init.type);
        out.push({ kind: "varDecl", localId: utmp.id, init, loc });
        const uref: IrExpr = { kind: "varRef", localId: utmp.id, type: init.type, loc };
        out.push({
          kind: "if",
          cond: { kind: "unionIsTag", unionId: init.type.unionId, tag, negated: true, value: uref, type: BOOL, loc },
          then: [{
            kind: "runtimeFence",
            code: "SC1031",
            message: `destructuring a null/undefined value (Node throws TypeError here)`,
            loc,
          }],
          else_: null,
          loc,
        });
        init = { kind: "unionNarrow", unionId: init.type.unionId, tag, value: uref, type: arm, loc };
      }
    }
    // `const { groups } = re.exec(s)!` / `const { groups: { year } } = m`
    // — every pattern element binds `groups` off a MATCH SLICE whose
    // regex is statically known: the slice has no record shape of its
    // own, so the groups projection (lowerGroupsProjection — the same
    // record `m.groups` reads produce) wraps one level in a synthesized
    // `{ groups: ... }` record and the ordinary record destructure below
    // serves the pattern — aliases and nested patterns included. Only
    // named-group regexes take the wrap: a group-less regex destructures
    // `groups: undefined` in Node (a nested pattern then throws), which
    // the fence reports honestly instead.
    if (
      ts.isObjectBindingPattern(decl.name) &&
      decl.name.elements.length > 0 &&
      isMatchSliceType(L, init.type) &&
      decl.name.elements.every((el) => {
        if (el.dotDotDotToken !== undefined || el.name === undefined) return false;
        const prop = el.propertyName;
        if (prop === undefined) return ts.isIdentifier(el.name) && el.name.text === "groups";
        return (ts.isIdentifier(prop) || ts.isStringLiteral(prop)) && prop.text === "groups";
      })
    ) {
      const groups = matchResultNamedGroupsOf(L, decl.initializer!);
      if (groups !== null && groups.length > 0) {
        const proj = lowerGroupsProjection(L, init, groups, loc);
        const outerShape = L.shapes.intern(
          [{ name: "groups", type: proj.type }],
          false,
          undefined,
          ["groups"],
        );
        init = {
          kind: "recordLit",
          fields: [{ name: "groups", value: proj }],
          type: { kind: "record", shapeId: outerShape },
          loc,
        };
      }
    }
    const tmp = L.declareHiddenLocal("%destr", init.type);
    out.push({ kind: "varDecl", localId: tmp.id, init, loc });
    // V8's destructuring TypeError spells STATIC sources: an identifier
    // source reads "<name> is not iterable", an identifier-callee call
    // "<name> is not a function or its return value is not iterable";
    // everything else (property reads, method calls, parameters) gets the
    // runtime kind wording — exactly V8's CallPrinter behavior. Only the
    // DYN pattern arm consumes this.
    const src = decl.initializer!;
    const dynSpell = ts.isIdentifier(src)
      ? `${src.text} is not iterable`
      : ts.isCallExpression(src) && ts.isIdentifier(src.expression)
        ? `${src.expression.text} is not a function or its return value is not iterable`
        : undefined;
    L.lowerBindingPattern(
      decl.name as ts.ArrayBindingPattern | ts.ObjectBindingPattern,
      () => ({ kind: "varRef", localId: tmp.id, type: init.type, loc }),
      init.type,
      isLet,
      out,
      dynSpell,
      parseArgsDynObject,
    );
    return out;
  }

/** One pattern level: emits a declaration (or global assignment) per
   * bound name, recursing through hidden temps for nested patterns. */
  export function lowerBindingPattern(L: Lowerer, pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern,
    srcRef: () => IrExpr,
    srcType: IrType,
    isLet: boolean,
    out: IrStmt[],
    dynSpell?: string,
    allowDynObject = false,): void {
    if (ts.isArrayBindingPattern(pattern)) {
      L.fenceStaticHeadersIteration(pattern);
      // Tuple sources: each position is a field read of the tuple's record
      // shape — the positional twin of object destructuring below.
      const tupleShape =
        srcType.kind === "record" ? L.shapes.get(srcType.shapeId) : undefined;
      if (srcType.kind === "record" && tupleShape?.tuple) {
        pattern.elements.forEach((el, i) => {
          // Holes: OmittedExpression in 5.9.3, a nameless BindingElement in
          // 7 (parity finding 2) — either way the position is skipped.
          if (ts.isOmittedExpression(el) || el.name === undefined) return;
          const loc = locOf(el);
          if (el.dotDotDotToken) {
            // `[head, ...rest]` over a TUPLE: the tail packs FRESH under
            // the checker's own rest type — a tuple record of the
            // remaining positions, or an array when the checker widens
            // them. JS's surplus packing is a fresh array too, so mutation
            // through the rest binding never reaches the source; nested
            // rest patterns (`[...[a, b]]`) destructure the packed tail.
            L.bindPatternTarget(el.name, tupleRestValue(L, el, srcRef, srcType, tupleShape, i), isLet, out);
            return;
          }
          const fieldType = tupleShape.fields.find((f) => f.name === String(i))?.type;
          if (!fieldType) {
            // tsc rejects patterns longer than the tuple; `as` smuggling
            // lands here — except a DEFAULTED position, where tsc types
            // the binding from the default and JS always takes it (the
            // read past the tuple is undefined).
            if (el.initializer) {
              const bodyT = patternBindingType(L, el.name);
              if (bodyT && bodyT.kind !== "void") {
                L.bindPatternTarget(el.name, L.lowerExprExpecting(el.initializer, bodyT), isLet, out);
                return;
              }
            }
            L.unsupported("SC1031", el, "destructuring past the end of a tuple");
          }
          let value: IrExpr = {
            kind: "recordGet",
            obj: srcRef(),
            shapeId: srcType.shapeId,
            field: String(i),
            type: fieldType,
            loc,
          };
          // Tuple positions always exist, so the default fires exactly
          // when the position holds the undefined arm (JS's rule — null
          // never triggers it); on positions with no undefined arm the
          // default is dead code and never evaluates, exactly JS.
          if (el.initializer) value = applyBindingDefault(L, el, value);
          L.bindPatternTarget(el.name, value, isLet, out);
        });
        return;
      }
      // Class iterables (`var [a, b] = new SymbolIterator`): one protocol
      // step per pattern position, in order — holes consume a step too,
      // exactly JS. The value field binds WITHOUT a done test: a position
      // past a TERMINATING iterator's end binds the final result's value
      // where Node binds undefined (numbered divergence — the corpus
      // shape, `done: false` self-iterators, never terminates).
      {
        const citPat = L.classIteratorOf(srcType);
        if (citPat) {
          const loc = locOf(pattern);
          const it = L.declareHiddenLocal("%dit", citPat.iterT);
          out.push({ kind: "varDecl", localId: it.id, init: L.classIteratorOpenCall(citPat, srcRef(), loc), loc });
          const itRef = (): IrExpr => ({ kind: "varRef", localId: it.id, type: citPat.iterT, loc });
          for (const el of pattern.elements) {
            const stepLoc = locOf(el);
            const step = L.classIteratorNextCall(citPat, itRef(), stepLoc);
            if (ts.isOmittedExpression(el) || el.name === undefined) {
              out.push({ kind: "exprStmt", expr: step, loc: stepLoc });
              continue;
            }
            if (el.dotDotDotToken) {
              // `[a, ...rest]`: the tail drains whatever the OPEN iterator
              // still yields — a fresh array, JS's surplus packing.
              L.bindPatternTarget(el.name, L.classIteratorRestDrainCall(citPat, itRef(), stepLoc), isLet, out);
              continue;
            }
            if (el.initializer) {
              L.unsupported("SC1031", el, "binding defaults over class iterables");
            }
            const rl = L.declareHiddenLocal("%dir", citPat.resultT);
            out.push({ kind: "varDecl", localId: rl.id, init: step, loc: stepLoc });
            const value: IrExpr = {
              kind: "recordGet",
              obj: { kind: "varRef", localId: rl.id, type: citPat.resultT, loc: stepLoc },
              shapeId: citPat.resultT.shapeId,
              field: "value",
              type: citPat.valueT,
              loc: stepLoc,
            };
            L.bindPatternTarget(el.name, value, isLet, out);
          }
          return;
        }
      }
      // STRING sources (`const [a, b] = str`): array destructuring walks
      // the STRING ITERATOR — code points, astral characters whole —
      // which is Array.from(string)'s own machinery (%str.chars), so the
      // source splits once into a hidden chars array and the pattern
      // lowers as an array pattern over string[]. Positions, holes,
      // defaults (with the bounds test), rest (the remaining code points
      // pack fresh — JS's surplus packing builds a new array too), and
      // nested patterns all ride the array machinery below — which also
      // means a position past the LAST code point inherits the array
      // divergence (the read traps where JS binds undefined; a DEFAULTED
      // position carries its bounds test and fires exactly there).
      // Callers vetted the source as a checker-typed string: builtin
      // identity tokens (IR strings the checker types otherwise) fence
      // before reaching here.
      if (srcType.kind === "string") {
        const loc = locOf(pattern);
        const charsT = arrayOf(STRING);
        const chars = L.declareHiddenLocal("%dchars", charsT);
        out.push({ kind: "varDecl", localId: chars.id, init: strCharsCall(L, srcRef(), loc), loc });
        L.lowerBindingPattern(
          pattern,
          () => ({ kind: "varRef", localId: chars.id, type: charsT, loc }),
          charsT,
          isLet,
          out,
        );
        return;
      }
      // DYN sources (`const [a, b] = d` over a dyn value, `([_, code]) =>`
      // params destructuring dyn callback arguments — the suite harness's
      // _expectWarning shapes): the source packs ONCE through the spread
      // walk (dyn.iterPack — arrays element-by-element, strings by code
      // point, bytes by byte; every other kind throws V8's destructuring
      // TypeError, the compile-time spelling when the source has one),
      // then positions bind the pack's index keys as dyn values — reads
      // past the end bind undefined, exactly JS. Defaults fire on the checked-dynamic tree
      // undefined (JS's rule); rest elements keep the fence (surplus
      // packing over the checked-dynamic tree needs a slice the IR does not spell yet).
      if (srcType.kind === "dyn") {
        const loc = locOf(pattern);
        const pack = L.declareHiddenLocal("%dpack", DYN);
        out.push({
          kind: "varDecl",
          localId: pack.id,
          init: {
            kind: "libCall",
            fn: "dyn.iterPack",
            args: [srcRef(), { kind: "strLit", value: dynSpell ?? "", type: STRING, loc }],
            type: DYN,
            loc,
          },
          loc,
        });
        pattern.elements.forEach((el, i) => {
          if (ts.isOmittedExpression(el) || el.name === undefined) return; // hole: the position skips
          const elLoc = locOf(el);
          if (el.dotDotDotToken) {
            L.unsupported("SC1031", el, "rest elements over checked-dynamic sources");
          }
          let value: IrExpr = {
            kind: "dynKeyGet",
            key: { kind: "strLit", value: String(i), type: STRING, loc: elLoc },
            value: { kind: "varRef", localId: pack.id, type: DYN, loc: elLoc },
            type: DYN,
            loc: elLoc,
          };
          if (el.initializer) {
            // The default fires exactly on the dyn undefined (JS's rule),
            // its value converting into the checked-dynamic tree like any dyn-slot value.
            const rl = L.declareHiddenLocal("%delem", DYN);
            out.push({ kind: "varDecl", localId: rl.id, init: value, loc: elLoc });
            const ref = (): IrExpr => ({ kind: "varRef", localId: rl.id, type: DYN, loc: elLoc });
            const dflt = L.coerceToExpected(L.lowerExpr(el.initializer), DYN);
            if (dflt.type.kind !== "dyn") {
              L.unsupported(
                "SC1031",
                el.initializer,
                `defaults of '${L.fmt(dflt.type)}' type over checked-dynamic sources (the value cannot convert into the checked-dynamic tree)`,
              );
            }
            value = {
              kind: "ternary",
              cond: { kind: "dynTest", test: "undefined", value: ref(), type: BOOL, loc: elLoc },
              then: dflt,
              else_: ref(),
              type: DYN,
              loc: elLoc,
            };
          }
          L.bindPatternTarget(el.name, value, isLet, out);
        });
        return;
      }
      // Represented typed arrays are dense numeric iterables. Destructuring
      // reads their elements in index order; a rest binding drains to a
      // fresh number[] (never another typed array), exactly the iterator
      // protocol's Array accumulation.
      if (srcType.kind === "bytes") {
        pattern.elements.forEach((el, i) => {
          if (ts.isOmittedExpression(el) || el.name === undefined) return;
          const loc = locOf(el);
          if (el.dotDotDotToken) {
            if (el.initializer) {
              L.unsupported("SC1031", el, "defaults on rest elements");
            }
            const all: IrExpr = {
              kind: "bytesIntrinsic",
              method: "toArray",
              receiver: srcRef(),
              args: [],
              type: arrayOf(F64),
              loc,
            };
            const value: IrExpr = {
              kind: "arrIntrinsic",
              method: "slice",
              receiver: all,
              args: [{ kind: "numLit", value: i, type: F64, loc }],
              type: arrayOf(F64),
              loc,
            };
            L.bindPatternTarget(el.name, value, isLet, out);
            return;
          }
          let value: IrExpr = {
            kind: "bytesIntrinsic",
            method: "get",
            receiver: srcRef(),
            args: [{ kind: "numLit", value: i, type: F64, loc }],
            type: F64,
            loc,
          };
          if (el.initializer) {
            value = arrayPositionDefault(
              L,
              el,
              value,
              srcRef,
              i,
              F64,
              out,
            );
          }
          L.bindPatternTarget(el.name, value, isLet, out);
        });
        return;
      }
      if (srcType.kind !== "array") {
        L.unsupported(
          "SC1031",
          pattern,
          `array destructuring of non-array values (the source is ${srcType.kind}-typed)`,
        );
      }
      pattern.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el) || el.name === undefined) return; // hole: position skipped, like JS over an array
        const loc = locOf(el);
        // `[current, ...rest]` over an ARRAY source: the rest binds a
        // fresh tail copy — `arr.slice(i)`, exactly the JS surplus packing
        // (tsc pins rest to the last position; an empty tail is `[]`) —
        // and a NESTED rest pattern (`[...[a, b]]`) destructures the copy.
        if (el.dotDotDotToken) {
          if (el.initializer) {
            L.unsupported("SC1031", el, "defaults on rest elements"); // tsc rejects; defensive
          }
          const value: IrExpr = {
            kind: "arrIntrinsic",
            method: "slice",
            receiver: srcRef(),
            args: [{ kind: "numLit", value: i, type: F64, loc }],
            type: srcType,
            loc,
          };
          L.bindPatternTarget(el.name, value, isLet, out);
          return;
        }
        let value: IrExpr = {
          kind: "arrayGet",
          arr: srcRef(),
          index: { kind: "numLit", value: i, type: F64, loc },
          type: srcType.elem,
          loc,
        };
        // An array position may also sit PAST THE END — JS reads undefined
        // there and the default fires, where scriptc's plain array read
        // traps — so a defaulted position carries its own bounds test.
        if (el.initializer) {
          value = arrayPositionDefault(L, el, value, srcRef, i, srcType.elem, out);
        }
        L.bindPatternTarget(el.name, value, isLet, out);
      });
      return;
    }
    if (pattern.elements.length === 0) {
      // `var {} = e`, `for (const {} of ns)`: RequireObjectCoercible and
      // nothing else — a pure no-op past the source's own evaluation for
      // every statically non-nullish kind, record or not (the assignment
      // path's rule); possibly-nullish sources would throw in JS and keep
      // a fence.
      if (
        isUnitType(srcType) ||
        (srcType.kind === "union" && (L.unions.get(srcType.unionId)?.arms.some(isUnitType) ?? true))
      ) {
        L.unsupported(
          "SC1031",
          pattern,
          "empty-pattern destructuring from a possibly-nullish source (JS throws TypeError when it is null/undefined at runtime — narrow first)",
        );
      }
      return;
    }
    // A CHECKED-DYNAMIC source in a JavaScript file (`const { x } = anyValue`
    // — the Node-suite subscriber-payload idiom): each element is the
    // per-site dyn member read (dynKeyGet — Node's TypeError on a nullish
    // source, the undefined answer for absent members), with the JS
    // default applied exactly when the read answers undefined (lazily,
    // like a defaulted parameter). Bindings are dyn (the checker's `any`),
    // nested object patterns recurse through this same branch. TS files
    // keep the fence — annotations exist there. node:util.parseArgs is the
    // scoped TypeScript exception: its declared result/token types are
    // deliberately carried by the checked-dynamic tree, so their ordinary
    // object patterns use the same exact keyed-read desugar.
    if (
      srcType.kind === "dyn" &&
      (isJsSourceFile(pattern.getSourceFile()) || allowDynObject)
    ) {
      for (const el of pattern.elements) {
        if (el.name === undefined) continue;
        const loc = locOf(el);
        if (el.dotDotDotToken) {
          L.unsupported(
            "SC1031",
            el,
            "rest elements over checked-dynamic sources (the remaining-fields object has no lowering yet)",
          );
        }
        const prop = el.propertyName ?? el.name;
        const propName = ts.isIdentifier(prop) || ts.isComputedPropertyName(prop) || ts.isStringLiteralLike(prop) || ts.isNumericLiteral(prop)
          ? patternKeyNameOf(L, prop as ts.PropertyName)
          : null;
        if (propName === null) {
          L.unsupported("SC1031", el, "destructuring with computed keys that do not fold to one property name");
        }
        let value: IrExpr = {
          kind: "dynKeyGet",
          key: { kind: "strLit", value: propName, type: STRING, loc },
          value: srcRef(),
          type: DYN,
          loc,
        };
        if (el.initializer) {
          // The default fires exactly on the undefined read, evaluated
          // lazily (the ternary arm), like a defaulted dyn parameter.
          const readTmp = L.declareHiddenLocal("%destr", DYN);
          out.push({ kind: "varDecl", localId: readTmp.id, init: value, loc });
          const readRef: IrExpr = { kind: "varRef", localId: readTmp.id, type: DYN, loc };
          value = {
            kind: "ternary",
            cond: { kind: "dynTest", test: "undefined", value: readRef, type: BOOL, loc },
            then: L.coerceInto(el.initializer, L.lowerExpr(el.initializer), DYN),
            else_: readRef,
            type: DYN,
            loc,
          };
        }
        L.bindPatternTarget(el.name, value, isLet, out, allowDynObject);
      }
      return;
    }
    // A CLASS-INSTANCE source (`const { previous, next } = path` —
    // the path-walker idiom): the desugar IS JS's — one member read
    // per element, left to right, at the element's pattern position:
    // declared fields read their slots and accessor properties call
    // their getters through the same fieldGetExpr dispatch as dotted
    // reads (base-chain accessors and setter-only rejections resolve
    // identically). Rest elements, methods, and names no class on the
    // chain declares keep named fences (a detached method would lose its
    // receiver silently; JS binds the prototype function).
    if (srcType.kind === "object") {
      const info = L.classes.get(srcType.className);
      if (!info) L.flushDeferredClass(srcType.className);
      if (info) {
        for (const el of pattern.elements) {
          if (el.name === undefined) continue;
          const loc = locOf(el);
          if (el.dotDotDotToken) {
            // `{ a, ...rest }` over a class instance: the remaining
            // instance FIELDS pack fresh (classInstanceRestValue — JS's
            // CopyDataProperties copies own enumerable properties, which
            // for a class instance are exactly the fields).
            const consumed = new Set<string>();
            for (const sib of pattern.elements) {
              if (sib === el || sib.name === undefined || sib.dotDotDotToken) continue;
              const keyNode = sib.propertyName ?? (ts.isIdentifier(sib.name) ? sib.name : null);
              if (keyNode === null) continue; // defensive: a pattern target always carries a propertyName
              const folded = patternKeyNameOf(L, keyNode);
              if (folded === null) {
                L.unsupported("SC1031", el, "rest bindings beside computed keys (the consumed set is a runtime fact)");
              }
              consumed.add(folded);
            }
            L.bindPatternTarget(
              el.name,
              classInstanceRestValue(L, el, srcRef, srcType, info, consumed, patternBindingType(L, el.name)),
              isLet,
              out,
            );
            continue;
          }
          const prop = el.propertyName ?? el.name;
          const propName = ts.isIdentifier(prop) || ts.isComputedPropertyName(prop) || ts.isStringLiteralLike(prop) || ts.isNumericLiteral(prop)
            ? patternKeyNameOf(L, prop as ts.PropertyName)
            : null;
          if (propName === null) {
            L.unsupported("SC1031", el, "destructuring with computed keys that do not fold to one property name");
          }
          const fieldType = info.fields.get(propName);
          const getF = fieldType === undefined ? L.findMethodOn(info, `get:${propName}`) : null;
          const setF = fieldType === undefined ? L.findMethodOn(info, `set:${propName}`) : null;
          let value: IrExpr;
          if (fieldType !== undefined) {
            value = L.fieldGetExpr(
              { container: "class", obj: srcRef(), className: srcType.className, field: propName, fieldType },
              loc,
              el,
            );
          } else if (getF || setF) {
            value = L.fieldGetExpr(
              {
                container: "accessor",
                obj: srcRef(),
                className: srcType.className,
                field: propName,
                fieldType: getF ? getF.sig.ret : setF!.sig.params[0]!.type,
              },
              loc,
              el,
            );
            // A defaulted GETTER result lands in a hidden temp first: the
            // default's ternary mentions its operand twice (test + present
            // arm), and JS calls the getter once per element.
            if (el.initializer) {
              const got = L.declareHiddenLocal("%dget", value.type);
              out.push({ kind: "varDecl", localId: got.id, init: value, loc });
              value = { kind: "varRef", localId: got.id, type: value.type, loc };
            }
          } else {
            L.unsupported(
              "SC1031",
              el,
              L.findMethodOn(info, propName)
                ? `destructuring the method '${propName}' (a detached method loses its receiver — call it through the instance)`
                : `destructuring the property '${propName}' the class '${info.def.jsName ?? info.def.name}' does not declare`,
            );
          }
          if (el.initializer) value = applyBindingDefault(L, el, value);
          L.bindPatternTarget(el.name, value, isLet, out);
        }
        return;
      }
    }
    // A STRING source under an OBJECT pattern (`const { length } = str`):
    // JS reads through the wrapper object, whose one own DATA property is
    // `length` — the strLen intrinsic, exact, renames and (dead) defaults
    // included (length always exists and is never undefined, so a default
    // never evaluates — JS's rule). Everything else on the wrapper is a
    // prototype METHOD (detached, it loses its receiver) or absent (the
    // read is undefined, which the binding's type cannot hold) — named
    // fences either way; rest packs the wrapper's own INDICES (JS's
    // CopyDataProperties copies one property per code UNIT) and fences
    // naming that. Callers vetted the source as a checker-typed string —
    // builtin identity tokens fence before reaching here.
    if (srcType.kind === "string") {
      for (const el of pattern.elements) {
        if (el.name === undefined) continue;
        const loc = locOf(el);
        if (el.dotDotDotToken) {
          L.unsupported(
            "SC1031",
            el,
            "rest bindings over string sources (JS packs the wrapper's per-code-unit indices — split with [...s] instead)",
          );
        }
        const prop = el.propertyName ?? el.name;
        const propName = ts.isIdentifier(prop) || ts.isComputedPropertyName(prop) || ts.isStringLiteralLike(prop) || ts.isNumericLiteral(prop)
          ? patternKeyNameOf(L, prop as ts.PropertyName)
          : null;
        if (propName === null) {
          L.unsupported("SC1031", el, "destructuring with computed keys that do not fold to one property name");
        }
        if (propName !== "length") {
          L.unsupported(
            "SC1031",
            el,
            Object.hasOwn(STR_METHODS, propName)
              ? `destructuring the method '${propName}' of a string (a detached method loses its receiver — call it through the value)`
              : `destructuring the property '${propName}' strings do not carry as data ('length' is the one own data property)`,
          );
        }
        let value: IrExpr = { kind: "strIntrinsic", method: "length", receiver: srcRef(), args: [], type: F64, loc };
        if (el.initializer) value = applyBindingDefault(L, el, value);
        L.bindPatternTarget(el.name, value, isLet, out);
      }
      return;
    }
    if (srcType.kind !== "record") {
      L.unsupported(
        "SC1031",
        pattern,
        srcType.kind === "object"
          ? "object destructuring of class instances (read the fields directly — accessors make the desugar observable)"
          : `object destructuring of non-record values (the source is ${srcType.kind}-typed)`,
      );
    }
    const shape = L.shapes.get(srcType.shapeId);
    if (!shape) throw new Error(`lowerer bug: destructuring unknown shape ${srcType.shapeId}`);
    for (const el of pattern.elements) {
      if (el.name === undefined) continue; // 7 spells elisions as nameless elements
      // `{ a, ...rest }`: the rest binds a FRESH record of the unconsumed
      // fields (JS's CopyDataProperties makes a fresh object too, own
      // enumerable values copied at destructure time), the checker's own
      // rest type naming exactly which fields remain.
      if (el.dotDotDotToken) {
        L.bindPatternTarget(el.name, objectRestValue(L, el, srcRef, srcType, shape), isLet, out);
        continue;
      }
      const prop = el.propertyName ?? el.name;
      // Identifier keys spell themselves; string/numeric-literal and
      // FOLDABLE computed keys (`{ [k]: v }` where k's checker type
      // spells one property name — pure expressions only) resolve to the
      // same static field name tsc late-bound. Runtime-valued keys fence.
      const propName = ts.isIdentifier(prop) || ts.isComputedPropertyName(prop) || ts.isStringLiteralLike(prop) || ts.isNumericLiteral(prop)
        ? patternKeyNameOf(L, prop as ts.PropertyName)
        : null;
      if (propName === null) {
        L.unsupported("SC1031", el, "destructuring with computed keys that do not fold to one property name");
      }
      // An ACCESSOR property (%get:/%set: closure slots): the element's
      // read IS a getter call — once, at the element's pattern position
      // (JS reads destructured properties left to right). A setter-only
      // property keeps the read fence (Node binds undefined, which the
      // property's type cannot hold).
      const getSlotT = shape.fields.find((f) => f.name === `%get:${propName}`)?.type;
      if (getSlotT !== undefined || shape.fields.some((f) => f.name === `%set:${propName}`)) {
        if (getSlotT?.kind !== "func") {
          L.unsupported(
            "SC1031",
            el,
            `destructuring the setter-only property '${propName}' (Node would bind undefined)`,
          );
        }
        const loc = locOf(el);
        const closure: IrExpr = { kind: "recordGet", obj: srcRef(), shapeId: srcType.shapeId, field: `%get:${propName}`, type: getSlotT, loc };
        // The getter call IS the element's read; a default applies to its
        // RESULT exactly like a data field's (undefined-arm test, lazy).
        // The result lands in a hidden temp first: the default's ternary
        // mentions its operand twice (test + present arm), and the getter
        // must run ONCE (JS calls it once per element).
        let accessorValue: IrExpr = { kind: "callValue", callee: closure, args: [], type: getSlotT.ret, loc };
        if (el.initializer) {
          const got = L.declareHiddenLocal("%dget", accessorValue.type);
          out.push({ kind: "varDecl", localId: got.id, init: accessorValue, loc });
          accessorValue = applyBindingDefault(L, el, { kind: "varRef", localId: got.id, type: accessorValue.type, loc });
        }
        L.bindPatternTarget(el.name, accessorValue, isLet, out);
        continue;
      }
      const fieldType = shape.fields.find((f) => f.name === propName)?.type;
      if (!fieldType && shape.indexValue !== undefined && !shape.tuple) {
        // An UNDECLARED key of an INDEX-SIGNATURE shape (`const { m, n, p }
        // = ....groups` over `{ [key: string]: string }` — the groups
        // record, `Record<string, T>` tables generally): the overflow-map
        // read, exactly the dot access's recordKeyGet — a missing key
        // traps when the value type carries no undefined arm (the checker
        // claimed V), or binds the undefined arm (where a default applies
        // like any field's).
        const loc = locOf(el);
        let value: IrExpr = {
          kind: "recordKeyGet",
          obj: srcRef(),
          shapeId: srcType.shapeId,
          key: { kind: "strLit", value: propName, type: STRING, loc },
          overflowOnly: true,
          type: shape.indexValue,
          loc,
        };
        if (el.initializer) value = applyBindingDefault(L, el, value);
        L.bindPatternTarget(el.name, value, isLet, out);
        continue;
      }
      if (!fieldType) {
        // The pattern names a field the source SHAPE does not carry —
        // `for (let {x = 1} of [{}])` (signature 08): tsc types the binding
        // from the DEFAULT, and under JS the read is always undefined, so
        // the default IS the binding when one exists (nested patterns
        // destructure it). Without a default there is no value these
        // bindings' types can hold — a named fence, never a lowerer-bug
        // throw.
        if (el.initializer) {
          const bodyT = patternBindingType(L, el.name);
          if (bodyT && bodyT.kind !== "void") {
            L.bindPatternTarget(el.name, L.lowerExprExpecting(el.initializer, bodyT), isLet, out);
            continue;
          }
        }
        L.unsupported(
          "SC1031",
          el,
          `destructuring the field '${propName}' the source's shape does not carry`,
        );
      }
      const loc = locOf(el);
      let value: IrExpr = {
        kind: "recordGet",
        obj: srcRef(),
        shapeId: srcType.shapeId,
        field: propName,
        type: fieldType,
        loc,
      };
      // `{ tld = "localhost" }`: the element default applies exactly when
      // the field holds the undefined arm — the same undefined test and
      // narrow/retag as a defaulted parameter's prologue (declareParams).
      // The default evaluates LAZILY (ternary arm), in element order, so
      // it may reference names bound by EARLIER elements (`{ tld =
      // "localhost", tlds = [tld] }` — JS's left-to-right rule; the
      // earlier locals are already declared). A default on a field with
      // no undefined arm is dead code and never evaluates, exactly JS.
      // Nested-pattern targets take the same defaulted value and
      // destructure it (bindPatternTarget recurses).
      if (el.initializer) value = applyBindingDefault(L, el, value);
      L.bindPatternTarget(el.name, value, isLet, out);
    }
  }

/** The type a pattern element binds at — the checker's type of the bound
   * identifier, or of the nested pattern itself (its implied type). Null
   * when the type has no static mapping (the caller fences). */
  function patternBindingType(L: Lowerer, name: ts.BindingName): IrType | null {
    return L.mapTypeOf(L.typeOf(name));
  }

/** The STATIC property name of a destructuring key: identifiers spell
   * themselves, string/numeric-literal keys and COMPUTED keys fold through
   * foldedStringKeyOf — pure single-name expressions only (`{ [k]: v }`
   * where k's checker type spells one property name; tsc late-bound the
   * source's field under exactly that name, and pure keys make skipping
   * the evaluation exact). Null for runtime-valued keys — the callers
   * fence, or route island sources to the engine pattern. */
  export function patternKeyNameOf(L: Lowerer, prop: ts.PropertyName): string | null {
    if (ts.isIdentifier(prop) || ts.isPrivateIdentifier(prop)) return prop.text;
    if (ts.isComputedPropertyName(prop)) return L.foldedStringKeyOf(prop.expression);
    // A numeric-literal key spells JS's canonical ToPropertyKey form
    // directly (`{ 2: x }` names the field "2") — a pattern position is
    // not an expression, so the checker-type fold below does not apply.
    if (ts.isNumericLiteral(prop)) return String(Number(prop.text));
    if (ts.isStringLiteral(prop) || ts.isNoSubstitutionTemplateLiteral(prop)) {
      return L.foldedStringKeyOf(prop);
    }
    return null;
  }

/** True when the CHECKER types this expression as a string in every arm
   * (unions of string-likes included). The IR carries builtin IDENTITY
   * TOKENS as strings too (`globalThis.crypto` taken as a value in a JS
   * file, or a local that adopted such a value's carrier type), and those
   * must never reach the string-source destructuring lowerings — the
   * callers fence with the checker's own type name instead. */
  function checkerStringSource(L: Lowerer, e: ts.Expression): boolean {
    const stringLike = (t: ts.Type): boolean => {
      if ((t.flags & ts.TypeFlags.StringLike) !== 0) return true;
      if (t.isUnionType()) return t.getTypes().every(stringLike);
      return false;
    };
    return stringLike(L.typeOf(e));
  }

/** True when a pattern over a STRING source lowers statically whole —
   * every element a form the chars-array/wrapper-read desugars carry.
   * Array patterns take positions, holes, defaults, rest (a nested rest
   * pattern must be an ARRAY pattern — it destructures the packed
   * string[]), and nested patterns, whose elements are single code
   * points and recurse through this same test. Object patterns take
   * `length` bindings — shorthand, renamed, or (dead-)defaulted.
   * Anything else — wrapper methods, computed keys, rest over the
   * wrapper — keeps the engine gate (--dynamic runs the real pattern;
   * a static build reports the dynamic-family choice). */
  function staticStringPattern(L: Lowerer, pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern): boolean {
    if (ts.isArrayBindingPattern(pattern)) {
      return pattern.elements.every((el) => {
        if (ts.isOmittedExpression(el) || el.name === undefined) return true;
        if (el.dotDotDotToken) {
          // The rest binds string[]: identifier targets and nested ARRAY
          // patterns ride the array machinery; an object pattern over the
          // packed array keeps its fence.
          return ts.isIdentifier(el.name) || ts.isArrayBindingPattern(el.name);
        }
        if (ts.isIdentifier(el.name)) return true;
        return staticStringPattern(L, el.name);
      });
    }
    return pattern.elements.every((el) => {
      if (el.name === undefined) return true;
      if (el.dotDotDotToken || !ts.isIdentifier(el.name)) return false;
      const prop = el.propertyName ?? el.name;
      const propName = ts.isIdentifier(prop) || ts.isComputedPropertyName(prop) || ts.isStringLiteralLike(prop) || ts.isNumericLiteral(prop)
        ? patternKeyNameOf(L, prop as ts.PropertyName)
        : null;
      return propName === "length";
    });
  }

/** The stdlib globals whose members destructure to MEMBER identity
   * tokens: the OPAQUE globals — no member of theirs has a lowered
   * surface, so a token binding trades the eager pattern fence for the
   * per-site token rules and loses nothing. Globals with REAL member
   * surfaces (Math.max, JSON.stringify, process.env, console.log) stay
   * OUT: their detached members would ride the token's quiet
   * own-property-undefined reads where the property spelling works, so
   * those patterns keep an eager fence naming the global. `console` is
   * the one split surface: its five CALL members fence by name, while
   * the rest (`Console` — the suite's constructor-identity probe) have
   * no surface to lose and bind tokens. */
  const TOKEN_OPAQUE_GLOBALS: ReadonlySet<string> = new Set(["crypto"]);
  const CONSOLE_CALL_MEMBERS: ReadonlySet<string> = new Set(["log", "info", "debug", "error", "warn"]);

/** `const { subtle } = globalThis.crypto`, `const { Console } = console`,
   * `const { crypto } = globalThis` — an object pattern over a STDLIB
   * GLOBAL in a JavaScript file (the suite's webcrypto/console
   * prologues): the identifier chokepoint's identity-token rule, one
   * member deep. The global taken as a value is an opaque token, and a
   * member taken off an OPAQUE global is the same kind of value — one
   * global, one member, one interned string — so plain elements bind
   * MEMBER tokens (`[builtin crypto.subtle]`), and identity flows agree
   * across destructures of the same member. A member of GLOBALTHIS that
   * is itself a canonical global (`const { crypto } = globalThis` —
   * `declare var` globals are properties of `typeof globalThis`,
   * stdlib-provenance-checked so user script globals stay out) binds the
   * global's OWN token, byte-equal to the bare and property spellings'
   * answers, AND registers in stdlibGlobalAliases — the destructured
   * twin of stdlibGlobalAliasDecl — so receiver-position uses resolve
   * through every surface exactly like the bare global (`const { Math }
   * = globalThis; Math.max(...)` is Math.max). What a token cannot do
   * meets the per-site rules lazily at each USE — member reads answer
   * the wrapper's own-property undefined, calls throw Node-shaped
   * is-not-a-function TypeErrors — at the use's own line, where the
   * pattern-level fence killed the program at the destructure.
   *
   * Everything this rule does NOT claim over a stdlib-global source
   * fences HERE, naming the global — never the token's carrier string
   * type: rest (the member set is not statically enumerable), defaults
   * (member presence is not statically testable), nested patterns,
   * computed keys, members of the SURFACED globals (detached members
   * lose their receiver-keyed lowerings), and `var`/TDZ-predeclared/
   * pre-registered bindings whose slots no token can inhabit. Null only
   * when the source is not a stdlib global at all, or in TypeScript
   * files (the identifier chokepoint fences the global there first). */
  function stdlibGlobalTokenDestructure(L: Lowerer, decl: ts.VariableDeclaration, isLet: boolean): IrStmt[] | null {
    if (decl.initializer === undefined || !isJsSourceFile(decl.getSourceFile())) return null;
    const globalName = stdlibGlobalNameOf(L, decl.initializer);
    if (globalName === null) return null;
    if (!ts.isObjectBindingPattern(decl.name)) {
      L.unsupported(
        "SC1031",
        decl.name,
        `array destructuring of the builtin global '${globalName}' (builtin globals are not iterable)`,
      );
    }
    if (isVarDeclared(decl)) {
      L.unsupported("SC1031", decl.name, `var-declared patterns over the builtin global '${globalName}'`);
    }
    const srcT = L.typeOf(decl.initializer);
    const binds: { name: ts.Identifier; token: string; alias: string | null; g: IrGlobal | undefined }[] = [];
    for (const el of decl.name.elements) {
      if (el.name === undefined) continue;
      if (el.dotDotDotToken) {
        L.unsupported("SC1031", el, `rest bindings over the builtin global '${globalName}' (the member set is not statically enumerable)`);
      }
      if (el.initializer !== undefined) {
        L.unsupported("SC1031", el, `binding defaults over the builtin global '${globalName}' (member presence is not statically testable)`);
      }
      if (!ts.isIdentifier(el.name)) {
        L.unsupported("SC1031", el, `nested patterns over the builtin global '${globalName}'`);
      }
      const prop = el.propertyName ?? el.name;
      const propName = ts.isIdentifier(prop) || ts.isComputedPropertyName(prop) || ts.isStringLiteralLike(prop) || ts.isNumericLiteral(prop)
        ? patternKeyNameOf(L, prop as ts.PropertyName)
        : null;
      if (propName === null) {
        L.unsupported("SC1031", el, "destructuring with computed keys that do not fold to one property name");
      }
      let token: string;
      let alias: string | null = null;
      if (globalName === "globalThis") {
        // The member must BE a stdlib global (user script vars are
        // properties of `typeof globalThis` too — their values are real
        // and this rule has none to give).
        const member = L.checker.getPropertyOfType(srcT, propName);
        if (member === undefined || !L.isStdlibSymbol(member)) {
          L.unsupported("SC1031", el, `destructuring the non-builtin member '${propName}' of 'globalThis'`);
        }
        const canonical = member.name === "global" ? "globalThis" : member.name;
        token = `[builtin ${canonical}]`;
        alias = canonical;
      } else if (globalName === "console" && !CONSOLE_CALL_MEMBERS.has(propName)) {
        token = `[builtin console.${propName}]`;
      } else if (TOKEN_OPAQUE_GLOBALS.has(globalName)) {
        token = `[builtin ${globalName}.${propName}]`;
      } else {
        L.unsupported(
          "SC1031",
          el,
          `destructuring the member '${propName}' of the builtin global '${globalName}' (a detached member loses its receiver-keyed lowering — call it through the global)`,
        );
      }
      const symbol = L.checker.getSymbolAtLocation(el.name);
      if (!symbol || L.tdzPredeclared.has(symbol)) {
        L.unsupported("SC1031", el, `bindings with predeclared slots over the builtin global '${globalName}'`);
      }
      const g = L.globalsBySymbol.get(symbol);
      if (g !== undefined && g.type.kind !== "string" && g.type.kind !== "dyn") {
        L.unsupported("SC1031", el, `bindings with '${L.fmt(g.type)}' storage over the builtin global '${globalName}'`);
      }
      binds.push({ name: el.name, token, alias, g });
    }
    const out: IrStmt[] = [];
    for (const b of binds) {
      const loc = locOf(b.name);
      const token: IrExpr = { kind: "strLit", value: b.token, type: STRING, loc };
      if (b.alias !== null) {
        const symbol = L.checker.getSymbolAtLocation(b.name);
        if (symbol) L.stdlibGlobalAliases.set(symbol, b.alias);
      }
      if (b.g !== undefined) {
        out.push({ kind: "assign", localId: b.g.id, value: L.coerceInto(b.name, token, b.g.type), loc });
      } else {
        const local = L.declareLocal(b.name, b.name.text, STRING, isLet);
        out.push({ kind: "varDecl", localId: local.id, init: token, loc });
      }
    }
    return out;
  }

/** `x = dflt` on a pattern position whose source value always EXISTS
   * (tuple positions, record fields): JS evaluates the default exactly
   * when the value is undefined — the undefined-arm ternary, lazy, so
   * earlier elements' bindings are referenceable and a default on a value
   * with no undefined arm is dead code that never evaluates (both JS's
   * rules; null never triggers a default). Returns the defaulted value at
   * the binding's own type — identifier bindings and nested patterns
   * alike (the caller's bindPatternTarget recurses through the latter). */
  function applyBindingDefault(L: Lowerer, el: ts.BindingElement, value: IrExpr): IrExpr {
    const name = el.name!; // callers skip nameless elisions
    if (value.type.kind !== "union") return value; // no undefined arm: dead default
    if (L.armTag(value.type.unionId, UNDEFINED_T) < 0) return value;
    const bodyT = patternBindingType(L, name);
    if (!bodyT || bodyT.kind === "void") L.badType(name, L.typeOf(name));
    return undefArmDefault(L, el, el.initializer!, value, bodyT);
  }

/** The undefined-arm default core: `value` (a union carrying an undefined
   * arm) tests for that arm; the default expression fills it, a present
   * value narrows/re-tags into `bodyT`. Shared by pattern elements,
   * destructuring assignment, and the array-position bounds machinery. */
  function undefArmDefault(L: Lowerer, blame: ts.Node, init: ts.Expression, value: IrExpr, bodyT: IrType): IrExpr {
    const fieldType = value.type;
    if (fieldType.kind !== "union") return value; // no undefined arm: dead default
    const undefTag = L.armTag(fieldType.unionId, UNDEFINED_T);
    if (undefTag < 0) return value;
    const loc = value.loc;
    const isUndef: IrExpr = { kind: "unionIsTag", unionId: fieldType.unionId, tag: undefTag, negated: false, value, type: BOOL, loc };
    if (typeEquals(bodyT, fieldType)) {
      // The default may ITSELF be undefined-armed: the binding keeps the
      // full union, present values pass through unchanged.
      const dflt = L.lowerExprExpecting(init, bodyT);
      return { kind: "ternary", cond: isUndef, then: dflt, else_: value, type: bodyT, loc };
    }
    let present: IrExpr | null = null;
    if (bodyT.kind === "union") {
      const retag = L.unionRetagHelper(fieldType.unionId, bodyT.unionId, loc);
      if (retag) present = { kind: "call", callee: retag, args: [value], type: bodyT, loc };
    } else {
      // Single-arm binding: sound only when the field is exactly
      // `bodyT | undefined` — a wider field keeps the fence (a narrow
      // would misread a stranded arm).
      const def = L.unions.get(fieldType.unionId);
      const tag = L.armTag(fieldType.unionId, bodyT);
      if (def && def.arms.length === 2 && tag >= 0) {
        present = { kind: "unionNarrow", unionId: fieldType.unionId, tag, value, type: bodyT, loc };
      }
    }
    if (!present) {
      L.unsupported(
        "SC1031",
        blame,
        `defaults binding '${L.fmt(fieldType)}' fields as '${L.fmt(bodyT)}'`,
      );
    }
    const dflt = L.lowerExprExpecting(init, bodyT);
    return { kind: "ternary", cond: isUndef, then: dflt, else_: present, type: bodyT, loc };
  }

/** `[a = dflt]` over an ARRAY source: the default fires when the position
   * is past the end OR holds undefined (JS's one rule — both spell the
   * read as undefined there), so the defaulted read carries a bounds test
   * where the plain read would trap (the array divergence's carve-out).
   * Elements with an undefined arm land in a hidden temp first (in-bounds
   * undefined and past-the-end collapse to the same arm), then the
   * ordinary undefined-arm default applies. */
  function arrayPositionDefault(L: Lowerer, el: ts.BindingElement, read: IrExpr,
    srcRef: () => IrExpr,
    index: number,
    elemT: IrType,
    out: IrStmt[],): IrExpr {
    const name = el.name!; // callers skip nameless elisions
    const bodyT = patternBindingType(L, name);
    if (!bodyT || bodyT.kind === "void") L.badType(name, L.typeOf(name));
    return arrayPositionDefaultValue(L, name, el.initializer!, read, srcRef, index, elemT, bodyT, out);
  }

/** The array-position default core (the bounds test + undefined-arm
   * machinery), shared with destructuring ASSIGNMENT, whose target type
   * arrives from the existing binding instead of the checker. */
  function arrayPositionDefaultValue(L: Lowerer, blame: ts.Node, init: ts.Expression, read: IrExpr,
    srcRef: () => IrExpr,
    index: number,
    elemT: IrType,
    bodyT: IrType,
    out: IrStmt[],): IrExpr {
    const loc = read.loc;
    // The unit-only element (a declared-empty-tuple source riding the
    // array representation): every read is undefined — the default IS the
    // binding.
    if (isUnitType(elemT)) {
      return L.lowerExprExpecting(init, bodyT);
    }
    const source = srcRef();
    const length: IrExpr = source.type.kind === "bytes"
      ? {
          kind: "bytesIntrinsic",
          method: "length",
          receiver: source,
          args: [],
          type: F64,
          loc,
        }
      : {
          kind: "arrIntrinsic",
          method: "length",
          receiver: source,
          args: [],
          type: F64,
          loc,
        };
    const inRange: IrExpr = {
      kind: "bin",
      op: "<",
      left: { kind: "numLit", value: index, type: F64, loc },
      right: length,
      type: BOOL,
      loc,
    };
    const undefTag = elemT.kind === "union" ? L.armTag(elemT.unionId, UNDEFINED_T) : -1;
    if (elemT.kind === "union" && undefTag >= 0) {
      const wrapped = L.wrappedUndefined(elemT, loc);
      if (!wrapped) L.badType(blame, L.typeOf(blame)); // defensive: the arm was just found
      const tmp = L.declareHiddenLocal("%delem", elemT);
      out.push({
        kind: "varDecl",
        localId: tmp.id,
        init: { kind: "ternary", cond: inRange, then: read, else_: wrapped, type: elemT, loc },
        loc,
      });
      return undefArmDefault(L, blame, init, { kind: "varRef", localId: tmp.id, type: elemT, loc }, bodyT);
    }
    // No undefined arm in bounds: the default fires exactly past the end.
    return {
      kind: "ternary",
      cond: inRange,
      then: L.coerceInto(blame, read, bodyT),
      else_: L.lowerExprExpecting(init, bodyT),
      type: bodyT,
      loc,
    };
  }

/** The fresh tail for `[head, ...rest]` over a TUPLE source, packed under
   * the checker's own rest type: an ARRAY of the remaining positions (each
   * read coercing into the element type) or a tuple RECORD when the
   * positions stay heterogeneous. Both are fresh copies — exactly JS's
   * surplus packing, which builds a new array. */
  function tupleRestValue(L: Lowerer, el: ts.BindingElement,
    srcRef: () => IrExpr,
    srcType: IrType & { kind: "record" },
    shape: { fields: readonly { name: string; type: IrType }[] },
    from: number,): IrExpr {
    if (el.initializer) {
      L.unsupported("SC1031", el, "defaults on rest elements"); // tsc rejects; defensive
    }
    const restT = patternBindingType(L, el.name!); // callers skip nameless elisions
    return tupleTailValue(L, el, srcRef, srcType, shape, from, restT);
  }

/** The tuple-tail packing core, shared with destructuring ASSIGNMENT
   * (whose rest type arrives from the existing binding). */
  function tupleTailValue(L: Lowerer, blame: ts.Node,
    srcRef: () => IrExpr,
    srcType: IrType & { kind: "record" },
    shape: { fields: readonly { name: string; type: IrType }[] },
    from: number,
    restT: IrType | null,): IrExpr {
    const loc = locOf(blame);
    const reads: IrExpr[] = [];
    for (let j = from; j < shape.fields.length; j++) {
      const field = shape.fields.find((f) => f.name === String(j));
      if (!field) break; // defensive: tuple shapes are densely positional
      reads.push({ kind: "recordGet", obj: srcRef(), shapeId: srcType.shapeId, field: field.name, type: field.type, loc });
    }
    if (restT?.kind === "array") {
      return {
        kind: "arrayLit",
        elems: reads.map((r) => L.coerceInto(blame, r, restT.elem)),
        type: restT,
        loc,
      };
    }
    if (restT?.kind === "record") {
      const restShape = L.shapes.get(restT.shapeId);
      if (restShape?.tuple && restShape.fields.length === reads.length) {
        return {
          kind: "recordLit",
          fields: reads.map((r, j) => {
            const f = restShape.fields.find((x) => x.name === String(j))!;
            return { name: f.name, value: L.coerceInto(blame, r, f.type) };
          }),
          type: restT,
          loc,
        };
      }
    }
    L.unsupported(
      "SC1031",
      blame,
      restT
        ? `rest elements packing this tuple's tail as '${L.fmt(restT)}'`
        : "rest elements whose packed type has no static mapping",
    );
  }

/** The fresh record for `{ a, ...rest }` over a RECORD source: the
   * checker's rest type names exactly the unconsumed fields, and each
   * copies out of the source at destructure time (JS's CopyDataProperties
   * is a fresh object of copied values too, so mutations through the rest
   * binding never reach the source — and records have no getters to make
   * the copy observable). Index-signature rest types keep a named fence:
   * their entries would need overflow packing, not field reads. */
  function objectRestValue(L: Lowerer, el: ts.BindingElement,
    srcRef: () => IrExpr,
    srcType: IrType & { kind: "record" },
    shape: { fields: readonly { name: string; type: IrType }[]; indexValue?: IrType },): IrExpr {
    const loc = locOf(el);
    const restT = patternBindingType(L, el.name!); // callers skip nameless elisions
    // A DYN rest type is the top-type spelling (`const { ...rest } = src`
    // where the checker's rest type is `{}` — every field consumed, or the
    // empty-source `const { ...empty } = {}`): CopyDataProperties still
    // builds a fresh object of the UNCONSUMED fields, so pack them as the
    // record they are and ride the ordinary record→dyn conversion into the
    // binding. Computed sibling keys would make the consumed set a runtime
    // fact, and reserved accessor slots are closures, not data — both fence.
    if (restT?.kind === "dyn") {
      const pattern = el.parent;
      const consumed = new Set<string>();
      let computedSibling = false;
      if (ts.isObjectBindingPattern(pattern)) {
        for (const sib of pattern.elements) {
          if (sib === el || sib.dotDotDotToken) continue;
          const key = sib.propertyName ?? sib.name;
          if (key && ts.isComputedPropertyName(key)) computedSibling = true;
          else if (key && (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key))) consumed.add(key.text);
        }
      }
      const rem = shape.fields.filter((f) => !consumed.has(f.name));
      if (computedSibling || shape.indexValue || rem.some((f) => f.name.startsWith("%"))) {
        L.unsupported(
          "SC1031",
          el,
          computedSibling
            ? "rest bindings beside computed keys (the consumed set is a runtime fact)"
            : "rest bindings over index-signature or accessor shapes (the entries would need overflow packing)",
        );
      }
      const packed: IrExpr = {
        kind: "recordLit",
        fields: rem.map((f) => ({
          name: f.name,
          value: { kind: "recordGet", obj: srcRef(), shapeId: srcType.shapeId, field: f.name, type: f.type, loc } as IrExpr,
        })),
        type: { kind: "record", shapeId: L.shapes.intern(rem.map((f) => ({ name: f.name, type: f.type }))) },
        loc,
      };
      return L.coerceInto(el, packed, DYN);
    }
    if (restT?.kind !== "record") {
      L.unsupported(
        "SC1031",
        el,
        restT
          ? `rest bindings packing the remaining fields as '${L.fmt(restT)}' (only plain record types pack)`
          : "rest bindings whose packed type has no static mapping (only plain record types pack)",
      );
    }
    const restShape = L.shapes.get(restT.shapeId);
    if (!restShape) throw new Error(`lowerer bug: rest binding over unknown shape ${restT.shapeId}`);
    if (restShape.indexValue || shape.indexValue) {
      L.unsupported("SC1031", el, "rest bindings over index-signature shapes (the undeclared entries would need overflow packing)");
    }
    const fields = restShape.fields.map((f) => {
      const srcField = shape.fields.find((s) => s.name === f.name);
      if (!srcField) {
        L.unsupported("SC1031", el, `the rest field '${f.name}' the source's shape does not carry`);
      }
      const read: IrExpr = { kind: "recordGet", obj: srcRef(), shapeId: srcType.shapeId, field: srcField.name, type: srcField.type, loc };
      return { name: f.name, value: L.coerceInto(el, read, f.type) };
    });
    return { kind: "recordLit", fields, type: restT, loc };
  }

/** The fresh record for `{ a, ...rest }` over a CLASS-INSTANCE source:
   * JS's CopyDataProperties copies the OWN ENUMERABLE properties — the
   * instance FIELDS, base chain included, in property-creation order
   * (base constructors assign theirs first) — and never the prototype
   * members (methods and accessors stay behind; the checker's rest type
   * excludes them too, so the two sides agree). The packed record must
   * agree with the checker's rest type field-for-field — a non-public
   * field IS copied by JS but the rest type cannot name it (silent
   * divergence; fence) — and key-for-key in ORDER: the packed shape's
   * JSON/Object.keys order is first-seen global metadata, and a checker
   * rest type that reorders (own-before-inherited) would make the
   * enumeration surfaces diverge from Node, so it fences instead of
   * silently reordering. Runtime-provided chains (Error/EventEmitter/
   * stream roots) carry runtime-internal state no record copy can
   * reproduce — fenced. ES-#private fields are own but non-enumerable:
   * JS skips them and so does the packing. */
  function classInstanceRestValue(L: Lowerer, blame: ts.Node,
    srcRef: () => IrExpr,
    srcType: IrType & { kind: "object" },
    info: ClassInfo,
    consumed: Set<string>,
    restT: IrType | null,): IrExpr {
    const loc = locOf(blame);
    for (let c: ClassInfo | null = info; c; c = c.base) {
      if (c.builtinError || c.builtinEmitter || c.builtinStream) {
        L.unsupported(
          "SC1031",
          blame,
          "rest bindings over runtime-provided class instances (Error/EventEmitter/stream internals have no record form)",
        );
      }
    }
    if (restT?.kind !== "record") {
      L.unsupported(
        "SC1031",
        blame,
        restT
          ? `rest bindings packing the remaining properties as '${L.fmt(restT)}' (only plain record types pack)`
          : "rest bindings whose packed type has no static mapping (only plain record types pack)",
      );
    }
    const restShape = L.shapes.get(restT.shapeId);
    if (!restShape) throw new Error(`lowerer bug: rest binding over unknown shape ${restT.shapeId}`);
    if (restShape.indexValue || restShape.tuple) {
      L.unsupported("SC1031", blame, "rest bindings over index-signature shapes (the undeclared entries would need overflow packing)");
    }
    const remaining = info.def.fields.filter(
      (f) => !f.name.startsWith("#") && !f.name.startsWith("%") && !consumed.has(f.name),
    );
    for (const f of remaining) {
      if (!restShape.fields.some((rf) => rf.name === f.name)) {
        L.unsupported(
          "SC1031",
          blame,
          `rest bindings over instances of '${info.def.jsName ?? info.def.name}' (JS copies the non-public field '${f.name}' into the rest object, which the rest type cannot name)`,
        );
      }
    }
    for (const rf of restShape.fields) {
      if (!remaining.some((f) => f.name === rf.name)) {
        L.unsupported(
          "SC1031",
          blame,
          `the rest field '${rf.name}' is not an instance field of '${info.def.jsName ?? info.def.name}'`,
        );
      }
    }
    const emitOrder = restShape.declaredOrder ?? restShape.fields.map((f) => f.name);
    const orderMatches = (order: readonly string[]): boolean =>
      order.length === remaining.length && order.every((n, i) => n === remaining[i]!.name);
    const deferOrderCheck =
      L.instantiationContext !== null &&
      L.onEdge !== null &&
      !isJsSourceFile(blame.getSourceFile());
    if (!deferOrderCheck) {
      if (!orderMatches(emitOrder)) {
        L.unsupported(
          "SC1031",
          blame,
          "rest bindings over class instances whose packed key order cannot match Node's (Object.keys/JSON.stringify would enumerate the copied fields in a different order)",
        );
      }
    } else {
      // Retained reachability can learn about an earlier source-order body
      // only while a generic instance lowers. Always defer this metadata-only
      // check until that worklist closes: the initial order can settle from
      // wrong to right OR from right to wrong. Unlike emitted helper bodies,
      // there is no IR to rebuild here — only the settled support decision
      // matters.
      const context = L.instantiationContext;
      const countFailure = !L.suppressStats;
      const sf = blame.getSourceFile();
      L.shapeOrderMetadataFinalizers.push(() => {
        const current = L.shapes.get(restT.shapeId) ?? restShape;
        const currentOrder = current.declaredOrder ?? current.fields.map((f) => f.name);
        if (orderMatches(currentOrder)) return;
        const previous = L.instantiationContext;
        L.instantiationContext = context;
        try {
          if (countFailure) {
            L.stats.statementsFailed++;
            L.bumpFileStat(sf.fileName, "failed");
          }
          L.pushDiag({
            code: "SC1031",
            message:
              "rest bindings over class instances whose packed key order cannot match Node's " +
              "(Object.keys/JSON.stringify would enumerate the copied fields in a different order) are not supported yet",
            loc: locOf(blame),
          });
        } finally {
          L.instantiationContext = previous;
        }
      });
    }
    const fields = remaining.map((f) => {
      const fieldType = info.fields.get(f.name) ?? f.type;
      const read = L.fieldGetExpr(
        { container: "class", obj: srcRef(), className: srcType.className, field: f.name, fieldType },
        loc,
        blame,
      );
      const restFT = restShape.fields.find((rf) => rf.name === f.name)!.type;
      return { name: f.name, value: L.coerceInto(blame, read, restFT) };
    });
    return { kind: "recordLit", fields, type: restT, loc };
  }

/** The fences the island's element-wise object path shares: no rest
   * (surplus packing over a handle) and no defaults (an engine undefined
   * test) — the static positions now take both through their own
   * machinery above. */
  export function checkBindingElement(L: Lowerer, el: ts.BindingElement, allowDefault = false): void {
    if (el.dotDotDotToken) {
      L.unsupported("SC1031", el, "rest elements in destructuring patterns over island sources");
    }
    if (el.initializer && !allowDefault) {
      L.unsupported("SC1031", el, "defaults in destructuring positions over island sources");
    }
  }

/** The JS source text for a pattern default the ENGINE can evaluate —
   * side-effect-free literal data whose value cannot depend on compiled
   * scope: numeric/string/boolean/null literals (unary minus included),
   * provably-undefined expressions, and array/object literals of those.
   * Null for everything else (a default referencing compiled bindings or
   * calling functions has no honest engine form). */
  function transportableDefaultText(L: Lowerer, e: ts.Expression): string | null {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isNumericLiteral(e)) return e.text;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) {
      return `-${e.operand.text}`;
    }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return JSON.stringify(e.text);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (e.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (e.kind === ts.SyntaxKind.NullKeyword) return "null";
    // Any pure identifier whose CHECKER type is the undefined type holds
    // undefined (shadowing included — a value of type undefined is
    // undefined).
    if (ts.isIdentifier(e) && (L.typeOf(e).flags & ts.TypeFlags.Undefined) !== 0) return "(void 0)";
    if (ts.isArrayLiteralExpression(e)) {
      const parts: string[] = [];
      for (const elem of e.elements) {
        if (ts.isOmittedExpression(elem)) { parts.push(""); continue; }
        const t = transportableDefaultText(L, elem);
        if (t === null) return null;
        parts.push(t);
      }
      return `[${parts.join(",")}]`;
    }
    if (ts.isObjectLiteralExpression(e)) {
      const parts: string[] = [];
      for (const prop of e.properties) {
        if (!ts.isPropertyAssignment(prop)) return null;
        let key: string;
        if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)) {
          key = JSON.stringify(prop.name.text);
        } else {
          return null;
        }
        const t = transportableDefaultText(L, prop.initializer);
        if (t === null) return null;
        parts.push(`[${key}]:${t}`);
      }
      return `{${parts.join(",")}}`;
    }
    return null;
  }

/** A declaration pattern rebuilt as ENGINE source with every bound name
   * renamed __0..__n (pattern order): holes, nesting, rest, and
   * transportable defaults all survive verbatim, so the engine runs the
   * REAL pattern — the iterator protocol on array patterns,
   * RequireObjectCoercible on object patterns, JS's own default rule.
   * Null when any element has no engine form (computed keys — a compiled
   * expression the pattern text cannot carry — or untransportable
   * defaults). */
  export function enginePatternSpec(L: Lowerer, pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern,
  ): { text: string; binds: ts.Identifier[]; extras: ts.Expression[] } | null {
    const binds: ts.Identifier[] = [];
    const extras: ts.Expression[] = [];
    // Every name the pattern itself binds, by text: a default referencing
    // one is JS's earlier-element-in-scope (or TDZ) rule, which the
    // pre-evaluated extras below cannot honor — those defaults have no
    // engine form here.
    const ownNames = new Set<string>();
    const collectOwn = (p: ts.ArrayBindingPattern | ts.ObjectBindingPattern): void => {
      for (const el of p.elements) {
        if (ts.isOmittedExpression(el) || el.name === undefined) continue;
        if (ts.isIdentifier(el.name)) ownNames.add(el.name.text);
        else collectOwn(el.name);
      }
    };
    collectOwn(pattern);
    // A key or default with no literal engine text but a COMPILED-SCOPE
    // form the engine can run exactly:
    // - a plain identifier the pattern does not itself bind (`{ p: {} =
    //   a } = a` with `a: any`) passes in as an extra parameter —
    //   pre-evaluation of a bare variable read is unobservable (no side
    //   effects, and the engine call is atomic);
    // - an identifier bound by an EARLIER element of this pattern spells
    //   its own temp (`[{ ...a }, b = a]` — the engine's mid-pattern
    //   scope IS JS's, so the reference reads the just-bound value);
    //   same-element and later names have no honest form (TDZ vs the
    //   temps' var-undefined) and bail;
    // - a CALL of such an identifier over transportable arguments
    //   (`{ [order(1)]: x } = order(0)` — the evaluation-order corpus)
    //   spells the call itself, so the engine runs it at exactly JS's
    //   pattern position: keys in pattern order, defaults lazily. The
    //   callee marshals through the host-function trampoline.
    // `boundBefore` is the bind count when the current element's key/
    // default began — the earlier-element boundary.
    const tempIndexOf = (name: string, boundBefore: number): number => {
      for (let i = 0; i < boundBefore; i++) {
        if (binds[i]!.text === name) return i;
      }
      return -1;
    };
    const exprText = (init: ts.Expression, boundBefore: number): string | null => {
      const t = transportableDefaultText(L, init);
      if (t !== null) return t;
      let e = init;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isIdentifier(e)) {
        if (ownNames.has(e.text)) {
          const idx = tempIndexOf(e.text, boundBefore);
          return idx >= 0 ? `__${idx}` : null;
        }
        extras.push(e);
        return `__d${extras.length - 1}`;
      }
      if (ts.isCallExpression(e) && !e.questionDotToken && ts.isIdentifier(e.expression) && e.typeArguments === undefined) {
        const callee = exprText(e.expression, boundBefore);
        if (callee === null) return null;
        const args: string[] = [];
        for (const a of e.arguments) {
          if (ts.isSpreadElement(a)) return null;
          const at = exprText(a, boundBefore);
          if (at === null) return null;
          args.push(at);
        }
        return `${callee}(${args.join(",")})`;
      }
      return null;
    };
    const target = (name: ts.BindingName): string | null => {
      if (ts.isIdentifier(name)) {
        binds.push(name);
        return `__${binds.length - 1}`;
      }
      return build(name);
    };
    const build = (p: ts.ArrayBindingPattern | ts.ObjectBindingPattern): string | null => {
      if (ts.isArrayBindingPattern(p)) {
        const parts: string[] = [];
        for (const el of p.elements) {
          if (ts.isOmittedExpression(el) || el.name === undefined) { parts.push(""); continue; }
          const boundBefore = binds.length;
          let sub = target(el.name);
          if (sub === null) return null;
          if (el.initializer) {
            const d = exprText(el.initializer, boundBefore);
            if (d === null) return null;
            sub += `=${d}`;
          }
          parts.push(el.dotDotDotToken ? `...${sub}` : sub);
        }
        return `[${parts.join(",")}]`;
      }
      const parts: string[] = [];
      for (const el of p.elements) {
        if (el.name === undefined) continue;
        if (el.dotDotDotToken) {
          const sub = target(el.name);
          if (sub === null) return null;
          parts.push(`...${sub}`);
          continue;
        }
        const boundBefore = binds.length;
        const prop = el.propertyName ?? el.name;
        let key: string | null = null;
        if (ts.isIdentifier(prop) || ts.isPrivateIdentifier(prop)) {
          key = JSON.stringify(prop.text);
        } else if (ts.isStringLiteral(prop) || ts.isNumericLiteral(prop) || ts.isNoSubstitutionTemplateLiteral(prop)) {
          key = JSON.stringify(prop.text);
        } else if (ts.isComputedPropertyName(prop)) {
          // A computed key: a FOLDABLE one (pure single-name expression)
          // spells its static name; anything else takes the transportable
          // form — extras for compiled-scope identifiers, temps for
          // earlier-bound names, calls run at exactly JS's key position
          // (pattern order, before the element's read).
          const folded = L.foldedStringKeyOf(prop.expression);
          key = folded !== null ? JSON.stringify(folded) : exprText(prop.expression, boundBefore);
        }
        if (key === null) {
          return null; // an unfoldable computed key with no engine form
        }
        let sub = target(el.name);
        if (sub === null) return null;
        if (el.initializer) {
          const d = exprText(el.initializer, boundBefore);
          if (d === null) return null;
          sub += `=${d}`;
        }
        parts.push(`[${key}]:${sub}`);
      }
      return `{${parts.join(",")}}`;
    };
    const text = build(pattern);
    return text === null ? null : { text, binds, extras };
  }

/** Declaration-position destructuring over an ISLAND source: the ENGINE
   * runs the real pattern — a synthesized strict-mode
   * `new Function("v", ...)` exactly like the assignment chain's
   * (lowerJsvalDestructuringChain) — and the extracted values bind the
   * declared names: a name whose declared type is a primitive exits
   * eagerly (the island property-read rule), everything else stays a
   * HANDLE whose use sites dispatch to engine ops. Holes, nesting, empty
   * patterns (the object coercion check and the array iterator get+close
   * both run — destructuring undefined throws Node's TypeError at Node's
   * exit), rest, and transportable defaults all ride. False when the
   * pattern has no engine form (the caller fences). */
  export function lowerJsvalBindingPattern(L: Lowerer, pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern,
    srcRef: () => IrExpr,
    isLet: boolean,
    out: IrStmt[],): boolean {
    const spec = enginePatternSpec(L, pattern);
    if (!spec) return false;
    const loc = locOf(pattern);
    const temps = spec.binds.map((_, i) => `__${i}`);
    const body =
      `"use strict";` +
      (temps.length > 0 ? `var ${temps.join(",")};` : "") +
      `(${spec.text} = v);return [${temps.join(",")}];`;
    // Compiled-scope defaults (enginePatternSpec's extras) enter the
    // synthesized function as additional parameters __d0..__dn, their
    // values evaluated here and marshaled across.
    const paramNames = ["v", ...spec.extras.map((_, i) => `__d${i}`)];
    const helper: IrExpr = {
      kind: "jsOp",
      op: "construct",
      args: [
        { kind: "jsOp", op: "globalGet", name: "Function", args: [], type: JSVAL, loc },
        ...paramNames.map((p): IrExpr => ({ kind: "jsMarshal", value: { kind: "strLit", value: p, type: STRING, loc }, type: JSVAL, loc })),
        { kind: "jsMarshal", value: { kind: "strLit", value: body, type: STRING, loc }, type: JSVAL, loc },
      ],
      type: JSVAL,
      loc,
    };
    const extraArgs = spec.extras.map((e) => L.jsvalIn(L.lowerExpr(e), e));
    const run: IrExpr = { kind: "jsOp", op: "callFn", args: [helper, srcRef(), ...extraArgs], type: JSVAL, loc };
    if (spec.binds.length === 0) {
      out.push({ kind: "exprStmt", expr: run, loc });
      return true;
    }
    const res = L.declareHiddenLocal("%dres", JSVAL);
    out.push({ kind: "varDecl", localId: res.id, init: run, loc });
    spec.binds.forEach((name, i) => {
      const bindLoc = locOf(name);
      const read: IrExpr = {
        kind: "jsOp",
        op: "getIdx",
        args: [
          { kind: "varRef", localId: res.id, type: JSVAL, loc: bindLoc },
          { kind: "jsMarshal", value: { kind: "numLit", value: i, type: F64, loc: bindLoc }, type: JSVAL, loc: bindLoc },
        ],
        type: JSVAL,
        loc: bindLoc,
      };
      // The island property-read stance: a name the checker declares as a
      // primitive exits eagerly to the static type; everything else stays
      // a handle.
      const declared = L.mapTypeOf(L.typeOf(name));
      const primitive =
        declared &&
        (declared.kind === "f64" || declared.kind === "bool" || declared.kind === "string");
      const value: IrExpr = primitive
        ? { kind: "jsExit", value: read, type: declared, loc: bindLoc }
        : read;
      const symbol = L.checker.getSymbolAtLocation(name);
      const g = symbol ? L.globalsBySymbol.get(symbol) : undefined;
      if (g) {
        out.push({ kind: "assign", localId: g.id, value: L.coerceInto(name, value, g.type), loc: bindLoc });
        return;
      }
      if (symbol && hostVariableDeclarationOf(name) !== null && isVarDeclared(name)) {
        const hoisted = hoistVarBinding(L, symbol, name);
        out.push({ kind: "assign", localId: hoisted.id, value: L.coerceInto(name, value, hoisted.type), loc: bindLoc });
        return;
      }
      const local = L.declareLocal(name, name.text, value.type, isLet);
      out.push({ kind: "varDecl", localId: local.id, init: value, loc: bindLoc });
    });
    return true;
  }

/** Binds one destructured name to its value — the identifier tail of
   * lowerVarDecl (module-global assignment for pre-registered file-scope
   * names, declareLocal otherwise), or a nested pattern through its own
   * hidden temp. */
  /** An island-world ('any'-flavored) checker spelling: bare jsval or an
   * array of jsvals (`(string | object)[]` absorbed by its jsval arm) —
   * the shapes the runtime-world local rule keeps DYN when the value
   * lowered checked-dynamic. */
  function jsvalFlavoredType(t: IrType): boolean {
    return t.kind === "jsval" || (t.kind === "array" && t.elem.kind === "jsval");
  }

  export function bindPatternTarget(L: Lowerer, name: ts.BindingName,
    value: IrExpr,
    isLet: boolean,
    out: IrStmt[],
    allowDynObject = false,): void {
    const loc = value.loc;
    if (ts.isIdentifier(name)) {
      const symbol = L.checker.getSymbolAtLocation(name);
      const g = symbol ? L.globalsBySymbol.get(symbol) : undefined;
      if (g) {
        out.push({ kind: "assign", localId: g.id, value: L.coerceInto(name, value, g.type), loc });
        return;
      }
      // A `var`-declared pattern name assigns its function-scoped hoisted
      // slot — `var [a, b] = pair` writes the same bindings a plain
      // `var a = pair[0]` would (hoistVarBinding merges redeclarations).
      // VariableDeclaration hosts only: parameter patterns (also routed
      // here by declareParams) carry no block-scope flag either, but their
      // bindings are the parameters' own.
      if (symbol && hostVariableDeclarationOf(name) !== null && isVarDeclared(name)) {
        const hoisted = hoistVarBinding(L, symbol, name);
        out.push({ kind: "assign", localId: hoisted.id, value: L.coerceInto(name, value, hoisted.type), loc });
        return;
      }
      // The runtime-world local rule, dyn side (383(d)'s dispatch stance):
      // a pattern binding whose VALUE lowered checked-dynamic stays dyn
      // where the checker spells an island-world type (`function f({
      // plugins = [] } = {})` over a JSDoc '(string | object)[]=' member —
      // the read is a dyn keyed read whose members may be wrapped island
      // values) or a type with no mapping at all (the varDecl rule's
      // unmappable-declared-type stance, `string | object` bindings
      // included). Marshaling here would fence or deep-copy; the value's
      // world is the honest dispatch.
      const dynStays =
        value.type.kind === "dyn" &&
        (() => {
          const mapped = L.mapTypeOf(L.typeOf(name));
          return mapped === null || (L.dynamic && jsvalFlavoredType(mapped));
        })();
      const type = dynStays ? DYN : L.irTypeOf(name);
      if (type.kind === "void") L.badType(name, L.typeOf(name));
      const coerced = L.coerceInto(name, value, type);
      const local = L.declareLocal(name, name.text, type, isLet);
      out.push({ kind: "varDecl", localId: local.id, init: coerced, loc });
      return;
    }
    const tmp = L.declareHiddenLocal("%destr", value.type);
    out.push({ kind: "varDecl", localId: tmp.id, init: value, loc });
    L.lowerBindingPattern(
      name,
      () => ({ kind: "varRef", localId: tmp.id, type: value.type, loc }),
      value.type,
      isLet,
      out,
      undefined,
      allowDynObject,
    );
  }

/** For-loop initializers. let/const stay restricted to ONE declarator (JS
   * per-iteration binding copies for several captured loop variables are
   * not modeled yet); `var` initializers take any number — a `var` is ONE
   * function-scoped binding with no per-iteration copies to model, so
   * `for (var i = 0, n = xs.length; ...)` is just two hoisted-slot
   * assignments (wrapped in a block when several). Statement position goes
   * through lowerVarStatement. */
  export function lowerVarDeclList(L: Lowerer, list: ts.VariableDeclarationList): IrStmt | null {
    if ((list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
    if (!isConst && !isLet) {
      const out = list.declarations.flatMap((decl) => {
        // `for (var {} = {}, [a] = xs; ...)`: pattern declarators ride the
        // declaration desugar (var names assign their hoisted slots).
        if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
          return L.lowerDestructuringDecl(decl, true);
        }
        const lowered = L.lowerVarDecl(decl, true);
        return lowered ? [lowered] : [];
      });
      if (out.length === 0) return null; // `for (var x; ...)` — the hoisted binding needs no init statement
      if (out.length === 1) return out[0]!;
      return { kind: "block", body: out, loc: locOf(list) };
    }
    if (list.declarations.length !== 1) {
      L.unsupported("SC1090", list, "multi-declaration for-loop initializers");
    }
    const decl = list.declarations[0]!;
    if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
      // `for (let [x] = init; ...)`: the desugar is a multi-statement
      // block, and the backend's per-iteration fresh-binding copy (what
      // makes closures in iteration k see iteration k's let) keys off a
      // single varDecl init — a captured destructured head would silently
      // share one binding. `var` heads above have no per-iteration story
      // and lower; let/const keep an honest fence.
      L.unsupported(
        "SC1031",
        decl.name,
        "let/const destructuring in for-loop initializers (declare the pattern before the loop, or use var)",
      );
    }
    const lowered = L.lowerVarDecl(decl, isLet);
    if (!lowered) throw new Error("lowerer bug: for-init declarator resolved to a global");
    return lowered;
  }

export function lowerVarDecl(L: Lowerer, decl: ts.VariableDeclaration, isLet: boolean): IrStmt | null {
    // --provenance-sources: an elided pure-annotated dead const emits
    // nothing (collectGlobals registered no global by the same test —
    // see provenanceElidedConstDecl). Checked FIRST: the mixin/alias
    // probes below would otherwise claim the call-initializer shape and
    // put its fences on the build.
    if (provenanceElidedConstDecl(L, decl)) return null;

    // A TRAP declaration — the initializer's chain roots at an
    // ambient-undefined name (`declare function factory...; const make =
    // factory<T>()`): Node throws the root's ReferenceError while
    // evaluating the initializer, module init unwinds THERE, and nothing
    // after — including every reference to this binding — ever runs. The
    // statement lowers to exactly that throw; the binding registers as a
    // trap (references lower to the same never-reached shape), and no
    // storage or type mapping is needed for a value that never exists.
    // Written bindings keep ordinary storage (trapDeclRootOf) — the
    // initializer read still lowers to the root's throw below.
    {
      const root = trapDeclRootOf(L, decl);
      if (root !== null) {
        for (const nameNode of boundIdentifiersOf(decl.name)) {
          const sym = L.checker.getSymbolAtLocation(nameNode);
          if (sym) L.trapBindings.add(sym);
        }
        return {
          kind: "exprStmt",
          expr: nsUndefRead(L, root.text, decl.initializer!, F64),
          loc: locOf(decl),
        };
      }
    }
    if (!ts.isIdentifier(decl.name)) L.unsupported("SC1031", decl.name);

    // A NULLISH generic binding (`const i: I<A & B> = null as any` — the
    // declared type has no mapping, the value is provably null/undefined
    // forever): no storage exists; reads know the value (member reads and
    // method calls lower to Node's exact TypeError, nullish-to-nullish
    // flows to nothing), so the declaration emits nothing.
    if (nullishGenericBindingUnitOf(L, L.checker.getSymbolAtLocation(decl.name) ?? null) !== null) {
      return null;
    }

    // A DEAD unmappable binding (`var xs2: typeof Array;`, the write-only
    // `var f2: { <T, U>(x: T, y: U): T }`): never read anywhere in the
    // program, its initializer (if any) a side-effect-free value — Node
    // materializes the value and drops it, zero observable effect — so
    // the declaration emits nothing instead of fencing on a type the
    // program never consumes.
    if (deadUnmappableBinding(L, L.checker.getSymbolAtLocation(decl.name) ?? null, decl)) {
      return null;
    }

    // An initializer-LESS declaration named `module` or `exports` at the
    // top level of an import/export-free TS file shadows the CommonJS
    // wrapper binding: Node hosts such a file as CJS, where
    // `var module: any;` leaves the REAL module object visible (var
    // re-declaration keeps the wrapper's value) — a compiled module would
    // read undefined where Node reads the module object, so the shape
    // fences instead of diverging. Files with ESM syntax have no wrapper
    // and keep the plain-variable lowering.
    if (
      !decl.initializer &&
      (decl.name.text === "module" || decl.name.text === "exports") &&
      ts.isVariableStatement(decl.parent.parent) &&
      ts.isSourceFile(decl.parent.parent.parent) &&
      !isJsSourceFile(decl.getSourceFile()) &&
      !decl.getSourceFile().statements.some(
        (s) =>
          ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || ts.isExportAssignment(s) ||
          (ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true),
      )
    ) {
      L.unsupported(
        "SC1090",
        decl.name,
        `initializer-less top-level declarations named '${decl.name.text}' in an import/export-free file (Node hosts the file as CommonJS, where the wrapper's own binding keeps its value — the declaration reads as the module object there, which has no lowering; rename the variable or give it an initializer)`,
      );
    }

    // `const execFileAsync = promisify(execFile)` — the one lowered
    // util.promisify shape: the binding registers (calls through it lower
    // to the interned async-exec helper; value uses fence) and the
    // declaration itself emits nothing — the promisified function value
    // never exists at runtime. collectGlobals skipped registering a
    // module global for it by the same test.
    if (L.promisifiedExecFileDecl(decl.name, decl.initializer)) return null;

    // `const inspect = require("util").inspect` — a named import in const
    // clothing: builtinImportOf resolves uses through the module tables;
    // the declaration is alias plumbing and emits nothing (collectGlobals
    // skipped its global by the same test).
    if (builtinMemberRequireDecl(decl.name, decl.initializer)) return null;

    // `const require = createRequire(import.meta.url)` — compile-time
    // plumbing: each call through the binding resolves per site
    // (lowerCreateRequireCall); no storage, no code (collectGlobals
    // skipped its global by the same test).
    if (!isLet && createRequireBindingDecl(L, decl.name, decl.initializer)) return null;

    // `const fs = require("node:fs")` through that binding — a builtin
    // namespace import in const clothing: alias plumbing, no storage
    // (builtinNamespaceModuleOf resolves member uses).
    if (!isLet && createRequireNamespaceDecl(L, decl.name, decl.initializer)) return null;

    // `const { NGHTTP2_CANCEL } = http2.constants` — a destructure over
    // the baked constants table: alias plumbing, no storage (uses read
    // their literals via builtinConstantBindingOf; collectGlobals skipped
    // the globals by the same test).
    if (L.builtinConstantsDestructureDecl(decl.name, decl.initializer)) return null;

    // `const Writable = stream.Writable` — a stream class through the
    // namespace binding: alias plumbing, no storage (uses resolve through
    // builtinStreamInfoOf's alias following).
    if (!isLet && streamClassAliasDecl(L, decl.name, decl.initializer)) return null;

    // `const process = globalThis.process` — a stdlib-global snapshot:
    // alias plumbing (see stdlibGlobalAliasDecl), no storage, no code.
    if (!isLet && stdlibGlobalAliasDecl(L, decl.name, decl.initializer)) return null;

    // `const encoder = new TextEncoder()` and a statically-labelled
    // TextDecoder twin: the codec has no general value representation, but calls
    // through this stable binding resolve back to the initializer. The
    // supported constructors are effect-free, so the declaration itself
    // is compile-time alias plumbing with no storage or code.
    if (!isLet && textCodecBindingDecl(L, decl.name, decl.initializer)) return null;

    // `const f = <T>(x: T) => x` — a generic function value binding: the
    // initializer monomorphizes per call-site-resolved signature exactly
    // like a generic function declaration (bindingGenericFnInfoOf —
    // file-scope declarations registered at collection, block-scoped ones
    // here, before any use in source order can lower), the binding has no
    // runtime value, and the statement emits nothing. Non-qualifying
    // shapes (reassigned bindings, declarations inside functions) fence
    // by name inside; a collection-time report dedupes.
    {
      const gfnNode = bindingGenericFnNodeOf(decl) ?? bindingContextualGenericFnNodeOf(L, decl);
      if (gfnNode) {
        bindingGenericFnInfoOf(L, decl, gfnNode);
        return null;
      }
    }

    // `const h = id` — an ALIAS of a generic function: the alias's symbol
    // registers the target's info (calls and pinned values resolve like
    // the target's own name), the binding has no runtime value, and the
    // statement emits nothing (collectGlobals skipped module-scope
    // globals by the same test; block-scoped aliases register here).
    if (bindingGenericFnAliasInfoOf(L, decl)) return null;

    // `const knownBy = (cmd) => ...` — an IMPLICIT-ANY function-value
    // binding in npm-static JS (function-scope bindings register here, in
    // source order before any use can lower; file-scope ones registered at
    // collection): calls monomorphize per argument types like a generic
    // binding, the binding has no runtime value, and the statement emits
    // nothing. Non-qualifying shapes (captures, reassignment, typed
    // params) answered null and keep today's closure story.
    {
      const implicitNode = implicitLocalFnNodeOf(L, decl);
      if (implicitNode) {
        implicitLocalFnInfoOf(L, decl, implicitNode);
        return null;
      }
    }

    // `const M = (Base: Ctor) => class extends Base {…}` — a NON-generic
    // mixin function binding: no runtime value exists (calls instantiate
    // per site — lower-mixins.ts); the statement emits nothing
    // (collectGlobals skipped its global by the same test).
    if (!isLet && isMixinFnBinding(L, decl)) return null;

    // `const Thing1 = Tagged(Derived)` — a mixin RESULT binding
    // (registered like a class declaration by collectGlobals; block-scoped
    // spellings fence inside the instantiation's position check): the
    // binding IS the instantiation's immortal class object — no storage,
    // no code. The demand here is idempotent (cached per call site) and
    // owns the diagnostics when the instantiation fences.
    if (!isLet && ts.isIdentifier(decl.name) && decl.initializer !== undefined) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && mixinResultBindingClassOf(L, L.checker.getSymbolAtLocation(decl.name))) {
        return null;
      }
    }

    // File-scope declarations were pre-registered as module globals: the
    // "declaration" inside the init function is just the first assignment
    // (statics are zero/NULL-initialized; uninitialized globals need no
    // statement at all).
    const declSymbol = L.checker.getSymbolAtLocation(decl.name);
    const g = declSymbol ? L.globalsBySymbol.get(declSymbol) : undefined;
    if (g) {
      if (!decl.initializer) {
        // `let x: string | undefined;` at file scope: READABLE before any
        // assignment — JS gives undefined, so the slot must hold the
        // interned undefined arm, not stay NULL (a tag test on NULL would
        // fault). Other uninitialized globals need no statement (tsc's
        // definite-assignment analysis guards their reads).
        // `var x: string | undefined;` emits nothing HERE: its undefined
        // arm was assigned at the file init's entry (lowerFileInit's var
        // hoisting), and re-running the statement — a declaration inside
        // a loop — must NOT reset the persisting binding.
        if (isVarDeclared(decl)) return null;
        // Checked-dynamic globals hold the dyn undefined from their
        // declaration statement on; unions and jsval ride
        // unassignedSlotInit's arms.
        const wrapped = g.type.kind === "dyn" ? dynUndefinedExpr(locOf(decl)) : L.unassignedSlotInit(g.type, locOf(decl));
        if (wrapped) return { kind: "assign", localId: g.id, value: wrapped, loc: locOf(decl) };
        return null;
      }
      const init = L.lowerExprExpecting(decl.initializer, g.type);
      return { kind: "assign", localId: g.id, value: init, loc: locOf(decl) };
    }

    // A forward-captured const pre-declared as a TDZ box (an earlier
    // function in this scope captured it — predeclareForwardCapture): the
    // binding and its scope-entry varDecl already exist; the source
    // declaration is the one initializing `assign` into the shared box.
    const pre = declSymbol ? L.tdzPredeclared.get(declSymbol) : undefined;
    if (pre && decl.initializer) {
      L.tdzPredeclared.delete(declSymbol!);
      const init = L.lowerExprExpecting(decl.initializer, pre.type);
      return { kind: "assign", localId: pre.id, value: init, loc: locOf(decl) };
    }

    // `var x = e` — an ASSIGNMENT into the function-scoped hoisted slot
    // (hoistVarBinding mints it on first encounter and pushes its varDecl
    // at the function root). Hoist-before-init so `var f = function () {
    // f(); }` resolves the self-reference to the binding it initializes.
    // `var x;` alone emits nothing: the binding exists (undefined-armed
    // types already hold the interned undefined arm), and a declaration
    // re-run in a loop must not reset the persisting value.
    if (isVarDeclared(decl) && declSymbol) {
      const local = hoistVarBinding(L, declSymbol, decl.name);
      if (!decl.initializer) return null;
      const init = L.lowerExprExpecting(decl.initializer, local.type);
      return { kind: "assign", localId: local.id, value: init, loc: locOf(decl) };
    }

    if (!decl.initializer) {
      // `let x: number;` — declared, uninitialized. tsc guarantees no read
      // before assignment (TS2454) and rejects uninitialized const (TS1155).
      // Unannotated `let x;` is an evolving `any` — the checked-dynamic
      // binding fallback (irTypeOf → dynFallbackType).
      // Undefined-armed unions (`let x: string | undefined;`) are readable
      // immediately (the type covers the unassigned state), so they
      // initialize to the interned undefined arm like an omitted optional.
      let type = L.irTypeOf(decl.name);
      // `var v: void;` / `let x: undefined;` — a unit-only binding rides
      // the unit-only union (its undefined arm is the unassigned state,
      // which is also the only state).
      if (type.kind === "void" && isUnitOnlyTsType(L.typeOf(decl.name))) {
        type = unitOnlyUnion(L.unions);
      }
      if (type.kind === "void") L.badType(decl.name, L.typeOf(decl.name));
      const local = L.declareLocal(decl.name, decl.name.text, type, isLet);
      // tsc's definite-assignment analysis never guards `any` reads, so
      // uninitialized bindings must hold their world's undefined, never
      // NULL: unions the interned arm, dyn the dyn undefined, jsval the
      // engine's — all readable immediately, exactly Node.
      const init = type.kind === "dyn" ? dynUndefinedExpr(locOf(decl)) : L.unassignedSlotInit(type, locOf(decl));
      return { kind: "varDecl", localId: local.id, init, loc: locOf(decl) };
    }

    // Initializer first: `const f = () => ...` should report the arrow
    // function (with its hint), not the unmappable declared type. If it
    // poisons, still declare the local when its type is representable, so
    // later references to this name don't produce cascading errors.
    let init: IrExpr;
    try {
      init = immediatelyGuardedAbsenceProbe(L, decl)
        ? (lowerAbsenceProbe(L, decl.initializer) ?? L.lowerExpr(decl.initializer))
        : L.lowerExpr(decl.initializer);
    } catch (e) {
      if (e instanceof PoisonError) {
        const salvaged = L.mapTypeOf(L.typeOf(decl.name));
        if (salvaged && salvaged.kind !== "void") {
          L.declareLocal(decl.name, decl.name.text, salvaged, isLet);
        }
      }
      throw e;
    }
    // A dyn initializer under an unmappable declared type (`const ws =
    // pkg.workspaces` — the lowering world types the unknown-receiver read
    // `any`, which a static build cannot hold): the VALUE is a dyn
    // subtree, so the local stays dyn — later narrowing tests and checked
    // casts read it like any JSON.parse result.
    // `const p = import("./m")` / `const ns = await import("./m")`: the
    // island promise/handle is the import expression's only production —
    // the binding holds it, whatever the checker's namespace type mapped
    // to (the island-HANDLE local story). Below that: a never-tainted JS
    // binding type (`const cmd = ['pwd', []]` infers (string | never[])[])
    // is inference residue, not element information — unmappable, so the
    // dyn initializer keeps the binding checked-dynamic.
    const bindingTainted = neverTaintedJsType(L, decl.name, L.typeOf(decl.name));
    let type =
      (L.dynamic &&
      (init.type.kind === "jsval" ||
        (init.type.kind === "promise" && init.type.inner.kind === "jsval"))
        ? (importCallHandleType(decl.initializer) ??
          // An unchecked-overload call result (the resolved overload's
          // return type was never checked against the jsval-returning
          // implementation): the binding stores the handle — see
          // uncheckedOverloadHandleCall.
          (init.type.kind === "jsval" && uncheckedOverloadHandleCall(L, decl.initializer) ? JSVAL : null))
        : null) ??
      // The runtime-world local rule, dyn side (383(d)'s dispatch stance —
      // the island-HANDLE local rule's mirror): a binding whose
      // INITIALIZER lowered checked-dynamic stays dyn even where the
      // checker spells 'any' (`const parsers = options.parsers ?? {}` over
      // an 'object'-typed bag — the read is a dyn keyed read). Marshaling
      // into the engine here would deep-copy data and sever aliasing; the
      // value's world is the honest dispatch, and every use site already
      // handles dyn (validated exits, routed engine ops for wrapped
      // island members).
      (L.dynamic && init.type.kind === "dyn" && jsvalFlavoredType(L.mapTypeOf(L.typeOf(decl.name)) ?? DYN) ? DYN : null) ??
      (bindingTainted ? null : L.mapTypeOf(L.typeOf(decl.name))) ??
      (init.type.kind === "dyn" ? DYN : null);
    // A JS `let x = {}`: TS's empty-object-literal type admits ANY later
    // non-nullish assignment (`envs = {}`, later `envs =
    // Object.fromEntries(...)` — tsc accepts every such write, since
    // everything is assignable to `{}`), so the static EMPTY struct shape
    // cannot hold the binding's future. The binding is checked-dynamic
    // instead (irTypeOf's JS story): writes dynFrom, typed exits dynCheck.
    // Const keeps the static empty record — no reassignment exists.
    if (isLet && type?.kind === "record" && isJsSourceFile(decl.getSourceFile())) {
      const shape = L.shapes.get(type.shapeId);
      if (shape && shape.fields.length === 0 && !shape.indexValue && !shape.tuple) type = DYN;
    }
    // A JS `const leaked = [];` (the evolving-array idiom — test/common's
    // leak ledger): tsc types the binding by its LATER pushes, but this
    // frontend answers the declaration name with the uninhabited never[],
    // whose f64-element representation cannot hold the binding's future —
    // pushes of anything non-numeric would fence and typed exits would
    // mismatch the checker's evolved reads downstream. The binding is
    // checked-dynamic instead (the `let x = {}` stance, and lower-modules'
    // file-scope evolving-array rule): pushes ride the dyn array, typed
    // exits dynCheck.
    if ((type === null || type.kind === "array") && isJsSourceFile(decl.getSourceFile())) {
      let initExpr: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(initExpr)) initExpr = initExpr.expression;
      if (ts.isArrayLiteralExpression(initExpr) && initExpr.elements.length === 0) {
        const t = L.typeOf(decl.name);
        if (L.checker.isArrayType(t)) {
          const elem = L.checker.getTypeArguments(t as ts.TypeReference)[0];
          if (elem !== undefined && (elem.flags & (ts.TypeFlags.Never | ts.TypeFlags.Any)) !== 0) type = DYN;
        }
      }
    }
    // An unannotated binding holding an OOB-SAFE indexed read (`elem |
    // undefined`) where the checker spells the bare element: the binding
    // adopts the runtime-honest union. This covers both inferred package JS
    // and TypeScript's fresh-array probe idioms; an explicit annotation keeps
    // the caller's checked slot contract.
    let runtimeOptional = false;
    if (
      !decl.type && type !== null && init.type.kind === "union" &&
      L.armTag(init.type.unionId, UNDEFINED_T) >= 0 &&
      typeEquals(L.stripUndefinedArm(init.type), type)
    ) {
      type = init.type;
      runtimeOptional = true;
    }
    // A JS binding whose checker type spells a FUNCTION but whose VALUE is
    // already checked-dynamic (`const cb = mustCall(fn)` — the helper's
    // return rides its own box): keep the box. Extracting into the spelled
    // static signature would wrap an arity-narrowing adapter that DROPS
    // arguments JS would deliver; calls through the dyn binding take the
    // boxed thunk's JS arity instead.
    if (type?.kind === "func" && init.type.kind === "dyn" && isJsSourceFile(decl.getSourceFile())) {
      type = DYN;
    }
    // A checker-`any` CONST whose initializer lowered to a STATIC type
    // (`const name = rawName ? rawName.replace(...) : null` — the
    // dyn-receiver machinery and the any-ternary join answer static IR):
    // adopt the initializer's type. Checker-`any[]` decls take the same
    // rule (`const tlds = Array.isArray(u) ? u : [u]` — tsc's readonly
    // Array.isArray quirk types the ternary any[], while the arms lower
    // to the union's real array arm; readonly fixed-tuple narrows adopt
    // their tuple record likewise). Const only — an evolving-`any`
    // `let` may be reassigned a different shape later; genuine `any`
    // only — every other unmappable keeps its own diagnostic.
    if (
      type === null && !isLet &&
      ((L.typeOf(decl.name).flags & ts.TypeFlags.Any) !== 0 ||
        (L.checkerAnyArray(decl.name) && L.isArrayValueType(init.type)) ||
        // JS declarations carry no annotations: an unmappable inferred
        // type (a union with a fence-folded arm — the typeof-'bigint'
        // dual-mode ternary) adopts the initializer's static type, the
        // same rule genuine `any` consts take.
        isJsSourceFile(decl.getSourceFile())) &&
      init.type.kind !== "void" && init.type.kind !== "caught" && init.type.kind !== "jsval" &&
      !isUnitType(init.type)
    ) {
      type = init.type;
    }
    if (!type) {
      // The JS declaration fallback (irTypeOf's story): the binding holds
      // the checked-dynamic kind when even the initializer's type has no
      // static home.
      const js = dynFallbackType(L, decl.name, L.typeOf(decl.name));
      if (js) type = js;
    }
    if (!type) L.badType(decl.name, L.typeOf(decl.name));
    // `const x: void = undefined` / `let y: undefined = undefined`: the
    // unit-only union — the initializer's unit literal wraps into its arm
    // like any optional completion. Non-literal void initializers (a
    // void CALL's result) keep their fence at the coercion below.
    if (type.kind === "void" && isUnitOnlyTsType(L.typeOf(decl.name))) {
      type = unitOnlyUnion(L.unions);
    }
    if (type.kind === "void") L.badType(decl.name, L.typeOf(decl.name));
    // A PACKAGE promise stored in a local stays an island HANDLE — the
    // engine's promise has no static promise value to coerce into. Awaits
    // and .catch/.finally chains on the local bridge per use site (each
    // bridge is an independent observer of the same settlement).
    if (init.type.kind === "jsval" && type.kind === "promise") type = JSVAL;
    // An island value under an `any[]`-declared LOCAL spelling stays an
    // island HANDLE too (the runtime-world rule): the jsval-element-array
    // exit is a CALL-boundary conversion (the loadPlugins param ABI) —
    // converting a local would strand the engine's own prototypes
    // (join/map/... on a native handle-element array), where the handle
    // routes every use engine-side.
    if (init.type.kind === "jsval" && type.kind === "array" && type.elem.kind === "jsval") {
      type = JSVAL;
    }
    // A STATIC array of island HANDLES under an unannotated declared type
    // spelling evolved elements (`const kept = fns.filter(...)` over an
    // evolving-`any` receiver — the handle-element lowering keeps the
    // elements jsval, while tsc's evolving-array analysis types the
    // result by the pushed elements): the value's element type is the
    // truth, so the binding keeps the handle-element array (the
    // island-HANDLE local story, one level down) and later method calls
    // ride the handle-element lowering. Explicit annotations keep the
    // validated-boundary fence.
    if (
      !decl.type &&
      init.type.kind === "array" && init.type.elem.kind === "jsval" &&
      type.kind === "array" && type.elem.kind !== "jsval"
    ) {
      type = init.type;
    }
    // `const runner = options.runner || defaultRunner`: the checker types
    // the || as the union/merge of two structurally-compatible function
    // types — a signature whose RETURN is the arms' union, or the
    // spawnRes-returning one — while the VALUE the || produced is the
    // record-returning arm every consumer reads. Adopt the init's type
    // when the parameters agree and the declared return either contains
    // the init's return as a union arm or is the opaque spawnRes the
    // adapter converts (nothing coerces INTO either declared form).
    if (type.kind === "func" && init.type.kind === "func" && !typeEquals(type, init.type)) {
      const initFn = init.type;
      const paramsAgree =
        type.params.length === initFn.params.length &&
        type.params.every((p, i) => typeEquals(p, initFn.params[i]!));
      const retUnionArm =
        type.ret.kind === "union" && L.armTag(type.ret.unionId, initFn.ret) >= 0;
      if (paramsAgree && (retUnionArm || L.spawnResFnAdapterPlan(type, initFn) !== null)) {
        type = init.type;
      }
    }
    // The downstream twin: `const result = runner(cmd, args)` where the
    // checker still sees the merged signature — its return union pairs
    // the structural record with the OPAQUE spawnRes, a fiction no read
    // can narrow (spawnRes has no discriminant). The VALUE is statically
    // the record arm, so the local adopts it; flows into the union slot
    // re-wrap via the ordinary arm coercion.
    if (type.kind === "union" && init.type.kind === "record") {
      const arms = L.unions.get(type.unionId)?.arms ?? [];
      if (
        arms.length === 2 &&
        arms.some((a) => a.kind === "spawnRes") &&
        arms.some((a) => typeEquals(a, init.type))
      ) {
        type = init.type;
      }
    }
    // `const r: Repo = new MemRepo()` over an all-generic-method
    // interface: the binding keeps the initializer's CLASS representation
    // (the record shape maps empty and the width copy would drop the
    // class the generic-method calls monomorphize against) — see
    // genericIfaceBindingKeepsClass.
    if (type.kind === "record" && init.type.kind === "object" && genericIfaceBindingKeepsClass(L, decl, type)) {
      type = init.type;
    }
    // A TDZ box minted DURING this very initializer (a callback inside it
    // captured this const — predeclareForwardCapture's current-statement
    // case): the binding and its scope-entry varDecl already exist, so
    // this declaration is the initializing `assign` into the shared box,
    // not a fresh local.
    const preSelf = declSymbol ? L.tdzPredeclared.get(declSymbol) : undefined;
    if (preSelf) {
      L.tdzPredeclared.delete(declSymbol!);
      init = L.coerceInto(decl.initializer, init, preSelf.type);
      return { kind: "assign", localId: preSelf.id, value: init, loc: locOf(decl) };
    }
    // Slot coercion: `const r: A | B = bValue;` wraps implicitly; width
    // subtyping (`const p: {a: number} = wider;`) is rejected, not coerced.
    init = L.coerceInto(decl.initializer, init, type);
    const local = L.declareLocal(decl.name, decl.name.text, type, isLet);
    if (runtimeOptional) {
      const runtimeOptionalRoot = L.runtimeOptionalRootOf(local);
      L.runtimeOptionalLocals.add(runtimeOptionalRoot);
      L.runtimeOptionalStorageLocals.add(runtimeOptionalRoot);
    }
    return { kind: "varDecl", localId: local.id, init, loc: locOf(decl) };
  }

  function immediatelyGuardedAbsenceProbe(L: Lowerer, decl: ts.VariableDeclaration): boolean {
    if (decl.type || !ts.isIdentifier(decl.name) || !decl.initializer) return false;
    const statement = decl.parent?.parent;
    if (!statement || !ts.isVariableStatement(statement)) return false;
    const container = statement.parent;
    const statements = ts.isBlock(container) || ts.isSourceFile(container) ? container.statements : null;
    if (!statements) return false;
    const index = statements.indexOf(statement);
    const next = index >= 0 ? statements[index + 1] : undefined;
    if (!next || !ts.isIfStatement(next)) return false;
    let condition = next.expression;
    while (ts.isParenthesizedExpression(condition)) condition = condition.expression;
    if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false;
    let operand = condition.operand;
    while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
    return ts.isIdentifier(operand) && L.resolveValueSymbol(operand) === L.resolveValueSymbol(decl.name);
  }

  function falsyExitRuntimeOptionalLocal(L: Lowerer, stmt: ts.IfStatement): IrLocal | null {
    if (stmt.elseStatement) return null;
    let condition = stmt.expression;
    while (ts.isParenthesizedExpression(condition)) condition = condition.expression;
    if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return null;
    let operand = condition.operand;
    while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
    if (!ts.isIdentifier(operand)) return null;
    const local = L.resolveLocal(operand);
    if (!local || !L.runtimeOptionalLocals.has(L.runtimeOptionalRootOf(local))) return null;
    const exits = ts.isReturnStatement(stmt.thenStatement) || ts.isThrowStatement(stmt.thenStatement) ||
      (ts.isBlock(stmt.thenStatement) && stmt.thenStatement.statements.length > 0 &&
        (ts.isReturnStatement(stmt.thenStatement.statements[stmt.thenStatement.statements.length - 1]!) ||
          ts.isThrowStatement(stmt.thenStatement.statements[stmt.thenStatement.statements.length - 1]!)));
    return exits ? local : null;
  }

/** JS-exact switch (see docs/ir.md): one shared lexical scope for all case
   * bodies, lazy source-order test evaluation, fall-through. tsc has already
   * checked case-test comparability (TS2678) — the kind check below is the
   * backstop for cases tsc lets through (e.g. `unknown as` casts). */
  export function lowerSwitch(L: Lowerer, stmt: ts.SwitchStatement): IrStmt {
    // Labels consume HERE, before any nested statement can see them; the
    // union desugar drops them (its if/else chain has no switch-end label
    // point — labeled jumps naming this switch fence at the jump).
    const labels = L.takeLabels();
    const disc = L.lowerExpr(stmt.expression);
    const dk = disc.type.kind;
    if (dk === "dyn") {
      L.unsupported("SC1100", stmt.expression, "switch statements on 'unknown' values");
    }
    if (dk === "union") return lowerUnionSwitch(L, stmt, disc);
    if (dk !== "f64" && dk !== "string" && dk !== "bool") {
      L.unsupported("SC1090", stmt.expression, "switch on non-primitive values");
    }
    // The whole case-body sequence is ONE lexical scope in JS: a bare `let`
    // in one case is visible in later cases.
    L.scopes.push(new Map());
    try {
      const cases: { test: IrExpr | null; body: IrStmt[] }[] = [];
      for (const clause of stmt.caseBlock.clauses) {
        let test: IrExpr | null = null;
        if (ts.isCaseClause(clause)) {
          test = L.lowerExpr(clause.expression);
          if (test.type.kind !== dk) {
            L.unsupported(
              "SC1090",
              clause.expression,
              "switch case tests of a different type than the discriminant",
            );
          }
        }
        cases.push({ test, body: L.inCtl("switch", () => L.lowerStmts(clause.statements), labels) });
      }
      return { kind: "switch", disc, cases, ...(labels && { labels }), loc: locOf(stmt) };
    } finally {
      L.scopes.pop();
    }
  }

/** Switch on a UNION-typed discriminant (`switch (m.type)` over
   * `string | undefined`): desugared to an if/else-if chain of per-union
   * strict-equality tests (unionEq — the case value wraps into the union,
   * exactly `disc === test`), because the backend switch compares plain
   * primitives only. The desugar is JS-exact for the shape it accepts and
   * fences everything it cannot reproduce:
   * - the discriminant rides every test, so it must be a plain
   *   side-effect-free read (bind it to a const first otherwise);
   * - tests evaluate lazily in source order (the chain's short-circuit IS
   *   the switch's test order — grouped empty cases `case a: case b:` OR
   *   their tests, still in order);
   * - each non-final clause must EXIT (a trailing unconditional break —
   *   dropped, it's the chain's own exit — or a return/throw/continue):
   *   real fall-through between bodies has no if/else shape;
   * - any OTHER unlabeled break binding to this switch (a conditional
   *   early break) is fenced — desugared, it would bind to an enclosing
   *   loop instead;
   * - `default` may sit anywhere in source (JS tests every case first;
   *   the chain's final else reproduces that as long as its body exits or
   *   is last).
   * Case bodies share ONE lexical scope, exactly like the real switch. */
  export function lowerUnionSwitch(L: Lowerer, stmt: ts.SwitchStatement, disc: IrExpr): IrStmt {
    const loc = locOf(stmt);
    if (disc.type.kind !== "union") throw new Error("lowerer bug: non-union disc");
    const unionType = disc.type;
    if (!pureReemittable(disc) || !L.eqComparableUnion(unionType.unionId)) {
      L.unsupported(
        "SC1090",
        stmt.expression,
        "switch on union-typed values that aren't plain reads (the tests re-read the discriminant — bind it to a const first, or switch on a discriminant field)",
      );
    }
    const clauses = stmt.caseBlock.clauses;
    // An unlabeled break at a clause's END exits the switch — the chain's
    // own exit; anywhere else (conditional early breaks) the desugar would
    // rebind it to an enclosing loop. Walk each clause's statements without
    // descending into nested breakable constructs or functions (their
    // breaks are their own).
    const findStrayBreak = (node: ts.Node): ts.Node | null => {
      if (ts.isBreakStatement(node)) return node;
      if (
        ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) ||
        ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node) ||
        ts.isFunctionLike(node)
      ) {
        return null;
      }
      return ts.forEachChild(node, findStrayBreak) ?? null;
    };
    for (const clause of clauses) {
      const last = clause.statements[clause.statements.length - 1];
      for (const s of clause.statements) {
        const stray = s === last && ts.isBreakStatement(s) && !s.label ? null : findStrayBreak(s);
        if (stray) {
          L.unsupported(
            "SC1090",
            stray,
            "early 'break' inside a union-typed switch (only a trailing break exits the desugared chain — restructure with if/else)",
          );
        }
      }
    }
    const exits = (clause: ts.CaseOrDefaultClause): boolean => {
      const last = clause.statements[clause.statements.length - 1];
      return (
        !!last &&
        ((ts.isBreakStatement(last) && !last.label) ||
          ts.isReturnStatement(last) ||
          ts.isThrowStatement(last) ||
          ts.isContinueStatement(last))
      );
    };
    // The whole case-body sequence is ONE lexical scope, like the real
    // switch lowering.
    L.scopes.push(new Map());
    try {
      // Group clauses: consecutive test-only cases (empty statements) share
      // the next body, exactly JS's grouped-case idiom.
      const groups: { tests: IrExpr[]; body: IrStmt[]; isDefault: boolean }[] = [];
      let pendingTests: IrExpr[] = [];
      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i]!;
        if (ts.isCaseClause(clause)) {
          const test = L.lowerExpr(clause.expression);
          // Case tests must be side-effect-free (literals or plain reads):
          // the chain evaluates exactly the tests JS would EXCEPT those of
          // a default-sharing group (dropped — the shared body is the
          // final else, so matching them changes nothing when pure).
          if (
            test.kind !== "strLit" && test.kind !== "numLit" &&
            test.kind !== "boolLit" && test.kind !== "unitLit" &&
            !pureReemittable(test)
          ) {
            L.unsupported(
              "SC1090",
              clause.expression,
              "effectful case tests in a union-typed switch (bind the test value to a const first)",
            );
          }
          // A unit-literal test takes the unit-comparison lowering: a tag
          // test when the arm exists, the constant FALSE when the union
          // lacks it (`case null:` on a `number | undefined` — legal TS,
          // never matches; coercing the literal into the union would hit
          // the stranded-arm trap and throw where JS just skips the case).
          const unitTest =
            test.kind === "unitLit"
              ? L.lowerUnitComparison(disc, test, false, locOf(clause.expression))
              : null;
          pendingTests.push(
            unitTest ?? {
              kind: "unionEq",
              unionId: unionType.unionId,
              negated: false,
              sameValue: false,
              left: disc,
              right: L.coerceInto(clause.expression, test, unionType),
              type: BOOL,
              loc: locOf(clause.expression),
            },
          );
        }
        const isDefault = ts.isDefaultClause(clause);
        if (clause.statements.length === 0 && !isDefault && i < clauses.length - 1) {
          continue; // grouped with the next clause
        }
        if (!exits(clause) && i < clauses.length - 1 && (clause.statements.length > 0 || isDefault)) {
          // A non-final body that doesn't exit falls into the NEXT body in
          // JS — no if/else shape reproduces that (an EMPTY non-final
          // default falls through too; empty non-final cases just group).
          L.unsupported(
            "SC1090",
            clause,
            "fall-through between case bodies in a union-typed switch (end each case with break/return/throw/continue)",
          );
        }
        const last = clause.statements[clause.statements.length - 1];
        const stmts = last && ts.isBreakStatement(last)
          ? clause.statements.slice(0, -1)
          : clause.statements.slice();
        const body = L.lowerStmts(stmts);
        groups.push({ tests: pendingTests, body, isDefault });
        pendingTests = [];
      }
      // A default clause anywhere lands in the chain's final else; JS
      // reaches it only after every case test fails, which the chain
      // reproduces because default bodies that don't exit were fenced
      // above (unless last in source, where falling out is falling out).
      const defaultBody = groups.find((g) => g.isDefault)?.body ?? null;
      const caseGroups = groups.filter((g) => !g.isDefault);
      let chain: IrStmt[] = defaultBody ?? [];
      for (let i = caseGroups.length - 1; i >= 0; i--) {
        const g = caseGroups[i]!;
        let cond = g.tests[0];
        if (!cond) continue; // a default-adjacent group with no tests (defensive)
        for (const t of g.tests.slice(1)) {
          cond = { kind: "logical", op: "||", left: cond, right: t, type: BOOL, loc };
        }
        chain = [{ kind: "if", cond, then: g.body, else_: chain.length > 0 ? chain : null, loc }];
      }
      return { kind: "block", body: chain, loc };
    } finally {
      L.scopes.pop();
    }
  }

/** try/catch/finally. Supported subset:
   * - `catch { }` (bindingless) discards the thrown value on entry.
   * - `catch (e)` binds it as a CAUGHT local — a snapshot of the exception
   *   cell, deliberately narrower than dyn: the supported uses are the
   *   narrowing tests (`e instanceof C` over hierarchy classes, `typeof e
   *   === "string"/"number"/"boolean"`), reads under a proven narrow
   *   (caughtRead bridges them with caughtNarrow, trust-the-checker like
   *   unionNarrow), and rethrow (`throw e`). Raw uses, captures, and
   *   assignment are fenced (SC1063 and friends); destructuring patterns
   *   are SC1062. The `: any` / `: unknown` annotations tsc admits both
   *   lower the same way (tsc narrows either through the tests).
   * - `finally` runs on normal completion, on exception paths, and on the
   *   way out of a `return` in the try/catch body (the backend's
   *   pending-return path — inner-to-outer through nested finallys, the
   *   value snapshotted before the finally runs, Node-exact).
   *   break/continue crossing a try-with-finally stay rejected, as does
   *   any jump out of the finally body itself (it would replace a pending
   *   completion — rejectJumpCrossingFinally). Plain try/catch places no
   *   restriction on jumps.
   * Each block is its own lexical scope (the binding lives in a scope
   * WRAPPING the catch block, like the spec's catch environment). */
  export function lowerTry(L: Lowerer, stmt: ts.TryStatement): IrStmt {
    const hasFinally = stmt.finallyBlock !== undefined;
    // try/catch bodies are jump-fenced only when a finally guards them.
    const lowerGuarded = (block: ts.Block): IrStmt[] =>
      hasFinally
        ? L.inCtl("tryFinally", () => L.lowerScopedBlock(block))
        : L.lowerScopedBlock(block);
    const tryBody = lowerGuarded(stmt.tryBlock);
    let catchBody: IrStmt[] | null = null;
    let catchLocalId: string | null = null;
    if (stmt.catchClause) {
      const vd = stmt.catchClause.variableDeclaration;
      if (vd && !ts.isIdentifier(vd.name)) {
        L.unsupported("SC1062", vd);
      }
      if (vd && ts.isIdentifier(vd.name)) {
        L.scopes.push(new Map());
        try {
          const local = L.declareLocal(vd.name, vd.name.text, CAUGHT, false);
          catchLocalId = local.id;
          catchBody = lowerGuarded(stmt.catchClause.block);
        } finally {
          L.scopes.pop();
        }
      } else {
        catchBody = lowerGuarded(stmt.catchClause.block);
      }
    }
    const finallyBody = stmt.finallyBlock
      ? L.inCtl("finallyBlock", () => L.lowerScopedBlock(stmt.finallyBlock!))
      : null;
    return {
      kind: "tryCatch",
      tryBody,
      catchBody,
      catchLocalId,
      finallyBody,
      loc: locOf(stmt),
    };
  }

/** Statement-position `delete`: process.env keys → process.envUnset
   * (unsetenv), pure `Record<string, T>` keys → recordKeyDelete (the
   * overflow Map delete), declared OPTIONAL fields → the undefined-arm
   * write (absence IS the undefined arm; divergence 60). Everything else
   * fences with the honest reason — a required field is a struct slot no
   * runtime can remove. */
  function lowerDeleteStatement(L: Lowerer, expr: ts.DeleteExpression): IrStmt {
    const loc = locOf(expr);
    let target: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (!ts.isElementAccessExpression(target) && !ts.isPropertyAccessExpression(target)) {
      L.unsupported("SC1090", expr, "'delete' of non-property expressions");
    }
    const lowerKey = (): IrExpr => {
      if (ts.isPropertyAccessExpression(target)) {
        return { kind: "strLit", value: target.name.text, type: STRING, loc: locOf(target.name) };
      }
      const keyNode = (target as ts.ElementAccessExpression).argumentExpression;
      const key = L.lowerExpr(keyNode);
      if (key.type.kind !== "string") {
        L.unsupported(
          "SC1090",
          keyNode,
          `'delete' with '${L.fmt(key.type)}' keys (index-signature and env keys are strings)`,
        );
      }
      return key;
    };
    if (L.isProcessEnv(target.expression)) {
      return {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "process.envUnset", args: [lowerKey()], type: VOID, loc },
        loc,
      };
    }
    const obj = L.lowerExpr(target.expression);
    if (obj.type.kind === "record") {
      const shape = L.shapes.get(obj.type.shapeId);
      if (shape?.indexValue && shape.fields.length === 0 && !shape.tuple) {
        return { kind: "recordKeyDelete", obj, shapeId: obj.type.shapeId, key: lowerKey(), loc };
      }
      // `delete r.f` of a declared OPTIONAL field (undefined-armed slot) is
      // the undefined-arm write: a monomorphic shape cannot remove its
      // slot, and absence IS the undefined arm (divergences 37/56), so the
      // observable results — `in` answers false, Object.keys skips it,
      // JSON.stringify drops it — match Node's post-delete answers exactly
      // (divergence 60 documents the delete/`= undefined` collapse).
      // Constant keys only (dot access or a literal bracket); required
      // fields keep the honest fence below.
      const fieldName = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isStringLiteral(target.argumentExpression)
          ? target.argumentExpression.text
          : null;
      const field = fieldName !== null && !shape?.tuple
        ? shape?.fields.find((f) => f.name === fieldName)
        : undefined;
      if (field) {
        const absent = L.wrappedUndefined(field.type, loc);
        if (absent) {
          return { kind: "recordSet", obj, shapeId: obj.type.shapeId, field: field.name, value: absent, loc };
        }
      }
      if (shape?.indexValue) {
        L.unsupported(
          "SC1090",
          expr,
          "'delete' of hybrid index-signature keys (declared struct slots and overflow entries answer differently — model deletable dynamic keys with a pure Record<string, T>)",
        );
      }
      L.unsupported(
        "SC1090",
        expr,
        "'delete' of required record fields (a monomorphic shape cannot remove its slot — only optional fields delete, becoming the undefined arm)",
      );
    }
    L.unsupported(
      "SC1090",
      expr,
      `'delete' on '${L.fmt(obj.type)}' receivers (process.env keys and pure Record<string, T> keys delete)`,
    );
  }

/** The exact `Object.defineProperty(exports|module.exports, "__esModule",
 * { value: true })` interop stamp (see the no-op lowering above). */
function isEsModuleStamp(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr) || expr.questionDotToken !== undefined) return false;
  const callee = expr.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    !ts.isIdentifier(callee.name) ||
    callee.name.text !== "defineProperty"
  ) {
    return false;
  }
  if (expr.arguments.length !== 3) return false;
  const [recv, nameArg, desc] = expr.arguments as unknown as [ts.Expression, ts.Expression, ts.Expression];
  const isExports =
    (ts.isIdentifier(recv) && recv.text === "exports") ||
    (ts.isPropertyAccessExpression(recv) &&
      ts.isIdentifier(recv.expression) &&
      recv.expression.text === "module" &&
      ts.isIdentifier(recv.name) &&
      recv.name.text === "exports");
  if (!isExports) return false;
  if (!ts.isStringLiteral(nameArg) || nameArg.text !== "__esModule") return false;
  if (!ts.isObjectLiteralExpression(desc) || desc.properties.length !== 1) return false;
  const p = desc.properties[0]!;
  return (
    ts.isPropertyAssignment(p) &&
    ts.isIdentifier(p.name) &&
    p.name.text === "value" &&
    p.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

/** A top-level CommonJS export statement (see cjsExportAssignmentOf):
   * `exports.f = <expr>` and each expression-valued property of
   * `module.exports = { ... }` assign their pre-registered export globals
   * at this statement's source position (the `export default` shape);
   * identifier/shorthand properties lower to nothing — importers resolve
   * through them to the referenced declarations (resolveValueSymbol).
   * Everything the subset doesn't model keeps a named fence. */
  function lowerCjsExportStatement(
    L: Lowerer,
    cjs: NonNullable<ReturnType<typeof cjsExportAssignmentOf>>,
  ): IrStmt {
    const loc = locOf(cjs.expr);
    // Statements Node discards (a replaced export object) fence instead of
    // shipping tsc's answer — the checker models them as live exports.
    {
      const stmt = cjs.expr.parent;
      const discarded = ts.isExpressionStatement(stmt) ? cjsExportDiscardReason(stmt) : null;
      if (discarded !== null) L.unsupported("SC1090", cjs.expr, discarded);
    }
    const assignExport = (nameNode: ts.Node, value: ts.Expression): IrStmt => {
      const symbol =
        L.checker.getSymbolAtLocation(nameNode) ??
        (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)
          ? L.cjsModuleExportSymbol(cjs.expr.getSourceFile(), nameNode.text)
          : undefined);
      const g = symbol ? L.globalsBySymbol.get(symbol) : undefined;
      if (!g) {
        // Registration reported the blocker (or the name form is beyond
        // the subset); re-lower the value so its OWN diagnostic wins.
        L.lowerExpr(value);
        L.badType(value, L.typeOf(value));
      }
      return { kind: "assign", localId: g.id, value: L.lowerExprExpecting(value, g.type), loc: locOf(value) };
    };
    if (cjs.kind === "member") {
      if (!ts.isIdentifier(cjs.name)) {
        L.unsupported("SC1090", cjs.name, "computed or private export names");
      }
      // A member export naming a CLASS declaration is alias plumbing (no
      // storage — collectGlobals skipped it; importers re-resolve through
      // cjsMemberExportClassSymbol): the statement lowers to nothing.
      if (L.cjsMemberExportClassSymbol(cjs.expr) !== null) {
        return { kind: "block", body: [], loc };
      }
      // The tsc VOID-INIT PREAMBLE (`exports.leaf = void 0;` with the real
      // `exports.leaf = leaf;` further down — every tsc-emitted dist file
      // opens its exports this way): the export global takes its value at
      // the REAL assignment, and pushing undefined through a typed slot
      // here would trap at module load. Node's only observable difference
      // is a transient undefined between the two statements — reads in
      // that window are the declaring module's own top-level code, which
      // the real assignment's position already orders. Preambles with no
      // later real assignment keep the ordinary path (the export IS
      // undefined then).
      if (ts.isIdentifier(cjs.name)) {
        const isExportsMember = (e: ts.Expression): e is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(e) &&
          ts.isIdentifier(e.name) &&
          ((ts.isIdentifier(e.expression) && e.expression.text === "exports") ||
            (ts.isPropertyAccessExpression(e.expression) &&
              ts.isIdentifier(e.expression.expression) &&
              e.expression.expression.text === "module" &&
              ts.isIdentifier(e.expression.name) &&
              e.expression.name.text === "exports"));
        const isVoid = (e: ts.Expression): boolean => {
          while (ts.isParenthesizedExpression(e)) e = e.expression;
          return e.kind === ts.SyntaxKind.VoidExpression || (ts.isIdentifier(e) && e.text === "undefined");
        };
        // chains: `exports.a = exports.b = void 0;` collects every name
        const names: string[] = [cjs.name.text];
        let tail: ts.Expression = cjs.value;
        while (
          ts.isBinaryExpression(tail) &&
          tail.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          isExportsMember(tail.left)
        ) {
          names.push((tail.left.name as ts.Identifier).text);
          tail = tail.right;
        }
        if (isVoid(tail)) {
          const sfHere = cjs.expr.getSourceFile();
          const myPos = cjs.expr.getStart(sfHere);
          const laterRealOf = (name: string): boolean =>
            sfHere.statements.some((s) => {
              const other = cjsExportAssignmentOf(s);
              if (other?.kind !== "member" || !ts.isIdentifier(other.name)) return false;
              if (other.name.text !== name) return false;
              if (other.expr.getStart(sfHere) <= myPos) return false;
              return !isVoid(other.value);
            });
          if (names.every(laterRealOf)) return { kind: "block", body: [], loc };
        }
      }
      return assignExport(cjs.name, cjs.value);
    }
    let tableObj = cjs.obj;
    let resolvedTarget = false;
    if (!tableObj) {
      // `module.exports = common` / `= new Proxy(common, handler)` — the
      // identifier/Proxy spellings of a table export: the resolved const
      // literal IS the table (alias plumbing + accessor lifts; the Proxy's
      // traps never run — every access is statically resolved, and any
      // access the target's type rejects never compiled). The properties
      // were already evaluated by the const's own declaration, so this
      // statement may not RE-evaluate anything: expression-valued entries
      // (which the direct-table lowering assigns here) keep a fence.
      tableObj = cjsExportTargetLiteral(cjs.expr.right, cjs.expr.getSourceFile());
      resolvedTarget = tableObj !== null;
      if (!tableObj) {
        const single = lowerCjsSingleValueExport(L, cjs.expr, loc);
        if (single) return single;
        L.unsupported(
          "SC1090",
          cjs.expr,
          "'module.exports =' with a non-literal value (export a class/function/const identifier, a scalar literal, or a literal table: module.exports = { f, g })",
        );
      }
    }
    const table = tableObj!;
    const body: IrStmt[] = [];
    // Identifier-valued properties are alias plumbing (importers resolve
    // through to the declaration) — EXACT for const/function bindings, a
    // live-binding lie for `let`: Node copies the VALUE into the table at
    // this statement, so later reassignments are invisible to importers.
    // Mutable bindings fence instead of diverging silently.
    const fenceMutable = (nameNode: ts.Identifier): void => {
      const sym = L.resolveValueSymbol(nameNode);
      const g = sym ? L.globalsBySymbol.get(sym) : undefined;
      if (g?.mutable) {
        L.unsupported(
          "SC1090",
          nameNode,
          `exporting the mutable 'let' binding '${nameNode.text}' by reference (Node copies its VALUE at this statement — declare it const, or export a function that reads it)`,
        );
      }
    };
    for (const prop of table.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        fenceMutable(prop.name as ts.Identifier);
        continue; // alias plumbing
      }
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
        fenceMutable(prop.initializer);
        continue;
      }
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        // A resolved-target table's expression entries were EVALUATED by
        // the const's own declaration; assigning here would re-run them.
        if (resolvedTarget) {
          L.unsupported(
            "SC1090",
            prop,
            "expression-valued entries in an exported-const table (module.exports = table — bind the value to its own const and export the name)",
          );
        }
        body.push(assignExport(prop.name, prop.initializer));
        continue;
      }
      // ACCESSOR entries: no storage and no code here — reads lift the
      // getter as a module-level function and call it per read
      // (cjsExportAccessorRead); writes through the setter keep their
      // fence at the write site.
      if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) continue;
      // `...require('spec')` SPREAD entries are star-re-export plumbing
      // (the bundler-emitted CJS canonical table — npm-static-rewrite.ts):
      // importers of the spread names resolve statically through the
      // TARGET module's own export machinery (the checker chases the
      // spread; explicit member entries carry the values), and the module
      // LOAD itself rides the ordinary import edge preflight collected —
      // so no runtime copy exists to emit and the entry lowers to nothing.
      if (ts.isSpreadAssignment(prop)) {
        let inner: ts.Expression = prop.expression;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        if (requireSpecOf(inner) !== null) continue;
      }
      L.unsupported(
        "SC1090",
        prop,
        "module.exports table entries beyond plain 'name: value' properties (methods, accessors, spreads, computed names)",
      );
    }
    return { kind: "block", body, loc };
  }

/** `module.exports = <single value>` — Node's whole-export REPLACEMENT by a
   * non-table value: the requirer's binding IS the value (`const Countdown =
   * require('./countdown'); new Countdown(...)` constructs the class). An
   * identifier naming a program class, function, or immutable global is pure
   * alias plumbing — tsc's export-assignment model makes requirer bindings
   * alias straight to the original declaration symbol, so the class registry,
   * function signatures, and globals all apply unchanged — and the statement
   * lowers to nothing. A scalar-literal value has no declaration for aliases
   * to land on: it assigns the pre-registered export global keyed by this
   * statement (collectGlobals; requirer aliases resolve to the checker's
   * `export=` symbol, whose declaration node IS this statement — globalOf's
   * node fallback). Mutable `let` bindings fence: Node copies the VALUE at
   * this statement, while alias plumbing would read the live binding — the
   * exported-table lowering's rule. Null for every shape beyond the subset
   * (the caller's generic fence). */
  function lowerCjsSingleValueExport(L: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrStmt | null {
    let rhs: ts.Expression = expr.right;
    while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
    if (ts.isIdentifier(rhs)) {
      const sym = L.resolveValueSymbol(rhs);
      if (!sym) return null;
      if (L.classBySymbol.has(sym) || L.fnSigsBySymbol.has(sym) || L.genericFnsBySymbol.has(sym)) {
        return { kind: "block", body: [], loc };
      }
      const g = L.globalsBySymbol.get(sym);
      if (g) {
        if (g.mutable) {
          L.unsupported(
            "SC1090",
            rhs,
            `exporting the mutable 'let' binding '${rhs.text}' by reference (Node copies its VALUE at this statement — declare it const, or export a function that reads it)`,
          );
        }
        return { kind: "block", body: [], loc };
      }
      return null;
    }
    // `module.exports = class …{}` — the whole export IS the class
    // (requirers construct their binding: `const C = require('./x');
    // new C()`). The expression collects as a program class right here —
    // its statics queue at this statement, JS's evaluation point — and the
    // statement itself is pure alias plumbing: requirer bindings and
    // in-file `module.exports` references resolve to the class through
    // its symbols (classBySymbol via the export symbol registered below,
    // or the expression's own symbol through propertyAssignedClassInfoOf),
    // so no storage assigns. NamedEvaluation gives these classes name ""
    // (the LHS is a property, not a binding) — Node's answer exactly.
    if (ts.isClassExpression(rhs)) {
      const info = L.lowerClassExpressionInfo(rhs);
      const exportSym = L.checker.getSymbolAtLocation(expr.left);
      if (exportSym && !L.classBySymbol.has(exportSym)) L.classBySymbol.set(exportSym, info);
      return { kind: "block", body: [], loc };
    }
    const g = L.globalsByDeclNode.get(expr);
    if (!g) return null;
    return { kind: "assign", localId: g.id, value: L.lowerExprExpecting(rhs, g.type), loc: locOf(rhs) };
  }

/** Expression-position statements: assignments, calls. Shared with
   * for-loop init/update. Parens unwrap first — `(x = v);` is the plain
   * assignment, and `({ a, b } = e);` (destructuring ASSIGNMENT, which JS
   * requires parenthesized in statement position) lands in the
   * object-literal-target branch below. */
  export function lowerExprStatement(L: Lowerer, expr: ts.Expression): IrStmt {
    const stmtNode = expr.parent;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    // Assignment statements over the no-storage binding families:
    //   - `f1 = f2` where the RHS roots at an ambient-undefined name:
    //     Node evaluates the RHS first and dies on the root's
    //     ReferenceError before any binding is touched — the statement IS
    //     that throw;
    //   - `a = b` between NULLISH generic bindings: the value is known
    //     and the target has no storage — nothing happens;
    //   - a write to a DEAD binding (registration proved every write's
    //     RHS side-effect-free): Node builds the value and drops it —
    //     nothing happens.
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(expr.left)
    ) {
      const rhsRoot = ambientUndefVarRootOf(L, expr.right);
      if (rhsRoot !== null) {
        return {
          kind: "exprStmt",
          expr: nsUndefRead(L, rhsRoot.text, expr.right, F64),
          loc: locOf(expr),
        };
      }
      const targetSym = L.resolveValueSymbol(expr.left);
      if (targetSym !== null) {
        if (nullishGenericBindingUnitOf(L, targetSym) !== null && nullishExprUnitOf(L, expr.right) !== null) {
          return { kind: "block", body: [], loc: locOf(expr) };
        }
        if (L.deadBindings.has(targetSym)) {
          return { kind: "block", body: [], loc: locOf(expr) };
        }
      }
    }
    // A bare module-namespace binding in STATEMENT position (`ns;` for
    // `import * as ns from ...` — the corpus's canonical "the import
    // linked" assertion): Node evaluates an initialized binding (namespace
    // bindings initialize at link, never TDZ — mid-cycle self-references
    // included) and discards the value — zero observable effect, whatever
    // the target module's kind (compiled ESM, a CJS facade, or an edge the
    // program's startup crash precedes). A no-op, exactly Node. VALUE
    // positions keep the first-class-namespace fences.
    if (ts.isIdentifier(expr)) {
      const sym = L.checker.getSymbolAtLocation(expr);
      if (sym !== undefined && L.checker.declarationsOf(sym).some((d) => ts.isNamespaceImport(d))) {
        return { kind: "block", body: [], loc: locOf(expr) };
      }
    }
    // `yield* inner();` — statement-position delegation desugars to the
    // forwarding loop (lower-generators); value positions keep the fence.
    {
      const delegated = lowerYieldStarStatement(L, expr);
      if (delegated) return delegated;
    }
    // CommonJS module statements in a JS file: the module machinery owns
    // them. A bare `require("./x");` is a side-effect load — it lowers to
    // the required module's guarded %init call at exactly this position,
    // WHEREVER it sits (top level, inside a top-level if, inside a
    // function — Node evaluates the module at the first require and cache-
    // hits after); builtin requires load nothing and lower to a no-op.
    // Export assignments assign their pre-registered export globals
    // (collectGlobals); identifier/shorthand table properties are pure
    // alias plumbing and lower to nothing.
    const topLevelJs =
      stmtNode !== undefined &&
      ts.isExpressionStatement(stmtNode) &&
      ts.isSourceFile(stmtNode.parent) &&
      isJsSourceFile(stmtNode.parent);
    if (
      requireSpecOf(expr) !== null &&
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      // A binding NAMED require made by createRequire is not the CJS
      // global — the expression path owns it (lowerCreateRequireCall).
      createRequireCalleeFileOf(L, expr.expression) === null
    ) {
      const sf = expr.getSourceFile();
      const spec = requireSpecOf(expr)!;
      if (L.externalTypes.has(spec)) L.externalHostFence(spec, expr, false);
      // A bare require of a package NOTHING INSTALLED resolves, in ANY
      // CommonJS JS file (the export-assignment spellings tsgo marks
      // external included): Node throws MODULE_NOT_FOUND at exactly this
      // site (message with the one-entry require stack), CATCHABLE — the
      // optional-dependency try/require pattern. The compiled statement
      // IS that throw, wherever it sits.
      if (isCjsJsFile(sf)) {
        if (
          !isRelativeSpecifier(spec) &&
          canonicalBuiltinModule(spec) === null
        ) {
          const refusal = probeNodeRequireRefusal(sf.fileName, spec);
          if (refusal !== null) {
            const loc = locOf(expr);
            return {
              kind: "throw",
              value: {
                kind: "libCall",
                fn: "error.new",
                args: [{ kind: "strLit", value: refusal.message, type: STRING, loc }],
                type: { kind: "object", className: "%Error" },
                loc,
              },
              loc,
            };
          }
        }
      }
      if (isCjsJsFile(sf)) {
        const init = L.requireInitStmt(spec, expr);
        if (init) return init;
        return { kind: "block", body: [], loc: locOf(expr) };
      }
      if (topLevelJs) return { kind: "block", body: [], loc: locOf(expr) };
      L.unsupported(
        "SC1090",
        expr,
        "require() outside the module's top level (move it to the top of the file)",
      );
    }
    if (topLevelJs && ts.isExpressionStatement(stmtNode)) {
      const cjs = cjsExportAssignmentOf(stmtNode);
      if (cjs) return lowerCjsExportStatement(L, cjs);
      // The tsc CJS interop stamp — `Object.defineProperty(exports,
      // "__esModule", { value: true });` at a module's top — lowers to
      // NOTHING: the compiled module system has no reflective exports
      // object to mark, and the marker's one job (import interop) is
      // already modeled statically by the checker and the CJS lexer link
      // check. Every tsc-emitted dist file opens with it, and the generic
      // defineProperty fence would throw at module load.
      if (isEsModuleStamp(expr)) return { kind: "block", body: [], loc: locOf(expr) };
    }
    // Statement-position `delete` — the two honest receivers: process.env
    // keys (unsetenv(3) — later reads and spawned children observe the
    // removal, exactly Node) and PURE index-signature records (an overflow
    // Map delete; hybrids fence — a declared struct slot cannot be
    // removed). JS's boolean result is constant true in these shapes, and
    // statement position discards it anyway; value-position deletes keep
    // the expression fence.
    if (ts.isDeleteExpression(expr)) return lowerDeleteStatement(L, expr);
    // Statement-position `void e` — the fire-and-forget idiom (`void
    // poll();`, `void main();` — lint-visible "I meant to drop this
    // promise"): the operand evaluates for effect and the undefined result
    // is unobservable here, so it lowers as the operand statement itself.
    // Value-position `void` keeps the syntax fence (a standalone undefined
    // VALUE needs a union slot to live in).
    if (ts.isVoidExpression(expr)) return lowerExprStatement(L, expr.expression);
    if (ts.isBinaryExpression(expr)) {
      const opKind = expr.operatorToken.kind;
      // Statement-position comma (`({} = a, [] = a);`, `i++, j++` in a
      // for-incrementor): both operands run for effect in source order and
      // both values are discarded — a block of the two statement
      // lowerings. Chains associate left, so recursion flattens them.
      if (opKind === ts.SyntaxKind.CommaToken) {
        return {
          kind: "block",
          body: [lowerExprStatement(L, expr.left), lowerExprStatement(L, expr.right)],
          loc: locOf(expr),
        };
      }
      if (opKind === ts.SyntaxKind.EqualsToken) {
        // Expando function members (`foo.bar = 12`, `foo[SYM] = v` on a
        // module-level function/callable const): the member's module
        // global (lower-expando.ts) — claimed by symbol identity before
        // any receiver-shape path.
        {
          const ex = lowerExpandoAssignStmt(L, expr);
          if (ex) return ex;
        }
        if (ts.isElementAccessExpression(expr.left)) return L.lowerElementWrite(expr);
        if (ts.isPropertyAccessExpression(expr.left)) {
          // `process.env.NAME = v` — setenv(3): later env reads and spawned
          // children observe the write, exactly Node. Values are strings
          // (Node stringifies everything; a non-string RHS fences instead
          // of silently diverging). The computed-key form lands in
          // lowerElementWrite.
          if (L.isProcessEnv(expr.left.expression) && !expr.left.questionDotToken) {
            const loc = locOf(expr);
            const key: IrExpr = { kind: "strLit", value: expr.left.name.text, type: STRING, loc: locOf(expr.left.name) };
            const value = L.lowerExpr(expr.right);
            if (value.type.kind !== "string") {
              L.unsupported(
                "SC1090",
                expr.right,
                `assigning '${L.fmt(value.type)}' values to process.env (env values are strings — convert first: \`\${v}\`)`,
              );
            }
            return {
              kind: "exprStmt",
              expr: { kind: "libCall", fn: "process.envSet", args: [key, value], type: VOID, loc },
              loc,
            };
          }
          if (expr.left.expression.kind === ts.SyntaxKind.SuperKeyword) {
            // `super.x = v`: the base chain's SETTER, called directly over
            // this method's own `this` — super dispatch is static in JS.
            return L.lowerSuperAccessorWrite(expr.left, expr.right, locOf(expr));
          }
          if (L.isIslandExpr(expr.left.expression)) {
            // o.x = v on an island receiver: engine property write; the
            // value marshals in (a static RHS crosses by value/copy).
            const obj = L.lowerExpr(expr.left.expression);
            const loc = locOf(expr);
            // Dispatch follows the RUNTIME world (383(d)): a checker-'any'
            // receiver whose value LOWERED checked-dynamic (`bag.nested.x
            // = v` behind an 'object'-typed bag) takes the dyn keyed
            // write — the routed JSVAL arm lands it on the real engine
            // object.
            if (obj.type.kind === "dyn") {
              const key: IrExpr = { kind: "strLit", value: expr.left.name.text, type: STRING, loc: locOf(expr.left.name) };
              const value = L.coerceToExpected(L.lowerExpr(expr.right), DYN);
              if (value.type.kind !== "dyn") {
                L.unsupported("SC1100", expr.right, `assigning '${L.fmt(value.type)}' values through 'unknown' receivers`);
              }
              return {
                kind: "exprStmt",
                expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc },
                loc,
              };
            }
            const value = L.jsvalIn(L.lowerExpr(expr.right), expr.right);
            return {
              kind: "exprStmt",
              expr: { kind: "jsOp", op: "setProp", name: expr.left.name.text, args: [obj, value], type: VOID, loc },
              loc,
            };
          }
          // wrapper.close = fn — the net.Server close-override idiom
          // (routed to lower-server; the generic fences stay for
          // everything else).
          {
            const closeOverride = lowerServerCloseOverrideAssignment(L, expr.left, expr.right, locOf(expr));
            if (closeOverride) return closeOverride;
          }
          // res.statusCode = 404 / res.statusMessage = "..." — Node's
          // writable ServerResponse properties (same routing).
          {
            const resProp = lowerHttpResPropertyAssignment(L, expr.left, expr.right, locOf(expr));
            if (resProp) return resProp;
          }
          // server.timeout / keepAliveTimeout / headersTimeout /
          // requestTimeout — the writable numeric http.Server fields.
          {
            const timeoutProp = lowerHttpServerTimeoutAssignment(L, expr.left, expr.right, locOf(expr));
            if (timeoutProp) return timeoutProp;
          }
          // `N.x = v` — a namespace-qualified write: exported `let`
          // members are module globals, so the qualified spelling assigns
          // exactly like the bare one inside the namespace body.
          if (!expr.left.questionDotToken) {
            const nsT = nsWritableTarget(L, expr.left);
            if (nsT) {
              const value = L.lowerExprExpecting(expr.right, nsT.type);
              return { kind: "assign", localId: nsT.id, value, loc: locOf(expr) };
            }
          }
          // `C.x = v` — a static-field write through the DECLARING class's
          // own name: the field's module global assigns. Writes through a
          // SUBCLASS name (`D.x = v` creates an OWN property on D in JS —
          // different storage) and through class VALUES (the same dynamic
          // story) are named fences, never a silently-wrong global write.
          if (!expr.left.questionDotToken && ts.isIdentifier(expr.left.expression)) {
            // The receiver must BE the class exactly (its name, or a
            // const binding holding a class expression) — a general class
            // VALUE could hold a subclass, where JS creates an own
            // property instead of writing this storage.
            const classInfo = L.exactClassOfReceiver(expr.left.expression);
            if (classInfo) {
              const found = L.findStaticOn(classInfo, expr.left.name.text);
              if (found?.field !== undefined) {
                if (found.declarer !== classInfo) {
                  L.unsupported(
                    "SC1090",
                    expr.left,
                    `assigning the inherited static '${expr.left.name.text}' through a subclass name (JS creates an OWN property on the subclass — assign through '${found.declarer.def.jsName ?? found.declarer.def.name}' instead)`,
                  );
                }
                if (found.field.readonly) {
                  L.unsupported(
                    "SC1090",
                    expr.left,
                    `assigning the readonly static '${expr.left.name.text}'`,
                  );
                }
                const value = L.lowerExprExpecting(expr.right, found.field.type);
                return { kind: "assign", localId: found.field.globalId, value, loc: locOf(expr) };
              }
            } else {
              const recvT = L.mapTypeOf(L.typeOf(expr.left.expression));
              if (recvT?.kind === "classval") {
                // A static write through a class VALUE: sound exactly when
                // the value can only BE the declaring class — a LEAF class
                // (no strict descendants can flow into the slot, so JS's
                // own-property creation lands on the declarer) whose OWN
                // field it is. That is the decorator-mutates-statics shape
                // (`t.count = 0` inside `@count`). Everything else keeps
                // the pointed dynamic-story fences.
                const vInfo = L.classes.get(recvT.className);
                const vFound = vInfo ? L.findStaticOn(vInfo, expr.left.name.text) : null;
                if (
                  vInfo && vFound?.field !== undefined && vFound.declarer === vInfo &&
                  vInfo.subclasses.length === 0 && !vFound.field.readonly
                ) {
                  const value = L.lowerExprExpecting(expr.right, vFound.field.type);
                  return { kind: "assign", localId: vFound.field.globalId, value, loc: locOf(expr) };
                }
                if (vInfo && vFound?.field !== undefined && vFound.field.readonly) {
                  L.unsupported(
                    "SC1090",
                    expr.left,
                    `assigning the readonly static '${expr.left.name.text}'`,
                  );
                }
                L.unsupported(
                  "SC1090",
                  expr.left,
                  `assigning the static '${expr.left.name.text}' through a class value (JS creates an OWN property on the runtime class — assign through the declaring class's name${vInfo && vInfo.subclasses.length > 0 ? ", which subclasses here" : ""})`,
                );
              }
            }
          }
          // `h.onDone = cb` on a CHECKED-DYNAMIC receiver (a JS `let h =
          // {}` evolving object, an implicit-any param, a dyn member
          // chain): the dyn keyed write — the value converts INTO dyn
          // (closures box), the runtime sets the member on OBJ receivers
          // and throws Node's TypeErrors on the rest. The receiver is
          // PROBED (probeLower) and claimed exactly when it lowers to
          // dyn; typed receivers keep their own lowerings and fences.
          if (!expr.left.questionDotToken) {
            const recv = probeLower(L, expr.left.expression);
            if (recv && recv.type.kind === "dyn") {
              const loc = locOf(expr);
              const key: IrExpr = { kind: "strLit", value: expr.left.name.text, type: STRING, loc: locOf(expr.left.name) };
              const value = L.lowerExprExpecting(expr.right, DYN);
              return {
                kind: "exprStmt",
                expr: { kind: "libCall", fn: "dyn.keySet", args: [recv, key, value], type: VOID, loc },
                loc,
              };
            }
          }
          // `events.defaultMaxListeners = v` in STATEMENT position — the
          // module-property write Node validates (the lowerBinary
          // expression twin): the value crosses into the checked-dynamic tree, the runtime
          // ladder throws Node's exact errors, valid numbers apply.
          if (!expr.left.questionDotToken && expr.left.name.text === "defaultMaxListeners") {
            const bi = L.builtinMemberOf(expr.left);
            if (bi && bi.module === "events" && bi.member === "defaultMaxListeners") {
              const loc = locOf(expr);
              const rhs = L.lowerExpr(expr.right);
              if (rhs.type.kind === "dyn" || rhs.kind === "unitLit" || L.dynConvertible(rhs.type)) {
                const dynVal: IrExpr =
                  rhs.type.kind === "dyn" ? rhs : { kind: "dynFrom", value: rhs, type: DYN, loc };
                return {
                  kind: "exprStmt",
                  expr: {
                    kind: "libCall",
                    fn: "emitter.setDefaultMaxChk",
                    args: [dynVal, { kind: "strLit", value: "defaultMaxListeners", type: STRING, loc }],
                    type: VOID,
                    loc,
                  },
                  loc,
                };
              }
            }
          }
          // `r._read = fn` / `w._write = fn` (and the other underscore
          // methods) on a runtime-stream-rooted receiver: Node's
          // own-property shadow of the prototype method — the runtime
          // callback slot swaps its closure (collection fences subclass
          // fields with these names, so no field target can split-brain).
          {
            const viaStream = lowerStreamUnderscoreAssign(L, expr);
            if (viaStream) return viaStream;
          }
          const target = L.fieldTarget(expr.left);
          if (target) {
            const value = L.lowerExprExpecting(expr.right, target.fieldType);
            return L.fieldSetStmt(target, value, locOf(expr), expr.left);
          }
          // A write to an ABSTRACT property through an abstract-typed
          // receiver: the read fence's write twin (the declaration is
          // erased at runtime — no shared slot exists to write).
          if (abstractPropertyDeclOf(L, expr.left)) {
            L.unsupported(
              "SC1090",
              expr.left,
              `writing the abstract property '${expr.left.name.text}' through a '${L.checker.typeToString(L.typeOf(expr.left.expression))}'-typed receiver (abstract property declarations are erased at runtime, so no shared slot exists — type the receiver as the concrete class, or declare an abstract accessor pair instead)`,
            );
          }
          // Dot WRITE to an undeclared key of an index-signature shape:
          // the same deliberate fence as the dotted read, with the same
          // fix in the message (brackets are the index-signature form).
          const recvIr = L.mapTypeOf(L.typeOf(expr.left.expression));
          if (recvIr?.kind === "record") {
            const shape = L.shapes.get(recvIr.shapeId);
            if (shape?.indexValue && !shape.fields.some((f) => f.name === (expr.left as ts.PropertyAccessExpression).name.text)) {
              L.unsupported(
                "SC1090",
                expr.left,
                `dot writes to index-signature keys (spell it r["${expr.left.name.text}"] = v — brackets are the index-signature form)`,
              );
            }
          }
        }
        if (ts.isObjectLiteralExpression(expr.left) || ts.isArrayLiteralExpression(expr.left)) {
          // Destructuring assignment (chains included) whose SOURCE is an
          // island value: the ENGINE runs the pattern (JS-exact coercions
          // — RequireObjectCoercible on object patterns, the iterator
          // protocol on array patterns) and hands the extracted values
          // back for the compiled targets. Static sources fall through to
          // the general assignment lowering below.
          const viaIsland = lowerJsvalDestructuringChain(L, expr);
          if (viaIsland) return viaIsland;
          // Destructuring ASSIGNMENT to existing bindings:
          // `({ dir, port } = await discoverState());`, `[a, b = 0, ...rest] = t` —
          // the RHS evaluates once into a hidden temp, then each target
          // assigns in source order (the assignment twin of
          // lowerDestructuringDecl); lowerDestructuringAssignParts has the
          // full supported-forms contract.
          const parts = lowerDestructuringAssignParts(L, expr.left, expr.right, locOf(expr));
          return { kind: "block", body: parts.stmts, loc: locOf(expr) };
        }
        if (!ts.isIdentifier(expr.left)) {
          L.unsupported("SC1090", expr.left, "assignment to non-variables");
        }
        const target = L.resolveWritable(expr.left);
        if (!target) L.rejectUnresolved(expr.left, `assignment to '${expr.left.text}' (not a writable local or module global)`);
        const value = L.lowerExprExpecting(expr.right, target.type);
        const runtimeOptionalRoot = L.runtimeOptionalRootOf(target);
        if (L.runtimeOptionalStorageLocals.has(runtimeOptionalRoot)) L.runtimeOptionalLocals.add(runtimeOptionalRoot);
        return { kind: "assign", localId: target.id, value, loc: locOf(expr) };
      }
      if (opKind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        // `x ??= e` on a VARIABLE, statement position: desugar to
        // `x = x ?? e` (x read once, e lazy). For a plain variable JS's
        // assign-only-when-nullish is unobservable — the value written back
        // on the non-nullish path is the same box. Property targets keep a
        // distinct fence: accessors would make the always-write observable.
        if (!ts.isIdentifier(expr.left)) {
          L.unsupported(
            "SC1090",
            expr.left,
            "'??=' on non-variable targets (write it out: if (o.f === undefined) o.f = v)",
          );
        }
        const target = L.resolveWritable(expr.left);
        if (!target) L.rejectUnresolved(expr.left, `assignment to '${expr.left.text}' (not a writable local or module global)`);
        const loc = locOf(expr);
        if (target.type.kind !== "union") {
          // The checker says never nullish: JS neither evaluates e nor
          // assigns — the statement is a no-op (lowerNullishCoalesce's
          // trust-the-checker fold, statement form).
          return { kind: "block", body: [], loc };
        }
        const def = L.unions.get(target.type.unionId);
        if (!def) L.badType(expr.left, L.typeOf(expr.left));
        if (!def.arms.some(isUnitType)) return { kind: "block", body: [], loc };
        const read: IrExpr = { kind: "varRef", localId: target.id, type: target.type, loc: locOf(expr.left) };
        const right = L.lowerExprExpecting(expr.right, target.type);
        const value: IrExpr = { kind: "nullish", left: read, right, type: target.type, loc };
        return { kind: "assign", localId: target.id, value, loc };
      }
      const compound = COMPOUND_ASSIGN_OPS[opKind];
      if (compound !== undefined) {
        // Desugar `x op= e` to `x = x op e` — reads x before e, like JS.
        if (ts.isElementAccessExpression(expr.left)) {
          // `this[kLimit] += v` — a declared symbol-keyed class field is
          // the dotted compound in element spelling; every other element
          // target keeps the fence.
          if (symbolFieldInfo(L, expr.left)) {
            return L.lowerFieldCompound(expr.left, compound, expr.right, locOf(expr));
          }
          L.unsupported("SC1090", expr.left, "compound array-element assignment (a[i] += v)");
        }
        if (ts.isPropertyAccessExpression(expr.left)) {
          // `N.x += v` — the namespace-qualified spelling of a module-
          // global compound assign (nsWritableTarget resolves the member's
          // global; everything else keeps the field path). Expando
          // function members (`foo.count += 1`) are module globals too.
          if (!expr.left.questionDotToken) {
            const exT = expandoWritableTarget(L, expr.left);
            if (exT) return lowerCompoundToTarget(L, expr, compound, exT);
            const nsT = nsWritableTarget(L, expr.left);
            if (nsT) return lowerCompoundToTarget(L, expr, compound, nsT);
          }
          return L.lowerFieldCompound(expr.left, compound, expr.right, locOf(expr));
        }
        if (!ts.isIdentifier(expr.left)) {
          L.unsupported("SC1090", expr.left, "assignment to non-variables");
        }
        const target = L.resolveWritable(expr.left);
        if (!target) L.rejectUnresolved(expr.left, `assignment to '${expr.left.text}' (not a writable local or module global)`);
        return lowerCompoundToTarget(L, expr, compound, target);
      }
      if (
        opKind >= ts.SyntaxKind.FirstCompoundAssignment &&
        opKind <= ts.SyntaxKind.LastCompoundAssignment
      ) {
        // Everything else is covered above; what remains is &&= and ||=.
        L.unsupported("SC1090", expr, "logical assignment (&&=, ||=) — write the if out");
      }
    }
    if (
      (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) &&
      (expr.operator === ts.SyntaxKind.PlusPlusToken ||
        expr.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      // Statement position only: pre/post distinction is unobservable, so
      // both desugar to `x = x ± 1`.
      if (
        ts.isPropertyAccessExpression(expr.operand) ||
        (ts.isElementAccessExpression(expr.operand) && symbolFieldInfo(L, expr.operand))
      ) {
        // `N.x++` — the namespace-qualified spelling of a module-global
        // increment (the member's global IS the variable); expando
        // function members (`foo.count++`) are module globals too.
        if (ts.isPropertyAccessExpression(expr.operand) && !expr.operand.questionDotToken) {
          const exT = expandoWritableTarget(L, expr.operand);
          if (exT) return lowerIncDecToTarget(L, expr, exT);
          const nsT = nsWritableTarget(L, expr.operand);
          if (nsT) return lowerIncDecToTarget(L, expr, nsT);
        }
        // `obj.f++` desugars through the compound-field path (`obj.f += 1`);
        // `this[kLimit]++` is the same desugar over the symbol-keyed slot.
        return L.lowerFieldCompound(
          expr.operand as ts.PropertyAccessExpression | ts.ElementAccessExpression,
          expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-",
          null,
          locOf(expr),
        );
      }
      if (!ts.isIdentifier(expr.operand)) {
        L.unsupported("SC1090", expr.operand, "increment/decrement of non-variables");
      }
      const target = L.resolveWritable(expr.operand);
      if (!target) L.unsupported("SC1090", expr.operand, "increment/decrement of this target");
      return lowerIncDecToTarget(L, expr, target);
    }
    // A DISCARDED pure read/call over the standard-library globals: Node
    // evaluates it and throws the value away with zero observable effect,
    // so the statement lowers to nothing. Value positions keep every
    // fence — only the discard makes these exact.
    if (droppedPureStdlibStatement(L, expr)) {
      return { kind: "block", body: [], loc: locOf(expr) };
    }
    const value = L.lowerExpr(expr);
    // A bare unit-literal statement (`undefined;`): a pure no-op in JS,
    // and the IR has no bare-unit VALUE outside a union wrap — drop it
    // instead of tripping the validator's bare-unitLit rule.
    if (value.kind === "unitLit") return { kind: "block", body: [], loc: locOf(expr) };
    return { kind: "exprStmt", expr: value, loc: locOf(expr) };
  }

/** True for a statement-position expression whose evaluation cannot be
   * observed once the value is discarded:
   *   - a property/element READ (`?.` included) whose receiver IS a
   *     standard-library global (`Array.toString;`, `Array["toString"];`,
   *     `global.x;`) — builtin globals have no effectful getters, and an
   *     element key must itself be side-effect-free;
   *   - a CALL of a lowered PURE method on `Array.prototype` /
   *     `String.prototype` with side-effect-free arguments
   *     (`Array.prototype.slice(0, 1);` — slice over the shared EMPTY
   *     prototype array/string allocates a copy Node discards too).
   * The receiver must be the GLOBAL itself (name + provenance, via
   * stdlibGlobalNameOf) — user shadows and computed receivers keep their
   * ordinary lowerings and fences. */
  function droppedPureStdlibStatement(L: Lowerer, expr: ts.Expression): boolean {
    const strip = (e: ts.Expression): ts.Expression => {
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      return e;
    };
    if (ts.isCallExpression(expr)) {
      const callee = strip(expr.expression);
      if (!ts.isPropertyAccessExpression(callee)) return false;
      if (!PURE_PROTOTYPE_METHODS.has(callee.name.text)) return false;
      const proto = strip(callee.expression);
      if (!ts.isPropertyAccessExpression(proto) || proto.name.text !== "prototype") return false;
      if (!isStdlibMember(L, proto) || !isStdlibMember(L, callee)) return false;
      const root = stdlibGlobalNameOf(L, strip(proto.expression));
      if (root !== "Array" && root !== "String") return false;
      return expr.arguments.every((a) => sideEffectFreeOptionValue(a));
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return stdlibGlobalNameOf(L, strip(expr.expression)) !== null;
    }
    if (ts.isElementAccessExpression(expr)) {
      return (
        stdlibGlobalNameOf(L, strip(expr.expression)) !== null &&
        sideEffectFreeOptionValue(expr.argumentExpression)
      );
    }
    return false;
  }

/** The prototype-receiver methods the discard rule accepts: each is pure
   * (no receiver mutation, no user code — a fresh value from an empty
   * receiver) at every arity the lib declares. */
  const PURE_PROTOTYPE_METHODS: ReadonlySet<string> = new Set(["slice", "concat", "indexOf", "includes", "toString", "valueOf"]);

/** The shared tail of statement-position `x++` / `x--` over a resolved
   * variable/global target (pre/post is unobservable there): the
   * `x = x ± 1` desugar, serving the bare-identifier form and the
   * namespace-qualified spelling (`N.x++`). */
  function lowerIncDecToTarget(L: Lowerer, expr: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
    target: { id: string; type: IrType },): IrStmt {
    const loc = locOf(expr);
    const op = expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
    const readTarget: IrExpr = { kind: "varRef", localId: target.id, type: target.type, loc };
    // JS any-origin targets: check the read to number, convert the
    // result back into the dyn slot (the compound-assign stance).
    const dynTarget = target.type.kind === "dyn" && isJsSourceFile(expr.getSourceFile());
    if (target.type.kind !== "f64" && !dynTarget) {
      L.unsupported("SC1090", expr.operand, "increment/decrement of non-number targets");
    }
    const computed: IrExpr = {
      kind: "bin",
      op,
      left: dynTarget ? { kind: "dynCheck", value: readTarget, type: F64, loc } : readTarget,
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: F64,
      loc,
    };
    const value: IrExpr = dynTarget ? { kind: "dynFrom", value: computed, type: DYN, loc } : computed;
    return { kind: "assign", localId: target.id, value, loc };
  }

/** The shared tail of `x op= e` over a resolved variable/global target —
   * desugared to `x = x op e` (x read before e, like JS). Serves the bare-
   * identifier form and the namespace-qualified spelling (`N.x += v`),
   * whose target is the member's module global. */
  function lowerCompoundToTarget(L: Lowerer, expr: ts.BinaryExpression, compound: CompoundOp,
    target: { id: string; type: IrType },): IrStmt {
    const loc = locOf(expr);
    const read: IrExpr = { kind: "varRef", localId: target.id, type: target.type, loc: locOf(expr.left) };
    const rhs = L.lowerExpr(expr.right);
    let value: IrExpr;
    if (target.type.kind === "jsval" || rhs.type.kind === "jsval") {
      const JS_COMPOUND: Record<string, IrJsOp> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod", "**": "pow" };
      const jop = JS_COMPOUND[compound];
      if (jop === undefined) L.unsupported("SC1043", expr);
      const wrapped: IrExpr = {
        kind: "jsOp", op: jop,
        args: [L.jsvalIn(read, expr.left), L.jsvalIn(rhs, expr.right)],
        type: JSVAL, loc,
      };
      value = L.coerceInto(expr, wrapped, target.type);
    } else if (compound === "+" && target.type.kind === "string") {
      value = { kind: "strConcat", left: read, right: L.ensureString(rhs, expr.right), type: STRING, loc };
    } else if (target.type.kind === "f64" && rhs.type.kind === "f64") {
      value = { kind: "bin", op: compound, left: read, right: rhs, type: F64, loc };
    } else if (
      (target.type.kind === "dyn" || rhs.type.kind === "dyn") &&
      (target.type.kind === "dyn" || target.type.kind === "f64") &&
      (rhs.type.kind === "dyn" || rhs.type.kind === "f64") &&
      isJsSourceFile(expr.getSourceFile())
    ) {
      // JS any-origin operands: check to number and compute natively
      // (the binary-operator stance) — the dyn target takes the result
      // back through the usual dyn conversion.
      const checkNum = (e: IrExpr): IrExpr =>
        e.type.kind === "dyn" ? { kind: "dynCheck", value: e, type: F64, loc: e.loc } : e;
      const computed: IrExpr = { kind: "bin", op: compound, left: checkNum(read), right: checkNum(rhs), type: F64, loc };
      value = target.type.kind === "dyn" ? { kind: "dynFrom", value: computed, type: DYN, loc } : computed;
    } else {
      L.unsupported("SC1043", expr);
    }
    return { kind: "assign", localId: target.id, value, loc };
  }

/** One destructuring-assignment pattern the island can run: empty object/
   * array patterns and flat identifier targets — shorthand `{ x }`,
   * renamed `{ a: x }`, FOLDED computed keys `{ [k]: x }` (2105's
   * static-fold rule: a pure key expression whose checker type spells one
   * property name — skipping its evaluation is exact), array elements
   * `[x, y]`. Answers the source FIELD key (object patterns) and the
   * target identifier per binding, in pattern order; null for any other
   * pattern form (defaults, rest, nesting, holes, non-identifier targets,
   * runtime-valued keys — the existing fences own those). */
  function islandRunnablePattern(
    L: Lowerer,
    pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  ): { kind: "object" | "array"; binds: { field: string | number; target: ts.Identifier; shorthand: ts.ShorthandPropertyAssignment | null }[] } | null {
    if (ts.isObjectLiteralExpression(pattern)) {
      const binds: { field: string | number; target: ts.Identifier; shorthand: ts.ShorthandPropertyAssignment | null }[] = [];
      for (const prop of pattern.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          if (prop.objectAssignmentInitializer) return null;
          // 7 types the shorthand's name as PropertyName; the grammar
          // allows nothing but an Identifier there (lowerShorthandValue).
          const name = prop.name as ts.Identifier;
          binds.push({ field: name.text, target: name, shorthand: prop });
        } else if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          ts.isIdentifier(prop.initializer)
        ) {
          binds.push({ field: prop.name.text, target: prop.initializer, shorthand: null });
        } else if (
          ts.isPropertyAssignment(prop) &&
          ts.isComputedPropertyName(prop.name) &&
          ts.isIdentifier(prop.initializer)
        ) {
          const key = L.foldedStringKeyOf(prop.name.expression);
          if (key === null) return null;
          binds.push({ field: key, target: prop.initializer, shorthand: null });
        } else {
          return null;
        }
      }
      return { kind: "object", binds };
    }
    const binds: { field: string | number; target: ts.Identifier; shorthand: null }[] = [];
    for (let i = 0; i < pattern.elements.length; i++) {
      const el = pattern.elements[i]!;
      if (!ts.isIdentifier(el)) return null; // holes, spreads, nesting
      binds.push({ field: i, target: el, shorthand: null });
    }
    return { kind: "array", binds };
  }

/** `({} = {x, y} = a);` — destructuring assignment (chains included) from
   * an ISLAND source, statement position (--dynamic). The ENGINE runs each
   * pattern over the source value — a synthesized
   * `new Function("v", "\"use strict\"; var __0…; (<pattern> = v); return [__0…]")`
   * — so the coercions are JS-exact: object patterns RequireObjectCoercible
   * (destructuring undefined throws Node's TypeError), array patterns run
   * the real iterator protocol (empty patterns get-and-close). The
   * extracted values come back as an engine array and assign the compiled
   * targets in pattern order, inner assignment first (JS's right-
   * associativity). Null when the innermost source is not jsval-typed or
   * any pattern is outside the island-runnable set — the existing
   * record-source path and fences own those. */
  function lowerJsvalDestructuringChain(L: Lowerer, expr: ts.BinaryExpression): IrStmt | null {
    if (!L.dynamic) return null;
    const strip = (e: ts.Expression): ts.Expression => {
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      return e;
    };
    const patterns: (ts.ObjectLiteralExpression | ts.ArrayLiteralExpression)[] = [];
    let node: ts.Expression = expr;
    for (;;) {
      const s = strip(node);
      if (
        ts.isBinaryExpression(s) &&
        s.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(strip(s.left)) || ts.isArrayLiteralExpression(strip(s.left)))
      ) {
        patterns.push(strip(s.left) as ts.ObjectLiteralExpression | ts.ArrayLiteralExpression);
        node = s.right;
      } else {
        break;
      }
    }
    if (patterns.length === 0) return null;
    // A single pattern over a PLAIN-VARIABLE island source takes the
    // general assignment lowering below, whose island arm throws V8's
    // exact destructure TypeErrors — the spelling embeds the source
    // text, which only a plain variable survives (corpus 2074). Chains
    // and non-variable sources ride the engine here (corpus 2054); the
    // general path fences those with SC1031.
    if (patterns.length === 1 && ts.isIdentifier(strip(node))) return null;
    const shapes: NonNullable<ReturnType<typeof islandRunnablePattern>>[] = [];
    for (const p of patterns) {
      const s = islandRunnablePattern(L, p);
      if (!s) return null;
      shapes.push(s);
    }
    // Checker-type gate BEFORE lowering the source (a declined claim must
    // not leave a discarded lowering behind): only island sources ride
    // the engine; record/array sources keep their existing paths.
    if (L.mapTypeOf(L.typeOf(node))?.kind !== "jsval") return null;
    const source = L.lowerExpr(node);
    if (source.type.kind !== "jsval") return null;
    const loc = locOf(expr);
    const tmp = L.declareHiddenLocal("%dsrc", JSVAL);
    const out: IrStmt[] = [{ kind: "varDecl", localId: tmp.id, init: source, loc }];
    const srcRef = (): IrExpr => ({ kind: "varRef", localId: tmp.id, type: JSVAL, loc });
    // Inner pattern first: `A = B = v` runs B's destructure before A's.
    for (let p = patterns.length - 1; p >= 0; p--) {
      const shape = shapes[p]!;
      const temps = shape.binds.map((_, i) => `__${i}`);
      const patternSrc =
        shape.kind === "object"
          ? `({${shape.binds.map((b, i) => `[${JSON.stringify(String(b.field))}]: __${i}`).join(",")}} = v)`
          : `([${temps.join(",")}] = v)`;
      const body =
        `"use strict";` +
        (temps.length > 0 ? `var ${temps.join(",")};` : "") +
        `${patternSrc};return [${temps.join(",")}];`;
      const helper: IrExpr = {
        kind: "jsOp",
        op: "construct",
        args: [
          { kind: "jsOp", op: "globalGet", name: "Function", args: [], type: JSVAL, loc },
          { kind: "jsMarshal", value: { kind: "strLit", value: "v", type: STRING, loc }, type: JSVAL, loc },
          { kind: "jsMarshal", value: { kind: "strLit", value: body, type: STRING, loc }, type: JSVAL, loc },
        ],
        type: JSVAL,
        loc,
      };
      const run: IrExpr = { kind: "jsOp", op: "callFn", args: [helper, srcRef()], type: JSVAL, loc };
      if (shape.binds.length === 0) {
        out.push({ kind: "exprStmt", expr: run, loc });
        continue;
      }
      const res = L.declareHiddenLocal("%dres", JSVAL);
      out.push({ kind: "varDecl", localId: res.id, init: run, loc });
      shape.binds.forEach((b, i) => {
        // Shorthand names resolve to the PROPERTY symbol at their
        // location; the VALUE symbol comes from the checker's shorthand
        // query (lowerDestructuringAssign's rule).
        let target: { id: string; type: IrType } | null;
        if (b.shorthand) {
          const valueSymbol = L.checker.getShorthandAssignmentValueSymbol(b.shorthand) ?? null;
          const local = valueSymbol ? L.resolveKey(valueSymbol, b.target) : null;
          const g = valueSymbol ? L.globalsBySymbol.get(valueSymbol) : undefined;
          target = local ? { id: local.id, type: local.type } : g ? { id: g.id, type: g.type } : null;
        } else {
          target = L.resolveWritable(b.target);
        }
        if (!target) {
          L.rejectUnresolved(b.target, `assignment to '${b.target.text}' (not a writable local or module global)`);
        }
        const read: IrExpr = {
          kind: "jsOp",
          op: "getIdx",
          args: [
            { kind: "varRef", localId: res.id, type: JSVAL, loc },
            { kind: "jsMarshal", value: { kind: "numLit", value: i, type: F64, loc }, type: JSVAL, loc },
          ],
          type: JSVAL,
          loc,
        };
        out.push({
          kind: "assign",
          localId: target.id,
          value: L.coerceInto(b.target, read, target.type),
          loc,
        });
      });
    }
    return { kind: "block", body: out, loc };
  }

/** `({ a, b: x } = e);`, `[a, b = 0, ...rest] = xs;` — destructuring
   * assignment to EXISTING writable bindings, statement position, from a
   * PRE-LOWERED source: for-of expression heads hand the per-iteration
   * element in directly (no RHS expression exists there, so
   * checked-dynamic sources fence — V8's TypeError spells the source
   * text). Plain assignment statements ride
   * lowerDestructuringAssignParts, which keeps the RHS expression for
   * that spelling. */
  export function lowerDestructuringAssign(L: Lowerer, target: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    init: IrExpr,
    blame: ts.Node,
    loc: SrcLoc,): IrStmt {
    const parts = destructuringAssignInto(L, target, init, null, blame, loc);
    return { kind: "block", body: parts.stmts, loc };
  }

/** V8's spelling of a destructuring RHS in its TypeError message
   * ("Cannot destructure 'a' as it is undefined.") — plain identifiers
   * spell their name (parens unwrap); everything else is V8's
   * CallPrinter reconstruction, which is not reproduced — null keeps a
   * fence at the caller. */
  function destrSpellingOf(rhs: ts.Expression): string | null {
    let e = rhs;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : null;
  }

/** Destructuring ASSIGNMENT (existing bindings — the declaration twin is
   * lowerDestructuringDecl): the RHS evaluates ONCE into a hidden temp,
   * each target assigns in source order, and the parts' VALUE is the
   * temp — JS's assignment-expression value is the RHS value, so the same
   * parts serve statement position (block) and expression position
   * (seqExpr). Object patterns cover shorthand/renamed identifier targets
   * over record sources and checked-dynamic sources (keyed reads behind
   * V8's exact RequireObjectCoercible TypeError); array patterns cover
   * identifier targets with optional defaults over arrays, tuples, and
   * checked-dynamic sources (dynIterN's GetIterator semantics), elisions,
   * a sole leading rest whose operand is itself an array pattern
   * (`[...[a, b = 0]] = t` consumes the same elements as the inner
   * pattern alone), and the EMPTY patterns (`({} = e)` requires object-
   * coercibility, `[] = e` requires iterability — both pure for sources
   * whose static type already proves it). Object patterns over record
   * sources take defaults (`{ x = 1 }` — the undefined-arm test against
   * the TARGET's own type) and rest (`{ ...bar }` — the unconsumed fields
   * pack into a fresh record, JS's CopyDataProperties stance); array
   * patterns take defaults everywhere (arrays carry the bounds test JS's
   * past-the-end undefined demands) and rest packing the tail fresh
   * (array slices, tuple tails). Nesting, computed keys, and member
   * targets keep fences. */
  export function lowerDestructuringAssignParts(L: Lowerer, target: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    rhs: ts.Expression,
    loc: SrcLoc,): { stmts: IrStmt[]; value: IrExpr } {
    if (ts.isArrayLiteralExpression(target)) {
      L.fenceStaticHeadersIteration(rhs);
    } else {
      L.fenceFetchObjectAssignment(target, rhs);
    }
    return destructuringAssignInto(L, target, L.lowerExpr(rhs), rhs, rhs, loc);
  }

/** The shared assignment-destructuring core: `init` is the once-lowered
   * source, `rhs` its source EXPRESSION when one exists (null for
   * pre-lowered sources — for-of expression heads — where V8's
   * source-spelling TypeError machinery cannot apply), `blame` the node
   * fences point at. */
  function destructuringAssignInto(L: Lowerer, target: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    init: IrExpr,
    rhs: ts.Expression | null,
    blame: ts.Node,
    loc: SrcLoc,): { stmts: IrStmt[]; value: IrExpr } {
    // IR-string sources in JS files split two ways the carrier type
    // cannot: a STDLIB GLOBAL (`({ subtle } = globalThis.crypto)`) — the
    // declaration path binds member identity tokens into FRESH bindings,
    // but assignment targets carry their own checker-typed slots no token
    // can honestly inhabit — and a LEAKED token (a local that adopted a
    // global's carrier type), where the string lowerings below would read
    // the carrier itself. Both keep fences naming the truth; empty
    // patterns stay pure (RequireObjectCoercible/GetIterator hold for
    // globals and strings alike).
    {
      const patternEmpty = ts.isObjectLiteralExpression(target)
        ? target.properties.length === 0
        : target.elements.length === 0;
      if (!patternEmpty && rhs !== null && isJsSourceFile(rhs.getSourceFile())) {
        const globalName = stdlibGlobalNameOf(L, rhs);
        if (globalName !== null) {
          L.unsupported(
            "SC1031",
            blame,
            `destructuring assignment from the builtin global '${globalName}' (bind the members with a const destructuring declaration instead)`,
          );
        }
        if (init.type.kind === "string" && !checkerStringSource(L, rhs)) {
          L.unsupported(
            "SC1031",
            blame,
            ts.isArrayLiteralExpression(target)
              ? `array destructuring assignment from non-array values (the source is '${L.checker.typeToString(L.typeOf(rhs))}'-typed)`
              : `destructuring assignment from non-record values (the source is '${L.checker.typeToString(L.typeOf(rhs))}'-typed)`,
          );
        }
      }
    }
    const tmp = L.declareHiddenLocal("%destr", init.type);
    const out: IrStmt[] = [{ kind: "varDecl", localId: tmp.id, init, loc }];
    const tmpRef = (): IrExpr => ({ kind: "varRef", localId: tmp.id, type: init.type, loc });
    const value = tmpRef();
    if (ts.isArrayLiteralExpression(target)) {
      lowerArrayAssignInto(L, out, target, tmpRef, blame, loc);
      return { stmts: out, value };
    }
    if (init.type.kind === "dyn" || init.type.kind === "jsval") {
      // Checked-dynamic and island sources: RequireObjectCoercible with
      // V8's exact destructuring TypeError (it names the SOURCE and, for
      // non-empty patterns, the first property), then keyed reads — GetV
      // answers undefined for absent members and primitive receivers
      // alike (the engine's own property semantics on the island side).
      // An RHS that is ITSELF a destructuring assignment (`({} = {x} = a)`)
      // already proved the value coercible — its own pattern threw first
      // if it wasn't — so the outer check is dead code and needs no
      // spelling.
      let rhsInner = rhs;
      while (rhsInner !== null && ts.isParenthesizedExpression(rhsInner)) rhsInner = rhsInner.expression;
      const checkedByInner =
        rhsInner !== null &&
        ts.isBinaryExpression(rhsInner) &&
        rhsInner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(rhsInner.left) || ts.isArrayLiteralExpression(rhsInner.left));
      if (!checkedByInner) {
        const spelling = rhs === null ? null : destrSpellingOf(rhs);
        if (spelling === null) {
          L.unsupported(
            "SC1031",
            blame,
            "destructuring assignment from a checked-dynamic source that is not a plain variable (V8's TypeError spells the source expression — assign it to a variable first)",
          );
        }
        let firstProp: string | undefined;
        const p0 = target.properties[0];
        if (p0 !== undefined) {
          if (ts.isShorthandPropertyAssignment(p0)) firstProp = (p0.name as ts.Identifier).text;
          else if (ts.isPropertyAssignment(p0)) {
            const n = p0.name;
            if (ts.isIdentifier(n)) firstProp = n.text;
            // computed first keys take V8's bare (source-only) message form
          }
        }
        out.push({
          kind: "exprStmt",
          expr: { kind: "dynDestrCheck", value: tmpRef(), spelling, ...(firstProp !== undefined ? { firstProp } : {}), type: init.type, loc },
          loc,
        });
      }
      for (const prop of target.properties) {
        const piece = destructAssignPiece(L, prop, init.type.kind === "jsval");
        const read: IrExpr =
          piece.keyExpr !== undefined
            ? { kind: "jsOp", op: "getIdx", args: [tmpRef(), L.jsvalIn(L.lowerExpr(piece.keyExpr), piece.keyExpr)], type: JSVAL, loc: locOf(prop) }
            : init.type.kind === "jsval"
              ? { kind: "jsOp", op: "getProp", name: piece.field, args: [tmpRef()], type: JSVAL, loc: locOf(prop) }
              : {
                  kind: "dynKeyGet",
                  key: { kind: "strLit", value: piece.field, type: STRING, loc: locOf(prop) },
                  value: tmpRef(),
                  type: DYN,
                  loc: locOf(prop),
                };
        out.push({
          kind: "assign",
          localId: piece.target.id,
          value: L.coerceInto(prop, read, piece.target.type),
          loc: locOf(prop),
        });
      }
      return { stmts: out, value };
    }
    if (target.properties.length === 0) {
      // `({} = e)`: RequireObjectCoercible and nothing else. A source the
      // type system already proves non-nullish is a pure no-op past the
      // RHS's own evaluation; possibly-nullish unions would throw in JS
      // and keep a fence.
      if (init.type.kind === "union" && (L.unions.get(init.type.unionId)?.arms.some(isUnitType) ?? true)) {
        L.unsupported("SC1031", blame, "empty-pattern destructuring from a possibly-nullish source (JS throws TypeError when it is null/undefined at runtime — narrow first)");
      }
      return { stmts: out, value };
    }
    // A CLASS-INSTANCE source (`({ a, b } = inst)`): the declaration
    // path's desugar in assignment position — one member read per
    // element, left to right (declared fields read their slots, accessor
    // properties call their getters through the same fieldGetExpr
    // dispatch), defaults against the TARGET's own type, rest packing
    // the remaining instance fields (classInstanceRestValue). Methods
    // and names no class on the chain declares keep the declaration
    // path's named fences.
    if (init.type.kind === "object") {
      const objT = init.type;
      if (!L.classes.get(objT.className)) L.flushDeferredClass(objT.className);
      const info = L.classes.get(objT.className);
      if (info) {
        for (const prop of target.properties) {
          const propLoc = locOf(prop);
          if (ts.isSpreadAssignment(prop)) {
            let restTo: ts.Expression = prop.expression;
            while (ts.isParenthesizedExpression(restTo)) restTo = restTo.expression;
            const consumed = new Set<string>();
            for (const p of target.properties) {
              if (ts.isShorthandPropertyAssignment(p)) consumed.add((p.name as ts.Identifier).text);
              else if (ts.isPropertyAssignment(p)) {
                const n = patternKeyNameOf(L, p.name);
                if (n !== null) consumed.add(n);
              }
            }
            if (!ts.isIdentifier(restTo)) {
              lowerAssignTargetInto(L, out, restTo, prop, null, (targetT) =>
                classInstanceRestValue(L, prop, tmpRef, objT, info, consumed, targetT));
              continue;
            }
            const targetBinding = L.resolveWritable(restTo);
            if (!targetBinding) {
              L.rejectUnresolved(restTo, `assignment to '${restTo.text}' (not a writable local or module global)`);
            }
            const packed = classInstanceRestValue(L, prop, tmpRef, objT, info, consumed, targetBinding.type);
            out.push({ kind: "assign", localId: targetBinding.id, value: L.coerceInto(prop, packed, targetBinding.type), loc: propLoc });
            continue;
          }
          let fieldName: string;
          let bindTo: ts.Expression;
          let dfltInit: ts.Expression | null = null;
          if (ts.isShorthandPropertyAssignment(prop)) {
            fieldName = (prop.name as ts.Identifier).text;
            bindTo = prop.name as ts.Identifier;
            dfltInit = prop.objectAssignmentInitializer ?? null;
          } else if (ts.isPropertyAssignment(prop)) {
            const folded = patternKeyNameOf(L, prop.name);
            if (folded === null) {
              L.unsupported("SC1031", prop, "destructuring assignment with computed keys that do not fold to one property name");
            }
            fieldName = folded;
            bindTo = prop.initializer;
            if (ts.isBinaryExpression(bindTo) && bindTo.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
              dfltInit = bindTo.right;
              bindTo = bindTo.left;
            }
          } else {
            L.unsupported("SC1031", prop, "destructuring assignment with getter/setter or method properties");
          }
          const dflt = dfltInit;
          const readOf = (targetT: IrType | null): IrExpr => {
            const fieldType = info.fields.get(fieldName);
            const getF = fieldType === undefined ? L.findMethodOn(info, `get:${fieldName}`) : null;
            const setF = fieldType === undefined ? L.findMethodOn(info, `set:${fieldName}`) : null;
            let v: IrExpr;
            if (fieldType !== undefined) {
              v = L.fieldGetExpr({ container: "class", obj: tmpRef(), className: objT.className, field: fieldName, fieldType }, propLoc, prop);
            } else if (getF || setF) {
              v = L.fieldGetExpr(
                { container: "accessor", obj: tmpRef(), className: objT.className, field: fieldName, fieldType: getF ? getF.sig.ret : setF!.sig.params[0]!.type },
                propLoc,
                prop,
              );
              // A defaulted getter result temps first — the default's
              // ternary mentions its operand twice, and JS calls the
              // getter once per element.
              if (dflt && targetT) {
                const got = L.declareHiddenLocal("%dget", v.type);
                out.push({ kind: "varDecl", localId: got.id, init: v, loc: propLoc });
                v = { kind: "varRef", localId: got.id, type: v.type, loc: propLoc };
              }
            } else {
              L.unsupported(
                "SC1031",
                prop,
                L.findMethodOn(info, fieldName)
                  ? `destructuring the method '${fieldName}' (a detached method loses its receiver — call it through the instance)`
                  : `destructuring the property '${fieldName}' the class '${info.def.jsName ?? info.def.name}' does not declare`,
              );
            }
            if (dflt && targetT) v = undefArmDefault(L, prop, dflt, v, targetT);
            return v;
          };
          while (ts.isParenthesizedExpression(bindTo)) bindTo = bindTo.expression;
          if (!ts.isIdentifier(bindTo)) {
            lowerAssignTargetInto(L, out, bindTo, prop, dfltInit, readOf);
            continue;
          }
          let targetBinding: { id: string; type: IrType } | null;
          if (ts.isShorthandPropertyAssignment(prop)) {
            const valueSymbol = L.checker.getShorthandAssignmentValueSymbol(prop) ?? null;
            const local = valueSymbol ? L.resolveKey(valueSymbol, bindTo) : null;
            const g = valueSymbol ? L.globalsBySymbol.get(valueSymbol) : undefined;
            targetBinding = local ? { id: local.id, type: local.type } : g ? { id: g.id, type: g.type } : null;
          } else {
            targetBinding = L.resolveWritable(bindTo);
          }
          if (!targetBinding) {
            L.rejectUnresolved(bindTo, `assignment to '${bindTo.text}' (not a writable local or module global)`);
          }
          out.push({
            kind: "assign",
            localId: targetBinding.id,
            value: L.coerceInto(prop, readOf(targetBinding.type), targetBinding.type),
            loc: propLoc,
          });
        }
        return { stmts: out, value };
      }
    }
    // A STRING source under an object ASSIGNMENT pattern (`({ length: n }
    // = s)`): the declaration path's wrapper rule in assignment position —
    // `length` is the wrapper's one own data property (the strLen
    // intrinsic; a default is dead code — length always exists and is
    // never undefined, so JS never evaluates it either); identifier,
    // property, and element targets ride the shared target plumbing.
    // Methods, unknown names, computed keys, spreads, and accessor
    // properties keep the declaration path's named fences. Callers vetted
    // the source as a checker-typed string.
    if (init.type.kind === "string") {
      for (const prop of target.properties) {
        const propLoc = locOf(prop);
        if (ts.isSpreadAssignment(prop)) {
          L.unsupported(
            "SC1031",
            prop,
            "rest bindings over string sources (JS packs the wrapper's per-code-unit indices — split with [...s] instead)",
          );
        }
        let fieldName: string;
        let bindTo: ts.Expression;
        if (ts.isShorthandPropertyAssignment(prop)) {
          fieldName = (prop.name as ts.Identifier).text;
          bindTo = prop.name as ts.Identifier;
        } else if (ts.isPropertyAssignment(prop)) {
          const folded = patternKeyNameOf(L, prop.name);
          if (folded === null) {
            L.unsupported("SC1031", prop, "destructuring assignment with computed keys that do not fold to one property name");
          }
          fieldName = folded;
          bindTo = prop.initializer;
          // `({ length: n = 3 } = s)`: the default is dead (length always
          // exists) — strip it, exactly the evaluation JS skips.
          if (ts.isBinaryExpression(bindTo) && bindTo.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            bindTo = bindTo.left;
          }
        } else {
          L.unsupported("SC1031", prop, "destructuring assignment with getter/setter or method properties");
        }
        if (fieldName !== "length") {
          L.unsupported(
            "SC1031",
            prop,
            Object.hasOwn(STR_METHODS, fieldName)
              ? `destructuring the method '${fieldName}' of a string (a detached method loses its receiver — call it through the value)`
              : `destructuring the property '${fieldName}' strings do not carry as data ('length' is the one own data property)`,
          );
        }
        const readOf = (): IrExpr =>
          ({ kind: "strIntrinsic", method: "length", receiver: tmpRef(), args: [], type: F64, loc: propLoc });
        while (ts.isParenthesizedExpression(bindTo)) bindTo = bindTo.expression;
        if (!ts.isIdentifier(bindTo)) {
          lowerAssignTargetInto(L, out, bindTo, prop, null, readOf);
          continue;
        }
        let targetBinding: { id: string; type: IrType } | null;
        if (ts.isShorthandPropertyAssignment(prop)) {
          const valueSymbol = L.checker.getShorthandAssignmentValueSymbol(prop) ?? null;
          const local = valueSymbol ? L.resolveKey(valueSymbol, bindTo) : null;
          const g = valueSymbol ? L.globalsBySymbol.get(valueSymbol) : undefined;
          targetBinding = local ? { id: local.id, type: local.type } : g ? { id: g.id, type: g.type } : null;
        } else {
          targetBinding = L.resolveWritable(bindTo);
        }
        if (!targetBinding) {
          L.rejectUnresolved(bindTo, `assignment to '${bindTo.text}' (not a writable local or module global)`);
        }
        out.push({
          kind: "assign",
          localId: targetBinding.id,
          value: L.coerceInto(prop, readOf(), targetBinding.type),
          loc: propLoc,
        });
      }
      return { stmts: out, value };
    }
    if (init.type.kind !== "record") {
      L.unsupported(
        "SC1031",
        blame,
        init.type.kind === "object"
          ? "destructuring assignment from class instances (read the fields directly — accessors make the desugar observable)"
          : `destructuring assignment from non-record values (the source is ${init.type.kind}-typed)`,
      );
    }
    const srcType = init.type;
    const shape = L.shapes.get(srcType.shapeId);
    if (!shape) throw new Error(`lowerer bug: destructuring unknown shape ${srcType.shapeId}`);
    for (const prop of target.properties) {
      // Shorthand `{ a }` assigns local a from field a; `{ a: x }` assigns
      // x from field a (a PropertyAssignment whose initializer is the
      // target — JS reuses the literal syntax with inverted roles).
      let fieldName: string;
      let bindTo: ts.Expression;
      let dfltInit: ts.Expression | null = null;
      if (ts.isSpreadAssignment(prop)) {
        // `{ a, ...bar }`: the fields no OTHER property consumed pack into
        // a fresh record (JS's CopyDataProperties makes a fresh object of
        // copied values too), then assign like any record value.
        let restTo: ts.Expression = prop.expression;
        while (ts.isParenthesizedExpression(restTo)) restTo = restTo.expression;
        if (shape.indexValue) {
          L.unsupported("SC1031", prop, "rest bindings over index-signature shapes (the undeclared entries would need overflow packing)");
        }
        const consumed = new Set<string>();
        for (const p of target.properties) {
          if (ts.isShorthandPropertyAssignment(p)) consumed.add((p.name as ts.Identifier).text);
          else if (ts.isPropertyAssignment(p)) {
            const n = patternKeyNameOf(L, p.name);
            if (n !== null) consumed.add(n);
          }
        }
        const remaining = shape.fields.filter((f) => !consumed.has(f.name));
        const restOrder = shape.declaredOrder?.filter((n) => !consumed.has(n));
        const restShapeId = L.shapes.intern(
          remaining.map((f) => ({ name: f.name, type: f.type })),
          false,
          undefined,
          restOrder,
        );
        if (restOrder !== undefined) {
          L.shapeOrderMetadataFinalizers.push(
            L.shapes.declaredOrderFinalizer(
              restShapeId,
              restOrder,
              () => L.shapes.get(srcType.shapeId)?.declaredOrder?.filter((n) => !consumed.has(n)),
            ),
          );
        }
        const packed: IrExpr = {
          kind: "recordLit",
          fields: remaining.map((f) => ({
            name: f.name,
            value: { kind: "recordGet", obj: { kind: "varRef", localId: tmp.id, type: srcType, loc: locOf(prop) }, shapeId: srcType.shapeId, field: f.name, type: f.type, loc: locOf(prop) },
          })),
          type: { kind: "record", shapeId: restShapeId },
          loc: locOf(prop),
        };
        if (!ts.isIdentifier(restTo)) {
          // `({ a, ...box.rest } = src)` — the rest packs identically and
          // lands through the property/element write machinery.
          lowerAssignTargetInto(L, out, restTo, prop, null, () => packed);
          continue;
        }
        const targetBinding = L.resolveWritable(restTo);
        if (!targetBinding) {
          L.rejectUnresolved(restTo, `assignment to '${restTo.text}' (not a writable local or module global)`);
        }
        out.push({
          kind: "assign",
          localId: targetBinding.id,
          value: L.coerceInto(prop, packed, targetBinding.type),
          loc: locOf(prop),
        });
        continue;
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        fieldName = (prop.name as ts.Identifier).text;
        bindTo = prop.name as ts.Identifier;
        dfltInit = prop.objectAssignmentInitializer ?? null;
      } else if (ts.isPropertyAssignment(prop)) {
        // Identifier keys spell themselves; literal and FOLDABLE computed
        // keys (`{ [k]: v } = o` with a pure single-name k) resolve to the
        // static field name tsc late-bound. Runtime-valued keys fence.
        const folded = patternKeyNameOf(L, prop.name);
        if (folded === null) {
          L.unsupported("SC1031", prop, "destructuring assignment with computed keys that do not fold to one property name");
        }
        fieldName = folded;
        bindTo = prop.initializer;
        // `{ a: x = 1 }`: the renamed target with a default parses as the
        // assignment `x = 1` in the initializer slot.
        if (ts.isBinaryExpression(bindTo) && bindTo.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          dfltInit = bindTo.right;
          bindTo = bindTo.left;
        }
      } else {
        L.unsupported("SC1031", prop, "destructuring assignment with getter/setter or method properties");
      }
      while (ts.isParenthesizedExpression(bindTo)) bindTo = bindTo.expression;
      if (!ts.isIdentifier(bindTo)) {
        // Nested patterns and property/element targets: the element's
        // value (default applied at the target's own type) lands through
        // the shared non-variable machinery.
        const fieldT = shape.fields.find((f) => f.name === fieldName)?.type;
        const dflt = dfltInit;
        lowerAssignTargetInto(L, out, bindTo, prop, dflt, (targetT) => {
          if (!fieldT) {
            // The defaulted read of a field the shape does not carry is
            // always undefined — the default IS the value (the identifier
            // path's rule below).
            if (dflt && targetT) return L.lowerExprExpecting(dflt, targetT);
            L.unsupported("SC1031", prop, `destructuring the field '${fieldName}' the source shape does not carry`);
          }
          let v: IrExpr = {
            kind: "recordGet",
            obj: { kind: "varRef", localId: tmp.id, type: srcType, loc: locOf(prop) },
            shapeId: srcType.shapeId,
            field: fieldName,
            type: fieldT,
            loc: locOf(prop),
          };
          if (dflt && targetT) v = undefArmDefault(L, prop, dflt, v, targetT);
          return v;
        });
        continue;
      }
      // Shorthand names resolve to the PROPERTY symbol at their location;
      // the VALUE symbol (the binding being assigned) comes from the
      // checker's shorthand-specific query. Renamed targets are ordinary
      // identifier references.
      let targetBinding: { id: string; type: IrType } | null;
      if (ts.isShorthandPropertyAssignment(prop)) {
        const valueSymbol = L.checker.getShorthandAssignmentValueSymbol(prop) ?? null;
        const local = valueSymbol ? L.resolveKey(valueSymbol, bindTo) : null;
        const g = valueSymbol ? L.globalsBySymbol.get(valueSymbol) : undefined;
        targetBinding = local ? { id: local.id, type: local.type } : g ? { id: g.id, type: g.type } : null;
      } else {
        targetBinding = L.resolveWritable(bindTo);
      }
      if (!targetBinding) {
        L.rejectUnresolved(bindTo, `assignment to '${bindTo.text}' (not a writable local or module global)`);
      }
      const fieldType = shape.fields.find((f) => f.name === fieldName)?.type;
      if (!fieldType) {
        // A defaulted target over a field the shape does not carry: the
        // read is always undefined, so the default IS the assignment (the
        // declaration path's rule).
        if (dfltInit) {
          out.push({
            kind: "assign",
            localId: targetBinding.id,
            value: L.lowerExprExpecting(dfltInit, targetBinding.type),
            loc: locOf(prop),
          });
          continue;
        }
        L.unsupported("SC1031", prop, `destructuring the field '${fieldName}' the source shape does not carry`);
      }
      let value: IrExpr = {
        kind: "recordGet",
        obj: { kind: "varRef", localId: tmp.id, type: srcType, loc: locOf(prop) },
        shapeId: srcType.shapeId,
        field: fieldName,
        type: fieldType,
        loc: locOf(prop),
      };
      // `{ x = 1 }`: the default fires exactly when the field holds the
      // undefined arm (JS's rule), against the TARGET binding's own type.
      if (dfltInit) value = undefArmDefault(L, prop, dfltInit, value, targetBinding.type);
      out.push({
        kind: "assign",
        localId: targetBinding.id,
        value: L.coerceInto(prop, value, targetBinding.type),
        loc: locOf(prop),
      });
    }
    return { stmts: out, value };
  }

/** A destructuring-ASSIGNMENT target that is not a plain variable:
   * PROPERTY targets (`({ a: this.x } = o)`, `[c.x, c.y] = t` — the
   * receiver evaluates into a hidden temp at the element's pattern
   * position, BEFORE the element's value read, JS's get-the-reference-
   * then-GetV order), ELEMENT targets over arrays (runtime f64 index)
   * and tuples/records (literal keys) with the same receiver/key temp
   * discipline, and NESTED patterns (`({ p: { q } } = o)`, `[[a], b] = t`
   * — the element's value destructures through the same assignment
   * machinery, its own hidden temp included). `valueOf` builds the
   * (defaulted) source value at the target's own type; it receives null
   * exactly for nested patterns, which have no single binding type —
   * defaults there keep a fence (JS would need the pattern's implied
   * type to test against). Optional-chain targets are not assignment
   * targets in JS at all; index-signature runtime keys and island/dyn
   * receivers keep the fence below. */
  function lowerAssignTargetInto(L: Lowerer, out: IrStmt[], targetNode: ts.Expression,
    blame: ts.Node,
    dflt: ts.Expression | null,
    valueOf: (targetT: IrType | null) => IrExpr,): void {
    let t = targetNode;
    while (ts.isParenthesizedExpression(t)) t = t.expression;
    const loc = locOf(t);
    if (ts.isObjectLiteralExpression(t) || ts.isArrayLiteralExpression(t)) {
      if (dflt) {
        L.unsupported(
          "SC1031",
          blame,
          "defaults on nested patterns in destructuring assignment (bind a variable with the default, then destructure it)",
        );
      }
      const sub = destructuringAssignInto(L, t, valueOf(null), null, blame, loc);
      out.push(...sub.stmts);
      return;
    }
    if (ts.isPropertyAccessExpression(t) && !t.questionDotToken) {
      const ft = L.fieldTarget(t);
      if (ft) {
        // The receiver temps FIRST: JS evaluates the target reference
        // before reading the element's value, so a side-effecting
        // receiver (`f().x`) must run before the source read the
        // defaulted value machinery may emit.
        const recv = L.declareHiddenLocal("%dtRecv", ft.obj.type);
        out.push({ kind: "varDecl", localId: recv.id, init: ft.obj, loc });
        const value = L.coerceInto(blame, valueOf(ft.fieldType), ft.fieldType);
        out.push(L.fieldSetStmt({ ...ft, obj: { kind: "varRef", localId: recv.id, type: ft.obj.type, loc } }, value, loc, t));
        return;
      }
    }
    if (ts.isElementAccessExpression(t) && !t.questionDotToken) {
      const recvT = L.mapTypeOf(L.typeOf(t.expression));
      if (recvT?.kind === "array") {
        const arr = L.lowerExpr(t.expression);
        if (arr.type.kind === "array") {
          const recv = L.declareHiddenLocal("%dtRecv", arr.type);
          out.push({ kind: "varDecl", localId: recv.id, init: arr, loc });
          const index = L.lowerExpr(t.argumentExpression);
          if (index.type.kind !== "f64") {
            L.unsupported("SC1090", t.argumentExpression, "indexing with non-number keys");
          }
          const idx = L.declareHiddenLocal("%dtIdx", F64);
          out.push({ kind: "varDecl", localId: idx.id, init: index, loc });
          const value = L.coerceInto(blame, valueOf(recvT.elem), recvT.elem);
          out.push({
            kind: "arraySet",
            arr: { kind: "varRef", localId: recv.id, type: arr.type, loc },
            index: { kind: "varRef", localId: idx.id, type: F64, loc },
            value,
            loc,
          });
          return;
        }
      } else if (recvT?.kind === "record") {
        // Tuple positions and LITERAL declared record keys are field
        // writes (the element-write lowering's own rule); runtime keys
        // keep the fence below.
        const shape = L.shapes.get(recvT.shapeId);
        const litKey = ts.isStringLiteralLike(t.argumentExpression) || ts.isNumericLiteral(t.argumentExpression)
          ? L.foldedStringKeyOf(t.argumentExpression)
          : null;
        const field = litKey !== null ? shape?.fields.find((f) => f.name === litKey) : undefined;
        if (field) {
          const obj = L.lowerExpr(t.expression);
          if (obj.type.kind === "record") {
            const recv = L.declareHiddenLocal("%dtRecv", obj.type);
            out.push({ kind: "varDecl", localId: recv.id, init: obj, loc });
            const value = L.coerceInto(blame, valueOf(field.type), field.type);
            out.push({
              kind: "recordSet",
              obj: { kind: "varRef", localId: recv.id, type: obj.type, loc },
              shapeId: recvT.shapeId,
              field: field.name,
              value,
              loc,
            });
            return;
          }
        }
      }
    }
    L.unsupported(
      "SC1031",
      targetNode,
      "destructuring assignment to targets with no static write form (assign a variable, then write the parts out)",
    );
  }

/** One object-pattern property's pieces for the checked-dynamic path:
   * the source FIELD name (or, over ISLAND sources, a runtime KEY
   * expression the engine indexes with) and the resolved writable target.
   * Shorthand (`{ a }`) and renamed (`{ a: x }`) identifier targets only —
   * the record path's rules, shared fences. */
  function destructAssignPiece(L: Lowerer, prop: ts.ObjectLiteralElementLike, islandSource: boolean,): { field: string; keyExpr?: ts.Expression; target: { id: string; type: IrType } } {
    let fieldName: string;
    let keyExpr: ts.Expression | undefined;
    let bindTo: ts.Expression;
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.objectAssignmentInitializer) {
        L.unsupported("SC1031", prop, "destructuring assignment with defaults (assign, then apply the default)");
      }
      fieldName = (prop.name as ts.Identifier).text;
      bindTo = prop.name as ts.Identifier;
    } else if (ts.isPropertyAssignment(prop)) {
      // Identifier keys spell themselves; literal and FOLDABLE computed
      // keys resolve statically (the record path's rule) — the keyed read
      // below takes the folded name. A RUNTIME-valued key over an ISLAND
      // source reads through the engine's own indexing at the element's
      // pattern position (`({ [key]: w } = src)`); over the checked-dynamic tree the fence
      // stays.
      const folded = patternKeyNameOf(L, prop.name);
      if (folded === null) {
        if (islandSource && ts.isComputedPropertyName(prop.name)) {
          keyExpr = prop.name.expression;
        } else {
          L.unsupported("SC1031", prop, "destructuring assignment with computed keys that do not fold to one property name");
        }
      }
      fieldName = folded ?? "";
      bindTo = prop.initializer;
    } else {
      L.unsupported("SC1031", prop, "destructuring assignment with rest or spread properties");
    }
    if (!ts.isIdentifier(bindTo)) {
      L.unsupported(
        "SC1031",
        bindTo,
        "destructuring assignment to nested patterns or non-variable targets (assign a variable, then write the parts out)",
      );
    }
    let target: { id: string; type: IrType } | null;
    if (ts.isShorthandPropertyAssignment(prop)) {
      const valueSymbol = L.checker.getShorthandAssignmentValueSymbol(prop) ?? null;
      const local = valueSymbol ? L.resolveKey(valueSymbol, bindTo) : null;
      const g = valueSymbol ? L.globalsBySymbol.get(valueSymbol) : undefined;
      target = local ? { id: local.id, type: local.type } : g ? { id: g.id, type: g.type } : null;
    } else {
      target = L.resolveWritable(bindTo);
    }
    if (!target) {
      L.rejectUnresolved(bindTo, `assignment to '${bindTo.text}' (not a writable local or module global)`);
    }
    return { field: fieldName, ...(keyExpr !== undefined ? { keyExpr } : {}), target };
  }

/** The ARRAY half of destructuring assignment: element assigns from a
   * tuple/array/checked-dynamic source pushed into `out` (see
   * lowerDestructuringAssignParts). Holes skip, defaults carry the array
   * bounds test (JS reads undefined past the end), rest packs the tail
   * fresh (array slices, tuple tails). */
  function lowerArrayAssignInto(L: Lowerer, out: IrStmt[], target: ts.ArrayLiteralExpression,
    tmpRef: () => IrExpr,
    blame: ts.Node,
    loc: SrcLoc,): void {
    let srcType = tmpRef().type;
    // A STRING source (`[a, b] = s`): the declaration path's rule in
    // assignment position — the string iterator's code-point split
    // (%str.chars, astral characters whole) into a hidden chars array,
    // then the pattern proceeds as an array pattern over string[]
    // (defaults with the bounds test, rest packing the remaining code
    // points, elisions; positions past the last code point inherit the
    // array divergence). The EMPTY pattern skips the split — GetIterator
    // + close, nothing observable — through the iterable early-return
    // below. Callers vetted the source as a checker-typed string.
    if (srcType.kind === "string" && target.elements.length > 0) {
      const charsT = arrayOf(STRING);
      const chars = L.declareHiddenLocal("%dchars", charsT);
      out.push({ kind: "varDecl", localId: chars.id, init: strCharsCall(L, tmpRef(), loc), loc });
      tmpRef = () => ({ kind: "varRef", localId: chars.id, type: charsT, loc });
      srcType = charsT;
    }
    // A sole leading rest whose operand is ITSELF an array pattern
    // (`[...[a, b = 0]] = t`): the rest collects every element, then the
    // inner pattern destructures the collection — over arrays/tuples that
    // consumes exactly the elements the inner pattern alone would, so the
    // unwrap is exact. Identifier rest operands pack in the element loop
    // below.
    let elements: readonly ts.Expression[] = target.elements;
    if (elements.length === 1 && ts.isSpreadElement(elements[0]!) && ts.isArrayLiteralExpression(elements[0]!.expression)) {
      elements = elements[0]!.expression.elements;
    }
    // The element-read builder per source kind; null when the source
    // cannot destructure.
    const shape = srcType.kind === "record" ? L.shapes.get(srcType.shapeId) : undefined;
    const isTuple = shape?.tuple === true;
    let elemsRef: (() => IrExpr) | null = null;
    if (srcType.kind === "dyn" || srcType.kind === "jsval") {
      // GetIterator + the pattern's width, V8's exact TypeErrors
      // (dynIterN — the engine's real iterator protocol on the island
      // side); the empty pattern is pure validation.
      const iterTmp = L.declareHiddenLocal("%destrIter", srcType);
      out.push({
        kind: "varDecl",
        localId: iterTmp.id,
        init: { kind: "dynIterN", value: tmpRef(), count: elements.length, type: srcType, loc },
        loc,
      });
      elemsRef = () => ({ kind: "varRef", localId: iterTmp.id, type: srcType, loc });
    } else if (srcType.kind !== "array" && srcType.kind !== "bytes" && !isTuple) {
      if (elements.length === 0 && (srcType.kind === "string" || srcType.kind === "map" || srcType.kind === "set")) {
        // `[] = e` over a statically-iterable source: GetIterator +
        // immediate close — no user code can observe it, so evaluating
        // the RHS is the whole statement.
        return;
      }
      L.unsupported(
        "SC1031",
        blame,
        `array destructuring assignment from non-array values (the source is ${L.fmt(srcType)}-typed)`,
      );
    }
    const elemRead = (i: number, at: ts.Node): IrExpr => {
      if (elemsRef) {
        const elems = elemsRef();
        if (elems.type.kind === "jsval") {
          const key: IrExpr = { kind: "numLit", value: i, type: F64, loc: locOf(at) };
          return { kind: "jsOp", op: "getIdx", args: [elems, L.jsvalIn(key, at as ts.Expression)], type: JSVAL, loc: locOf(at) };
        }
        return { kind: "dynKeyGet", key: { kind: "strLit", value: String(i), type: STRING, loc: locOf(at) }, value: elems, type: DYN, loc: locOf(at) };
      }
      if (isTuple) {
        const fieldType = shape!.fields.find((f) => f.name === String(i))?.type;
        if (!fieldType) {
          L.unsupported("SC1031", at, `destructuring the element ${i} the source tuple does not carry`);
        }
        return { kind: "recordGet", obj: tmpRef(), shapeId: (srcType as IrType & { kind: "record" }).shapeId, field: String(i), type: fieldType, loc: locOf(at) };
      }
      if (srcType.kind === "bytes") {
        return {
          kind: "bytesIntrinsic",
          method: "get",
          receiver: tmpRef(),
          args: [{ kind: "numLit", value: i, type: F64, loc: locOf(at) }],
          type: F64,
          loc: locOf(at),
        };
      }
      // Plain arrays read by index — a pattern wider than the runtime
      // array traps (the arrayGet discipline, divergence 4's policy; JS
      // would answer undefined).
      const elemType = (srcType as IrType & { kind: "array" }).elem;
      return { kind: "arrayGet", arr: tmpRef(), index: { kind: "numLit", value: i, type: F64, loc: locOf(at) }, type: elemType, loc: locOf(at) };
    };
    elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return; // elision: position consumed, nothing assigned
      let targetNode: ts.Expression = el;
      let defaultNode: ts.Expression | null = null;
      let isRest = false;
      if (ts.isSpreadElement(el)) {
        // `[a, ...rest]`: the tail packs FRESH (JS's surplus packing
        // builds a new array) — array slices, tuple tails under the
        // target's own type. Checked-dynamic sources keep the fence (the
        // engine's iterator would have to drain into a compiled array).
        if (elemsRef) {
          L.unsupported("SC1031", el, "rest elements in destructuring assignment from checked-dynamic sources (collect with .slice() instead)");
        }
        isRest = true;
        targetNode = el.expression;
      } else if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        // `[x = 1]` in assignment position parses as the assignment
        // `x = 1` in the element slot.
        targetNode = el.left;
        defaultNode = el.right;
      }
      while (ts.isParenthesizedExpression(targetNode)) targetNode = targetNode.expression;
      // The element's (defaulted) value at the target's own type — shared
      // by variable, property/element, and nested-pattern targets (the
      // latter receive null: no single binding type exists there, and
      // defaults on nested targets fence in the shared machinery).
      const readOf = (targetT: IrType | null): IrExpr => {
        if (isRest) {
          if (srcType.kind === "bytes") {
            const all: IrExpr = {
              kind: "bytesIntrinsic",
              method: "toArray",
              receiver: tmpRef(),
              args: [],
              type: arrayOf(F64),
              loc: locOf(el),
            };
            return {
              kind: "arrIntrinsic",
              method: "slice",
              receiver: all,
              args: [{ kind: "numLit", value: i, type: F64, loc: locOf(el) }],
              type: arrayOf(F64),
              loc: locOf(el),
            };
          }
          return isTuple
            ? tupleTailValue(L, el, tmpRef, srcType as IrType & { kind: "record" }, shape!, i, targetT)
            : { kind: "arrIntrinsic", method: "slice", receiver: tmpRef(), args: [{ kind: "numLit", value: i, type: F64, loc: locOf(el) }], type: srcType, loc: locOf(el) };
        }
        if (isTuple && defaultNode !== null && targetT !== null && !shape!.fields.some((f) => f.name === String(i))) {
          // Past the tuple's end the read is always undefined — the default
          // IS the assignment (JS evaluates it unconditionally there).
          return L.lowerExprExpecting(defaultNode, targetT);
        }
        // Defaults: JS applies the default ONLY when the element reads
        // undefined. A checked-dynamic element tests at runtime; a tuple
        // position tests its undefined arm (a never-undefined field makes
        // the default dead — JS would not evaluate it either); an array
        // position carries the bounds test (past the end JS reads
        // undefined where the plain read would trap).
        let read = elemRead(i, el);
        if (defaultNode !== null) {
          if (read.type.kind === "dyn" || read.type.kind === "jsval") {
            const boundary = read.type;
            const elemTmp = L.declareHiddenLocal("%destrElem", boundary);
            out.push({ kind: "varDecl", localId: elemTmp.id, init: read, loc: locOf(el) });
            const elemVar = (): IrExpr => ({ kind: "varRef", localId: elemTmp.id, type: boundary, loc: locOf(el) });
            const isUndef: IrExpr =
              boundary.kind === "jsval"
                ? { kind: "jsOp", op: "eq", args: [elemVar(), { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc: locOf(el) }], type: BOOL, loc: locOf(el) }
                : { kind: "dynTest", test: "undefined", value: elemVar(), type: BOOL, loc: locOf(el) };
            const dflt = L.lowerExpr(defaultNode);
            read = {
              kind: "ternary",
              cond: isUndef,
              then: boundary.kind === "jsval" ? L.jsvalIn(dflt, defaultNode) : L.coerceInto(defaultNode, dflt, DYN),
              else_: elemVar(),
              type: boundary,
              loc: locOf(el),
            };
          } else if (targetT !== null) {
            read = isTuple
              ? undefArmDefault(L, el, defaultNode, read, targetT)
              : arrayPositionDefaultValue(
                  L,
                  el,
                  defaultNode,
                  read,
                  tmpRef,
                  i,
                  srcType.kind === "bytes"
                    ? F64
                    : (srcType as IrType & { kind: "array" }).elem,
                  targetT,
                  out,
                );
          }
        }
        return read;
      };
      if (!ts.isIdentifier(targetNode)) {
        lowerAssignTargetInto(L, out, targetNode, el, defaultNode, readOf);
        return;
      }
      const targetBinding = L.resolveWritable(targetNode);
      if (!targetBinding) {
        L.rejectUnresolved(targetNode, `assignment to '${targetNode.text}' (not a writable local or module global)`);
      }
      out.push({
        kind: "assign",
        localId: targetBinding.id,
        value: L.coerceInto(el, readOf(targetBinding.type), targetBinding.type),
        loc: locOf(el),
      });
    });
  }

/** `for (const x of arr)` — arrays only. The lib types strings and Maps
   * as iterable too, so those for-ofs typecheck and are fenced below with
   * specific diagnostics; other iterables fail on their types. The loop
   * variable is a fresh const binding per iteration (its own scope, like a
   * loop body). */
  export function lowerForOf(L: Lowerer, stmt: ts.ForOfStatement): IrStmt {
    // Labels consume HERE (nested statements must never see them). The
    // plain array/string paths carry them; the container/matchAll/stdin
    // desugars drop them — a labeled jump naming those loops fences at the
    // jump site (no label point exists in their desugared shape).
    const labels = L.takeLabels();
    // `for await` is ASYNC ITERATION, not the shipped async/await. ONE
    // async iterable has a lowering: process.stdin (the piped-input
    // pattern real CLIs use) — see lowerForAwaitStdin. Everything else is
    // named specifically (the bare SC1070 text would claim async/await
    // itself is missing).
    if (stmt.awaitModifier) {
      if (
        ts.isPropertyAccessExpression(stmt.expression) &&
        L.stdlibGlobalMember(stmt.expression, "process") === "stdin"
      ) {
        return lowerForAwaitStdin(L, stmt);
      }
      // Readable streams (the readableAsyncIterator surface): the mapped
      // receiver class roots at a readable-sided stream class.
      {
        const recvT = L.mapTypeOf(L.typeOf(stmt.expression));
        if (recvT?.kind === "object") {
          const info = L.classes.get(recvT.className);
          const sides = streamSidesOf(L, info);
          if (sides === "r" || sides === "rw") {
            return lowerForAwaitReadable(L, stmt, recvT);
          }
        }
      }
      L.unsupported("SC1070", stmt, "'for await' (async iteration over anything but process.stdin and readable streams)");
    }
    L.fenceStaticHeadersIteration(stmt.expression);
    // A stored numeric value iterator declared in this function keeps its
    // built-in protocol state in hidden locals (lowerVarStatement). The
    // iterator's own [Symbol.iterator]() returns itself, so for-of resumes
    // that cursor rather than starting another indexed-source walk.
    {
      let src: ts.Expression = stmt.expression;
      while (ts.isParenthesizedExpression(src)) src = src.expression;
      if (ts.isIdentifier(src)) {
        const sym = L.resolveValueSymbol(src);
        const state = sym ? L.numericIterators.get(sym) : undefined;
        if (state?.ctx === L.ctx) {
          return lowerForOfStoredNumericIterator(L, stmt, state, labels);
        }
      }
    }
    // `for (const k of m.keys())` / `.values()` / `.entries()`: the
    // iterator methods consumed DIRECTLY by a for-of head ride the
    // container's live walk — exactly `for..of m` with the projection
    // applied (JS's container iterators are live views, so the desugar's
    // add-visited/delete-skipped contract is the iterator's own). Stored
    // iterator OBJECTS still have no lowering — the drain-hint fence
    // stays for every other position.
    {
      let src: ts.Expression = stmt.expression;
      while (ts.isParenthesizedExpression(src)) src = src.expression;
      if (
        ts.isCallExpression(src) &&
        src.arguments.length === 0 &&
        !src.questionDotToken &&
        ts.isPropertyAccessExpression(src.expression) &&
        !src.expression.questionDotToken &&
        (src.expression.name.text === "keys" ||
          src.expression.name.text === "values" ||
          src.expression.name.text === "entries") &&
        L.isStdlibMember(src.expression)
      ) {
        const proj = src.expression.name.text as ForOfIterProjection;
        const recv = L.mapTypeOf(L.typeOf(src.expression.expression));
        if (recv?.kind === "map" || recv?.kind === "set") {
          const container = L.lowerExpr(src.expression.expression);
          if (container.type.kind === "map") {
            return lowerForOfMap(L, stmt, container, container.type, proj);
          }
          if (container.type.kind === "set") {
            return lowerForOfSet(L, stmt, container, container.type, proj);
          }
        }
        // URLSearchParams projections ride the same head-consumed rule:
        // the live index walk with the projection applied.
        if (recv?.kind === "searchParams") {
          return lowerForOfSearchParams(L, stmt, L.lowerExpr(src.expression.expression), proj);
        }
        // ARRAY keys()/entries() projections: the live index walk yielding
        // the index or the [index, element] pair (lower-containers).
        // `values` falls through to the receiver unwrap below.
        if (recv?.kind === "array" && (proj === "keys" || proj === "entries")) {
          const container = L.lowerExpr(src.expression.expression);
          if (container.type.kind === "array") {
            return lowerForOfArrayIter(L, stmt, container as IrExpr & { type: IrType & { kind: "array" } }, proj);
          }
        }
        // Typed arrays expose the same live indexed iterator projections.
        // Their fixed length makes the walk simpler, but the yielded keys
        // and [key, numeric value] pairs are identical to Array's.
        if (recv?.kind === "bytes" && (proj === "keys" || proj === "entries")) {
          const container = L.lowerExpr(src.expression.expression);
          if (container.type.kind === "bytes") {
            return lowerForOfArrayIter(
              L,
              stmt,
              container as IrExpr & { type: IrType & { kind: "bytes" } },
              proj,
            );
          }
        }
      }
    }
    // `for (const m of s.matchAll(re))` — direct call or a stored-const
    // drain (`const rows = s.matchAll(re); for (const m of rows)`) — with
    // a plain const identifier binding: the drain records each match's
    // UTF-16 start index into a COMPANION array, and `m.index` in the
    // body reads the current row's entry — the one shape where
    // RegExpExecArray.index has a lowering (rows are honest string[]
    // slices everywhere else). const only: a reassigned `let` binding
    // would decouple the row from its index.
    {
      let src: ts.Expression = stmt.expression;
      while (ts.isParenthesizedExpression(src)) src = src.expression;
      const constIdentBinding =
        ts.isVariableDeclarationList(stmt.initializer) &&
        (stmt.initializer.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isIdentifier(stmt.initializer.declarations[0]!.name);
      if (constIdentBinding) {
        const call = directMatchAllCallOf(L, src);
        if (call) return lowerForOfMatchAll(L, stmt, call, null);
        if (ts.isIdentifier(src)) {
          const sym = L.resolveValueSymbol(src);
          const drain = sym ? L.matchAllDrainIndexes.get(sym) : undefined;
          // Same-function walks only: hidden locals don't cross closure
          // boundaries — elsewhere the plain array walk (and the .index
          // fence) applies.
          if (drain && drain.ctx === L.ctx) {
            return lowerForOfMatchAll(L, stmt, null, { rows: L.lowerExpr(src), idxsLocalId: drain.idxsLocalId });
          }
        }
      }
    }
    // A DIRECT built-in value-iterator expression needs no first-class
    // iterator object. The numeric recognizer covers number[] / typed
    // arrays and both values/default spellings; retain the established
    // generic Array.prototype.values() unwrap for every other T[] too.
    // Stored numeric values took the retained-state path above.
    let iterSrc = numericIteratorSourceOf(L, stmt.expression);
    if (iterSrc === null) {
      let e: ts.Expression = stmt.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (
        ts.isCallExpression(e) &&
        !e.questionDotToken &&
        e.arguments.length === 0 &&
        ts.isPropertyAccessExpression(e.expression) &&
        !e.expression.questionDotToken &&
        e.expression.name.text === "values" &&
        L.isStdlibMember(e.expression) &&
        L.mapTypeOf(L.typeOf(e.expression.expression))?.kind === "array"
      ) {
        iterSrc = e.expression.expression;
      }
    }
    iterSrc ??= stmt.expression;
    let iterable = L.lowerExpr(iterSrc);
    if (iterable.type.kind === "bytes") {
      return lowerForOfBytes(
        L,
        stmt,
        iterable as IrExpr & { type: IrType & { kind: "bytes" } },
        labels,
      );
    }
    if (iterable.type.kind !== "array") {
      // The lib types strings as iterable too, so those for-ofs typecheck;
      // only arrays, Maps, and Sets have a lowering. Named specifically —
      // the blanket type fence would blame the TYPE, which is itself supported.
      if (iterable.type.kind === "string") {
        // JS's string iterator walks code POINTS, not units: each pass
        // yields the whole character (two UTF-16 units for astral chars,
        // where charAt would truncate to U+FFFD).
        return lowerForOfString(L, stmt, iterable, labels);
      }
      if (iterable.type.kind === "map") {
        // Maps iterate [key, value] entries with the forEach desugar's
        // live-iteration contract (lower-containers).
        return lowerForOfMap(L, stmt, iterable, iterable.type);
      }
      if (iterable.type.kind === "set") {
        return lowerForOfSet(L, stmt, iterable, iterable.type);
      }
      if (iterable.type.kind === "searchParams") {
        // URLSearchParams iterates [name, value] pairs with the live
        // index walk (lower-containers).
        return lowerForOfSearchParams(L, stmt, iterable);
      }
      if (iterable.type.kind === "generator") {
        // Generators drive through the .next()/.return() protocol — the
        // desugared while over genResume (lower-generators).
        return lowerForOfGenerator(L, stmt, iterable as IrExpr & { type: IrType & { kind: "generator" } }, labels);
      }
      if (iterable.type.kind === "object") {
        // Class iterables ([Symbol.iterator]() + next() — classIteratorOf)
        // drive the same protocol with ordinary method calls.
        const cit = L.classIteratorOf(iterable.type);
        if (cit) return lowerForOfClassIterator(L, stmt, iterable, cit, labels);
        // A declared [Symbol.iterator] whose shape classIteratorOf refused
        // (an `any`-typed iterator or result, a declared return()/throw()):
        // name the protocol, not the class.
        const info = L.classes.get(iterable.type.className);
        if (info && L.findMethodOn(info, "sym:iterator")) {
          L.unsupported(
            "SC1090",
            stmt.expression,
            `for-of over this [Symbol.iterator] shape (the method must take no parameters and return an object whose zero-parameter next() returns a { value, done? } record with a boolean done; iterator classes declaring return()/throw() stay out — IteratorClose has no lowering)`,
          );
        }
      }
      if (
        iterable.type.kind === "record" &&
        L.shapes.get(iterable.type.shapeId)?.tuple
      ) {
        // A tuple read PURELY iterates: the positions snapshot into a
        // fresh array at loop entry and the ordinary array for-of runs
        // over it — the allowlist-iteration idiom. HOMOGENEOUS tuples
        // (`["a", "b"] as const`) snapshot at their one position type;
        // heterogeneous tuples ([string, boolean]) snapshot into the
        // positions' UNION when it interns, each read wrapping into its
        // arm — exactly the string|boolean the checker gives the loop
        // variable. Pure receivers only (the reads re-emit per position);
        // JS reads positions lazily, so a body that WRITES a later
        // position of a mutable tuple would observe its old value here —
        // readonly (as-const) tuples, the shape that actually occurs,
        // cannot be written at all.
        const shape = L.shapes.get(iterable.type.shapeId)!;
        const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
        const first = byIndex[0]?.type;
        const homogeneous = first !== undefined && byIndex.every((f) => typeEquals(f.type, first));
        let elemT: IrType | null = homogeneous ? first : null;
        if (!homogeneous && byIndex.length > 0) {
          const arms: IrType[] = [];
          for (const f of byIndex) {
            const arm = f.type.kind === "union" ? null : f.type;
            if (arm === null) { elemT = null; break; }
            if (!arms.some((a) => typeEquals(a, arm))) arms.push(arm);
            elemT = { kind: "union", unionId: L.unions.intern(arms) };
          }
        }
        if (elemT !== null && pureReemittable(iterable)) {
          const loc = locOf(stmt.expression);
          const shapeId = iterable.type.shapeId;
          const snapshotElem = elemT;
          iterable = {
            kind: "arrayLit",
            elems: byIndex.map((f) => {
              const read: IrExpr = {
                kind: "recordGet",
                obj: iterable,
                shapeId,
                field: f.name,
                type: f.type,
                loc,
              };
              return typeEquals(f.type, snapshotElem)
                ? read
                : L.coerceInto(stmt.expression, read, snapshotElem);
            }),
            type: arrayOf(snapshotElem),
            loc,
          };
        } else {
          L.noLowering("for-of over tuples", stmt.expression,
            "tuples with union-typed or unrepresentable positions are fixed-shape — read t[0], t[1], ... directly (plain-position tuples purely iterate)");
        }
      }
      // An ISLAND value (`for (const store of stores)` where stores is a
      // package-typed array — one engine handle): the engine's OWN
      // iterator protocol drives the loop — GetIterator through the
      // pinned prelude helper (V8's not-iterable TypeError on refusal),
      // next() through callMethod, done/value reads through getProp — so
      // engine arrays, Maps, Sets, generators, and Symbol.iterator
      // implementations all iterate exactly as Node runs them.
      if (iterable.type.kind === "jsval") {
        return lowerForOfIsland(L, stmt, iterable, labels);
      }
      // A CHECKED-DYNAMIC iterable (`unknown[]`, the collapsed
      // `(string | object)[]`, JSON-parsed values, wrapped engine
      // values): the source packs ONCE through the spread walk and a
      // hidden index loop binds each element as a dyn value.
      if (iterable.type.kind === "dyn") {
        return lowerForOfDyn(L, stmt, iterable, labels);
      }
      if (iterable.type.kind !== "array") {
        L.badType(stmt.expression, L.typeOf(stmt.expression));
      }
    }
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      // `for (x of xs)` over a PRE-DECLARED writable binding: JS assigns
      // the existing binding once per pass — one shared binding across
      // iterations, exactly the `var` loop-variable story (and where such
      // heads usually come from). Identifier targets lower as the
      // per-iteration assign; destructuring heads run the destructuring-
      // assignment machinery on the element once per pass; member-write
      // targets keep the fence.
      let target: ts.Node = stmt.initializer;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) {
        const elemType = iterable.type.elem;
        const loc = locOf(target);
        const tmp = L.declareHiddenLocal("%vof", elemType);
        const elemRef: IrExpr = { kind: "varRef", localId: tmp.id, type: elemType, loc };
        const assigns: IrStmt = lowerDestructuringAssign(L, target, elemRef, target, loc);
        const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
        return { kind: "forOf", localId: tmp.id, iterable, body: [assigns, ...body], ...(labels && { labels }), loc: locOf(stmt) };
      }
      if (ts.isIdentifier(target)) {
        const writable = L.resolveWritable(target);
        if (writable) {
          const elemType = iterable.type.elem;
          const loc = locOf(target);
          const tmp = L.declareHiddenLocal("%vof", elemType);
          const write: IrStmt = {
            kind: "assign",
            localId: writable.id,
            value: L.coerceInto(target, { kind: "varRef", localId: tmp.id, type: elemType, loc }, writable.type),
            loc,
          };
          const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
          return { kind: "forOf", localId: tmp.id, iterable, body: [write, ...body], ...(labels && { labels }), loc: locOf(stmt) };
        }
      }
      L.unsupported(
        "SC1090",
        stmt.initializer,
        "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
      );
    }
    const list = stmt.initializer;
    if ((list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.BlockScoped) === 0;
    const decl = list.declarations[0]!; // the grammar allows exactly one
    // `for (const [k, v] of pairs)` — a destructuring loop variable: the
    // element binds to a hidden per-iteration local and the pattern
    // desugars to reads of it at the top of the body, exactly the
    // declaration desugar (`const [k, v] = elem`) run once per iteration.
    // `var` pattern names ride the same desugar: bindPatternTarget assigns
    // their hoisted function-scoped slots instead of declaring locals.
    if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
      L.scopes.push(new Map());
      try {
        const elemType = iterable.type.elem;
        const loc = locOf(decl.name);
        const tmp = L.declareHiddenLocal("%destr", elemType);
        const binds: IrStmt[] = [];
        L.lowerBindingPattern(
          decl.name,
          () => ({ kind: "varRef", localId: tmp.id, type: elemType, loc }),
          elemType,
          isLet,
          binds,
        );
        const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
        return { kind: "forOf", localId: tmp.id, iterable, body: [...binds, ...body], ...(labels && { labels }), loc: locOf(stmt) };
      } finally {
        L.scopes.pop();
      }
    }
    if (!ts.isIdentifier(decl.name)) L.unsupported("SC1031", decl.name);

    L.scopes.push(new Map());
    try {
      // `for (var x of xs)`: the element lands in a hidden per-iteration
      // local and the body opens by ASSIGNING it into the one hoisted
      // binding — closures capture the shared slot, and the value persists
      // after the loop (both Node-exact for var).
      const varTarget = forOfVarTarget(L, decl);
      if (varTarget) {
        const elemType = iterable.type.elem;
        const loc = locOf(decl.name);
        const tmp = L.declareHiddenLocal("%vof", elemType);
        const write: IrStmt = {
          kind: "assign",
          localId: varTarget.id,
          value: L.coerceInto(decl.name, { kind: "varRef", localId: tmp.id, type: elemType, loc }, varTarget.type),
          loc,
        };
        const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
        return { kind: "forOf", localId: tmp.id, iterable, body: [write, ...body], ...(labels && { labels }), loc: locOf(stmt) };
      }
      const local = L.declareLocal(decl.name, decl.name.text, iterable.type.elem, isLet);
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return { kind: "forOf", localId: local.id, iterable, body, ...(labels && { labels }), loc: locOf(stmt) };
    } finally {
      L.scopes.pop();
    }
  }

/** Direct for-of over a represented typed array. The implicit iterator is
   * unobservable, so instantiate its source/cursor/done state as ordinary
   * hidden locals and share the retained numeric-iterator driver. */
  function lowerForOfBytes(
    L: Lowerer,
    stmt: ts.ForOfStatement,
    iterable: IrExpr & { type: IrType & { kind: "bytes" } },
    labels?: string[],
  ): IrStmt {
    const loc = locOf(stmt);
    const source = L.declareHiddenLocal("%numiterSource", iterable.type);
    const index = L.declareHiddenLocal("%numiterIndex", F64);
    const done = L.declareHiddenLocal("%numiterDone", BOOL);
    index.mutable = true;
    done.mutable = true;
    const loop = lowerForOfStoredNumericIterator(
      L,
      stmt,
      {
        sourceLocalId: source.id,
        sourceType: iterable.type,
        indexLocalId: index.id,
        doneLocalId: done.id,
      },
      labels,
    );
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: source.id, init: iterable, loc },
        { kind: "varDecl", localId: index.id, init: { kind: "numLit", value: 0, type: F64, loc }, loc },
        { kind: "varDecl", localId: done.id, init: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
        loop,
      ],
      loc,
    };
  }

/** Drive a stored built-in numeric value iterator through its retained
   * protocol state. Unlike the ordinary array for-of IR, the cursor
   * advances BEFORE the source body: breaking or returning from the body
   * leaves the iterator positioned at the next element. Natural
   * exhaustion sets the sticky done bit; breaking early does not.
   *
   *   while (true) {
   *     if (%done) break;
   *     if (%index >= %source.length) { %done = true; break; }
   *     const value = %source[%index];
   *     %index += 1;
   *     <assign/bind head>; <body>
   *   }
   */
  function lowerForOfStoredNumericIterator(
    L: Lowerer,
    stmt: ts.ForOfStatement,
    state: {
      sourceLocalId: string;
      sourceType: IrType;
      indexLocalId: string;
      doneLocalId: string;
    },
    labels?: string[],
  ): IrStmt {
    let exprTarget: { id: string; type: IrType } | null = null;
    let exprTargetNode: ts.Identifier | null = null;
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      let target: ts.Node = stmt.initializer;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isIdentifier(target)) {
        exprTarget = L.resolveWritable(target);
        exprTargetNode = target;
      }
      if (!exprTarget) {
        L.unsupported(
          "SC1090",
          stmt.initializer,
          "for-of over a stored numeric iterator assigning anything but a pre-declared identifier",
        );
      }
    }
    const list = ts.isVariableDeclarationList(stmt.initializer) ? stmt.initializer : null;
    if (list && (list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isLet = list !== null && (list.flags & ts.NodeFlags.Let) !== 0;
    const decl = list ? list.declarations[0]! : null;
    if (decl && !ts.isIdentifier(decl.name)) L.unsupported("SC1031", decl.name);

    const loc = locOf(stmt);
    const sourceT = state.sourceType;
    if (
      !(
        (sourceT.kind === "array" && sourceT.elem.kind === "f64") ||
        sourceT.kind === "bytes"
      )
    ) {
      throw new Error("internal: retained numeric iterator has a non-numeric source");
    }
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const indexRef = (): IrExpr => ref(state.indexLocalId, F64);
    const doneRef = (): IrExpr => ref(state.doneLocalId, BOOL);
    const sourceRef = (): IrExpr => ref(state.sourceLocalId, sourceT);
    const sourceLength = (): IrExpr => sourceT.kind === "array"
      ? {
          kind: "arrIntrinsic",
          method: "length",
          receiver: sourceRef(),
          args: [],
          type: F64,
          loc,
        }
      : {
          kind: "bytesIntrinsic",
          method: "length",
          receiver: sourceRef(),
          args: [],
          type: F64,
          loc,
        };
    const sourceValue = (): IrExpr => sourceT.kind === "array"
      ? { kind: "arrayGet", arr: sourceRef(), index: indexRef(), type: F64, loc }
      : {
          kind: "bytesIntrinsic",
          method: "get",
          receiver: sourceRef(),
          args: [indexRef()],
          type: F64,
          loc,
        };
    const one: IrExpr = { kind: "numLit", value: 1, type: F64, loc };

    L.scopes.push(new Map());
    try {
      const varTarget = exprTarget ?? (decl ? forOfVarTarget(L, decl) : null);
      const value = varTarget
        ? L.declareHiddenLocal("%numiterValue", F64)
        : L.declareLocal(decl!.name as ts.Identifier, (decl!.name as ts.Identifier).text, F64, isLet);
      const valueRef: IrExpr = ref(value.id, F64);
      const blame: ts.Node = decl?.name ?? exprTargetNode ?? stmt.initializer;
      const head: IrStmt[] = [
        {
          kind: "if",
          cond: doneRef(),
          then: [{ kind: "break", loc }],
          else_: null,
          loc,
        },
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: ">=",
            left: indexRef(),
            right: sourceLength(),
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "assign",
              localId: state.doneLocalId,
              value: { kind: "boolLit", value: true, type: BOOL, loc },
              loc,
            },
            { kind: "break", loc },
          ],
          else_: null,
          loc,
        },
        {
          kind: "varDecl",
          localId: value.id,
          init: sourceValue(),
          loc,
        },
        {
          kind: "assign",
          localId: state.indexLocalId,
          value: { kind: "bin", op: "+", left: indexRef(), right: one, type: F64, loc },
          loc,
        },
        ...(varTarget
          ? [
              {
                kind: "assign",
                localId: varTarget.id,
                value: L.coerceInto(blame, valueRef, varTarget.type),
                loc,
              } satisfies IrStmt,
            ]
          : []),
      ];
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return {
        kind: "while",
        cond: { kind: "boolLit", value: true, type: BOOL, loc },
        body: [...head, ...body],
        ...(labels && { labels }),
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

/** A DIRECT `s.matchAll(re)` call: a stdlib matchAll property call on a
   * string-typed receiver with one regex-typed argument (parens stripped).
   * The shape the companion-index machinery serves. */
  export function directMatchAllCallOf(L: Lowerer, e: ts.Expression): ts.CallExpression | null {
    let src = e;
    while (ts.isParenthesizedExpression(src)) src = src.expression;
    if (
      ts.isCallExpression(src) &&
      !src.questionDotToken &&
      src.arguments.length === 1 &&
      ts.isPropertyAccessExpression(src.expression) &&
      !src.expression.questionDotToken &&
      src.expression.name.text === "matchAll" &&
      L.isStdlibMember(src.expression) &&
      L.mapTypeOf(L.typeOf(src.expression.expression))?.kind === "string" &&
      L.mapTypeOf(L.typeOf(src.arguments[0]!))?.kind === "regex"
    ) {
      return src;
    }
    return null;
  }

/** `for (const m of s.matchAll(re))` — the companion-index desugar. The
   * eager drain (matchAllInto) fills the rows AND a number[] of each
   * match's UTF-16 start index in the same scan (a STORED drain arrives
   * with both already materialized — lowerVarStatement's interception);
   * the loop walks the rows by a hidden cursor, snapshotting the cursor
   * into a per-iteration local BEFORE it advances, so `continue` never
   * skips the advance. The body's `m.index` reads idxs[cursor-snapshot]
   * (registered by SYMBOL while the body lowers — shadowing declarations
   * have their own symbols and read normally; the companion is touched
   * only at an actual .index read). `.index` on a drain row is always a
   * number: every row matched, so `m.index ?? 0` folds to the number.
   *
   *   { const %midxs: number[] = []; const %mrows = matchAllInto(s, re, %midxs);
   *     let %miter = 0;
   *     while (%miter < %mrows.length) {
   *       const m = %mrows[%miter]; const %mcur = %miter; %miter += 1;
   *       <body — m.index reads %midxs[%mcur]> } }
   */
  function lowerForOfMatchAll(
    L: Lowerer,
    stmt: ts.ForOfStatement,
    call: ts.CallExpression | null,
    stored: { rows: IrExpr; idxsLocalId: string } | null,
  ): IrStmt {
    const list = stmt.initializer as ts.VariableDeclarationList;
    const decl = list.declarations[0]!;
    const name = decl.name as ts.Identifier;
    const loc = locOf(stmt);
    const rowT = arrayOf(STRING);
    const rowsT = arrayOf(rowT);
    const idxsT = arrayOf(F64);
    // Lower the drain OUTSIDE the loop's scope frame (its receiver/regex
    // belong to the enclosing scope).
    let rowsInit: IrExpr;
    let idxsLocalId: string;
    const prelude: IrStmt[] = [];
    if (call !== null) {
      const access = call.expression as ts.PropertyAccessExpression;
      const receiver = L.lowerExpr(access.expression);
      const re = L.lowerExpr(call.arguments[0]!);
      const idxs = L.declareHiddenLocal("%midxs", idxsT);
      idxsLocalId = idxs.id;
      prelude.push({
        kind: "varDecl",
        localId: idxs.id,
        init: { kind: "arrayLit", elems: [], type: idxsT, loc },
        loc,
      });
      rowsInit = {
        kind: "regexIntrinsic",
        method: "matchAllInto",
        receiver,
        args: [re, { kind: "varRef", localId: idxs.id, type: idxsT, loc }],
        type: rowsT,
        loc,
      };
    } else {
      rowsInit = stored!.rows;
      idxsLocalId = stored!.idxsLocalId;
    }
    L.scopes.push(new Map());
    try {
      const rows = L.declareHiddenLocal("%mrows", rowsT);
      const i = L.declareHiddenLocal("%miter", F64);
      i.mutable = true; // the cursor reassigns (hidden locals default const)
      const m = L.declareLocal(name, name.text, rowT, false);
      const cur = L.declareHiddenLocal("%mcur", F64);
      const iRef = (): IrExpr => ({ kind: "varRef", localId: i.id, type: F64, loc });
      const rowsRef = (): IrExpr => ({ kind: "varRef", localId: rows.id, type: rowsT, loc });
      const head: IrStmt[] = [
        {
          kind: "varDecl",
          localId: m.id,
          init: { kind: "arrayGet", arr: rowsRef(), index: iRef(), type: rowT, loc },
          loc,
        },
        { kind: "varDecl", localId: cur.id, init: iRef(), loc },
        {
          kind: "assign",
          localId: i.id,
          value: { kind: "bin", op: "+", left: iRef(), right: { kind: "numLit", value: 1, type: F64, loc }, type: F64, loc },
          loc,
        },
      ];
      const sym = L.checker.getSymbolAtLocation(name);
      if (sym) L.matchAllIndexBindings.set(sym, { idxsLocalId, curLocalId: cur.id });
      let body: IrStmt[];
      try {
        body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement));
      } finally {
        if (sym) L.matchAllIndexBindings.delete(sym);
      }
      return {
        kind: "block",
        body: [
          ...prelude,
          { kind: "varDecl", localId: rows.id, init: rowsInit, loc },
          { kind: "varDecl", localId: i.id, init: { kind: "numLit", value: 0, type: F64, loc }, loc },
          {
            kind: "while",
            cond: {
              kind: "bin",
              op: "<",
              left: iRef(),
              right: { kind: "arrIntrinsic", method: "length", receiver: rowsRef(), args: [], type: F64, loc },
              type: BOOL,
              loc,
            },
            body: [...head, ...body],
            loc,
          },
        ],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

/** `for (const ch of s)` over a STRING: JS's string iterator, which walks
   * code POINTS — each pass binds the whole character (a two-unit string
   * for astral chars, where charAt/slice would truncate the halves to
   * U+FFFD). Desugars over the UTF-16 cursor machinery: a hidden unit
   * index reads the character with the cpAt intrinsic and advances by ITS
   * length before the body runs (so `continue` never skips the advance):
   *
   *   { const %s = <expr>; let %i = 0;
   *     while (%i < %s.length) { const ch = cpAt(%s, %i); %i += ch.length; <body> } }
   *
   * Strings are immutable, so the length is stable and there is no
   * iterator state to unwind on throw; lone surrogates cannot occur in
   * storage (canonicalized to U+FFFD at creation — the documented
   * divergence), so every step lands on a character start. */
  /** for-of over a CLASS ITERABLE (classIteratorOf's shape) — the
   * iterator protocol as ordinary method calls:
   *
   *   { const %cit = <recv>; const %cii = %cit[Symbol.iterator]();
   *     while (true) {
   *       const %cir = %cii.next();
   *       if (%cir.done) break;          // when a done field exists
   *       const x = %cir.value;
   *       <body>
   *     } }
   *
   * A result record with NO done field never terminates — exactly JS
   * (undefined is falsy forever; Node loops forever too). No
   * IteratorClose: classIteratorOf already refused iterator classes
   * declaring return()/throw(), so a break exits with nothing to close.
   * `done: true` results bind nothing (the loop breaks before the value
   * read), matching JS's ignore-the-final-value rule. */
  function lowerForOfClassIterator(L: Lowerer, stmt: ts.ForOfStatement, iterable: IrExpr,
    cit: ClassIteratorInfo,
    labels?: string[],): IrStmt {
    let exprTarget: { id: string; type: IrType } | null = null;
    let exprTargetNode: ts.Identifier | null = null;
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      // `for (v of new MyStringIterator)` over a PRE-DECLARED identifier:
      // assign the existing binding per pass (the string head's rule).
      let target: ts.Node = stmt.initializer;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isIdentifier(target)) {
        exprTarget = L.resolveWritable(target);
        exprTargetNode = target;
      }
      if (!exprTarget) {
        L.unsupported(
          "SC1090",
          stmt.initializer,
          "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
        );
      }
    }
    const list = ts.isVariableDeclarationList(stmt.initializer) ? stmt.initializer : null;
    if (list && (list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isLet = list !== null && (list.flags & ts.NodeFlags.Let) !== 0;
    const decl = list ? list.declarations[0]! : null;
    if (decl && !ts.isIdentifier(decl.name)) L.unsupported("SC1031", decl.name);
    const loc = locOf(stmt);
    L.scopes.push(new Map());
    try {
      const recv = L.declareHiddenLocal("%cit", iterable.type);
      const it = L.declareHiddenLocal("%cii", cit.iterT);
      const r = L.declareHiddenLocal("%cir", cit.resultT);
      const recvRef: IrExpr = { kind: "varRef", localId: recv.id, type: iterable.type, loc };
      const itRef = (): IrExpr => ({ kind: "varRef", localId: it.id, type: cit.iterT, loc });
      const rRef = (): IrExpr => ({ kind: "varRef", localId: r.id, type: cit.resultT, loc });
      const varTarget = exprTarget ?? (decl ? forOfVarTarget(L, decl) : null);
      const x = varTarget
        ? L.declareHiddenLocal("%vof", cit.valueT)
        : L.declareLocal(decl!.name as ts.Identifier, (decl!.name as ts.Identifier).text, cit.valueT, isLet);
      const xRef: IrExpr = { kind: "varRef", localId: x.id, type: cit.valueT, loc };
      const blame: ts.Node = decl?.name ?? exprTargetNode ?? stmt.initializer;
      const head: IrStmt[] = [
        { kind: "varDecl", localId: r.id, init: L.classIteratorNextCall(cit, itRef(), loc), loc },
        ...(cit.hasDone
          ? [
              {
                kind: "if",
                cond: { kind: "recordGet", obj: rRef(), shapeId: cit.resultT.shapeId, field: "done", type: BOOL, loc },
                then: [{ kind: "break", loc }],
                else_: null,
                loc,
              } satisfies IrStmt,
            ]
          : []),
        {
          kind: "varDecl",
          localId: x.id,
          init: { kind: "recordGet", obj: rRef(), shapeId: cit.resultT.shapeId, field: "value", type: cit.valueT, loc },
          loc,
        },
        ...(varTarget
          ? [{ kind: "assign", localId: varTarget.id, value: L.coerceInto(blame, xRef, varTarget.type), loc } satisfies IrStmt]
          : []),
      ];
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return {
        kind: "block",
        body: [
          { kind: "varDecl", localId: recv.id, init: iterable, loc },
          { kind: "varDecl", localId: it.id, init: L.classIteratorOpenCall(cit, recvRef, loc), loc },
          {
            kind: "while",
            cond: { kind: "boolLit", value: true, type: BOOL, loc },
            body: [...head, ...body],
            ...(labels && { labels }),
            loc,
          },
        ],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

  /** for-of over an ISLAND value (see lowerForOf's jsval arm): the
   * engine's iterator protocol desugared over jsOps —
   *
   *   it = iterNew(v);            // GetIterator (prelude; may throw)
   *   while (true) {
   *     r = it.next();            // callMethod
   *     if (truthy(r.done)) break;
   *     <bind loop var(s) from r.value>  // getProp
   *     ...body
   *   }
   *
   * The loop variable's ELEMENT is an island handle (jsval — exactly what
   * the checker's package-typed element maps to); identifier heads bind
   * it per iteration, destructuring heads run the jsval pattern desugar,
   * pre-declared and var heads keep their fences (the array path's
   * stories don't carry over mechanically). IteratorClose on early exit
   * (break/return out of a partial iteration calling it.return()) is NOT
   * run — a divergence only a custom island iterator with a return()
   * method can observe. */
  /** For-of over a CHECKED-DYNAMIC iterable: the source packs ONCE
   * through the spread walk (dyn.iterPack — dyn arrays element-by-
   * element, strings by code point, bytes by byte; a WRAPPED engine
   * value drains through the ENGINE's own iterator protocol via the
   * iter_drain arm; every other kind throws V8's not-iterable
   * TypeError, the identifier spelling when the head has one), then a
   * hidden index loop binds each element as a dyn value. The pack is an
   * eager SNAPSHOT (the matchAll stance): body mutations of a dyn-array
   * source don't extend the iteration where JS's live array iterator
   * would — documented divergence; engine sources drain through their
   * own protocol, so generators/Maps/Sets step exactly once like Node. */
  function lowerForOfDyn(L: Lowerer, stmt: ts.ForOfStatement, iterable: IrExpr, labels?: string[]): IrStmt {
    const loc = locOf(stmt);
    const head = stmt.expression;
    // V8's for-of CallPrinter spellings: named sources (identifiers and
    // plain property chains) read "<src> is not iterable", call heads
    // with a nameable callee "<callee> is not a function or its return
    // value is not iterable"; everything else keeps the runtime kind
    // wording. The runtime uses the spelling VERBATIM when non-empty.
    const headText = (e: ts.Expression): string | null => {
      if (ts.isIdentifier(e)) return e.text;
      if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.name)) {
        const base = headText(e.expression);
        return base !== null ? `${base}.${e.name.text}` : null;
      }
      return null;
    };
    const headName = headText(head);
    const calleeName = ts.isCallExpression(head) ? headText(head.expression) : null;
    const spell =
      headName !== null
        ? `${headName} is not iterable`
        : calleeName !== null
          ? `${calleeName} is not a function or its return value is not iterable`
          : "";
    const pack = L.declareHiddenLocal("%dofpack", DYN);
    const idx = L.declareHiddenLocal("%dofi", F64);
    idx.mutable = true;
    const packRef = (): IrExpr => ({ kind: "varRef", localId: pack.id, type: DYN, loc });
    const iRef = (): IrExpr => ({ kind: "varRef", localId: idx.id, type: F64, loc });
    const elemInit = (): IrExpr => ({ kind: "libCall", fn: "dyn.arrAt", args: [packRef(), iRef()], type: DYN, loc });
    L.scopes.push(new Map());
    try {
      const binds: IrStmt[] = [];
      if (!ts.isVariableDeclarationList(stmt.initializer)) {
        // Pre-declared heads: identifier targets assign the existing
        // binding once per pass (JS's shared-binding rule); literal
        // patterns run the destructuring-assignment machinery over the
        // dyn element; member targets keep the fence.
        let target: ts.Node = stmt.initializer;
        while (ts.isParenthesizedExpression(target)) target = target.expression;
        const tmp = L.declareHiddenLocal("%vof", DYN);
        binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit(), loc });
        const elemRef: IrExpr = { kind: "varRef", localId: tmp.id, type: DYN, loc };
        if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) {
          binds.push(lowerDestructuringAssign(L, target, elemRef, target, loc));
        } else if (ts.isIdentifier(target) && L.resolveWritable(target)) {
          const writable = L.resolveWritable(target)!;
          binds.push({
            kind: "assign",
            localId: writable.id,
            value: L.coerceInto(target, elemRef, writable.type),
            loc,
          });
        } else {
          L.unsupported(
            "SC1090",
            stmt.initializer,
            "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
          );
        }
      } else {
        const list = stmt.initializer;
        if ((list.flags & ts.NodeFlags.Using) !== 0) {
          L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
        }
        const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.BlockScoped) === 0;
        const decl = list.declarations[0]!;
        if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
          const tmp = L.declareHiddenLocal("%destr", DYN);
          binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit(), loc });
          L.lowerBindingPattern(
            decl.name,
            () => ({ kind: "varRef", localId: tmp.id, type: DYN, loc }),
            DYN,
            isLet,
            binds,
          );
        } else if (ts.isIdentifier(decl.name)) {
          const varTarget = forOfVarTarget(L, decl);
          if (varTarget) {
            // `for (var x of d)`: the element mechanics stay on a hidden
            // per-iteration local; the body opens by assigning the ONE
            // hoisted var binding (the array head's rule).
            const tmp = L.declareHiddenLocal("%vof", DYN);
            binds.push({ kind: "varDecl", localId: tmp.id, init: elemInit(), loc });
            binds.push({
              kind: "assign",
              localId: varTarget.id,
              value: L.coerceInto(decl.name, { kind: "varRef", localId: tmp.id, type: DYN, loc }, varTarget.type),
              loc,
            });
          } else {
            const local = L.declareLocal(decl.name, decl.name.text, DYN, isLet);
            binds.push({ kind: "varDecl", localId: local.id, init: elemInit(), loc });
          }
        } else {
          L.unsupported("SC1031", decl.name);
        }
      }
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return {
        kind: "block",
        body: [
          {
            kind: "varDecl",
            localId: pack.id,
            init: {
              kind: "libCall",
              fn: "dyn.iterPack",
              args: [iterable, { kind: "strLit", value: spell, type: STRING, loc }],
              type: DYN,
              loc,
            },
            loc,
          },
          {
            kind: "for",
            init: { kind: "varDecl", localId: idx.id, init: { kind: "numLit", value: 0, type: F64, loc }, loc },
            cond: {
              kind: "bin",
              op: "<",
              left: iRef(),
              right: { kind: "libCall", fn: "dyn.arrLen", args: [packRef()], type: F64, loc },
              type: BOOL,
              loc,
            },
            update: {
              kind: "assign",
              localId: idx.id,
              value: { kind: "bin", op: "+", left: iRef(), right: { kind: "numLit", value: 1, type: F64, loc }, type: F64, loc },
              loc,
            },
            body: [...binds, ...body],
            ...(labels && { labels }),
            loc,
          },
        ],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

  function lowerForOfIsland(L: Lowerer, stmt: ts.ForOfStatement, iterable: IrExpr, labels?: string[]): IrStmt {
    const loc = locOf(stmt);
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      L.unsupported(
        "SC1090",
        stmt.initializer,
        "for-of over a package ('any') iterable with a pre-declared loop variable (declare it in the loop: for (const x of ...))",
      );
    }
    const list = stmt.initializer;
    if ((list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.BlockScoped) === 0;
    const decl = list.declarations[0]!;
    const itLocal = L.declareHiddenLocal("%vofit", JSVAL);
    const rLocal = L.declareHiddenLocal("%vofr", JSVAL);
    const itRef: IrExpr = { kind: "varRef", localId: itLocal.id, type: JSVAL, loc };
    const rRef: IrExpr = { kind: "varRef", localId: rLocal.id, type: JSVAL, loc };
    const valueOf: IrExpr = { kind: "jsOp", op: "getProp", name: "value", args: [rRef], type: JSVAL, loc };
    L.scopes.push(new Map());
    try {
      const binds: IrStmt[] = [];
      if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
        const tmp = L.declareHiddenLocal("%destr", JSVAL);
        binds.push({ kind: "varDecl", localId: tmp.id, init: valueOf, loc });
        L.lowerBindingPattern(
          decl.name,
          () => ({ kind: "varRef", localId: tmp.id, type: JSVAL, loc }),
          JSVAL,
          isLet,
          binds,
        );
      } else if (ts.isIdentifier(decl.name)) {
        if (forOfVarTarget(L, decl)) {
          L.unsupported("SC1090", decl.name, "for (var x of ...) over a package ('any') iterable (use const or let)");
        }
        const local = L.declareLocal(decl.name, decl.name.text, JSVAL, isLet);
        binds.push({ kind: "varDecl", localId: local.id, init: valueOf, loc });
      } else {
        L.unsupported("SC1031", decl.name);
      }
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return {
        kind: "block",
        body: [
          { kind: "varDecl", localId: itLocal.id, init: { kind: "jsOp", op: "iterNew", args: [iterable], type: JSVAL, loc }, loc },
          {
            kind: "while",
            cond: { kind: "boolLit", value: true, type: BOOL, loc },
            body: [
              { kind: "varDecl", localId: rLocal.id, init: { kind: "jsOp", op: "callMethod", name: "next", args: [itRef], type: JSVAL, loc }, loc },
              {
                kind: "if",
                cond: { kind: "jsOp", op: "truthy", args: [{ kind: "jsOp", op: "getProp", name: "done", args: [rRef], type: JSVAL, loc }], type: BOOL, loc },
                then: [{ kind: "break", loc }],
                else_: null,
                loc,
              },
              ...binds,
              ...body,
            ],
            ...(labels && { labels }),
            loc,
          },
        ],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

  function lowerForOfString(L: Lowerer, stmt: ts.ForOfStatement, iterable: IrExpr, labels?: string[]): IrStmt {
    let exprTarget: { id: string; type: IrType } | null = null;
    let exprTargetNode: ts.Identifier | null = null;
    let exprPattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      // `for (v of "hello")` over a PRE-DECLARED identifier: assign the
      // existing binding per pass (the array head's rule). PATTERN heads
      // (`for ([a] of "xy")`) destructure the per-iteration code point
      // through the string-source assignment lowerings; member targets
      // keep the fence.
      let target: ts.Node = stmt.initializer;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isIdentifier(target)) {
        exprTarget = L.resolveWritable(target);
        exprTargetNode = target;
      } else if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
        exprPattern = target;
      }
      if (!exprTarget && !exprPattern) {
        L.unsupported(
          "SC1090",
          stmt.initializer,
          "for-of over a pre-declared variable (declare the loop variable in the loop: for (const x of ...))",
        );
      }
    }
    const list = ts.isVariableDeclarationList(stmt.initializer) ? stmt.initializer : null;
    if (list && (list.flags & ts.NodeFlags.Using) !== 0) {
      L.unsupported("SC1090", list, "'using' declarations (dispose-at-scope-exit semantics)");
    }
    const isLet = list !== null && (list.flags & ts.NodeFlags.Let) !== 0;
    const decl = list ? list.declarations[0]! : null; // the grammar allows exactly one
    const loc = locOf(stmt);
    L.scopes.push(new Map());
    try {
      const s = L.declareHiddenLocal("%strof", STRING);
      const i = L.declareHiddenLocal("%iterof", F64);
      i.mutable = true; // the unit index reassigns (hidden locals default const)
      const sRef = (): IrExpr => ({ kind: "varRef", localId: s.id, type: STRING, loc });
      const iRef = (): IrExpr => ({ kind: "varRef", localId: i.id, type: F64, loc });
      // `for (var c of str)`: the character mechanics stay on a hidden
      // per-iteration local; the body opens by assigning it into the ONE
      // hoisted var binding (see forOfVarTarget). Pre-declared expression
      // heads assign their existing binding the same way. PATTERN heads
      // (`for (const [half] of "😀x")`) destructure the per-iteration
      // code point through the string-source pattern lowerings — each
      // element is a genuine one-code-point string.
      const declPattern =
        decl !== null && !ts.isIdentifier(decl.name)
          ? (decl.name as ts.ArrayBindingPattern | ts.ObjectBindingPattern)
          : null;
      const varTarget = exprTarget ?? (decl && !declPattern ? forOfVarTarget(L, decl) : null);
      const ch = varTarget || declPattern || exprPattern
        ? L.declareHiddenLocal("%vof", STRING)
        : L.declareLocal(decl!.name as ts.Identifier, (decl!.name as ts.Identifier).text, STRING, isLet);
      const chRef: IrExpr = { kind: "varRef", localId: ch.id, type: STRING, loc };
      const head: IrStmt[] = [
        {
          kind: "varDecl",
          localId: ch.id,
          init: { kind: "strIntrinsic", method: "cpAt", receiver: sRef(), args: [iRef()], type: STRING, loc },
          loc,
        },
        ...(varTarget
          ? [{ kind: "assign", localId: varTarget.id, value: L.coerceInto(decl?.name ?? exprTargetNode!, chRef, varTarget.type), loc } satisfies IrStmt]
          : []),
        {
          kind: "assign",
          localId: i.id,
          value: {
            kind: "bin",
            op: "+",
            left: iRef(),
            right: { kind: "strIntrinsic", method: "length", receiver: chRef, args: [], type: F64, loc },
            type: F64,
            loc,
          },
          loc,
        },
      ];
      if (declPattern) {
        L.lowerBindingPattern(declPattern, () => chRef, STRING, isLet, head);
      }
      if (exprPattern) {
        head.push(lowerDestructuringAssign(L, exprPattern, chRef, exprPattern, loc));
      }
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return {
        kind: "block",
        body: [
          { kind: "varDecl", localId: s.id, init: iterable, loc },
          { kind: "varDecl", localId: i.id, init: { kind: "numLit", value: 0, type: F64, loc }, loc },
          {
            kind: "while",
            cond: {
              kind: "bin",
              op: "<",
              left: iRef(),
              right: { kind: "strIntrinsic", method: "length", receiver: sRef(), args: [], type: F64, loc },
              type: BOOL,
              loc,
            },
            body: [...head, ...body],
            // The labels ride the WHILE (continue re-enters at its
            // condition — the cursor already advanced in head, so a
            // labeled continue never re-reads a character).
            ...(labels && { labels }),
            loc,
          },
        ],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

/** for-in loops. The key set is Node's own-enumerable-keys walk, lowered
   * per receiver kind:
   * - RECORDS (fixed shapes): iteration over exactly the keys Object.keys
   *   answers — the shared interned keys helper (recordKeysArrayCall):
   *   declaration order, fields holding the undefined arm of their union
   *   skipped at runtime (SEMANTICS.md 37's rules verbatim). The key list
   *   snapshots at loop entry, which IS Node's for-in contract for keys
   *   ADDED during the walk (never visited); fixed shapes cannot lose keys
   *   mid-loop (no delete), so the snapshot is exact.
   * - INDEX-SIGNATURE shapes: the same Object.keys hybrid/pure walk
   *   (declared fields first, then the overflow in JS own-key order —
   *   objectIterOverIndexShape's "keys" arm, same intern key). Adds during
   *   the loop are correctly NOT visited (the snapshot); PURE shapes —
   *   the one record kind where `delete obj[k]` is lowered — additionally
   *   guard every visit with a live presence test, Node's HasProperty
   *   re-check, so keys deleted before their turn are skipped exactly
   *   like Node.
   * - ARRAYS: Node's canonical ascending index strings. The key set
   *   snapshots at entry (pushes during the body are NOT visited — V8's
   *   own-keys snapshot, verified against Node) while each visit re-checks
   *   presence (i < live length), so pops during the body skip exactly
   *   like Node. Sparse arrays cannot exist here (hole creation traps).
   * - globalThis: the harness's leaked-globals sweep — a compiled binary's
   *   global bindings are compile-time names, never enumerable runtime
   *   properties, so the enumeration is honestly EMPTY (zero iterations;
   *   the body typechecked but never evaluates — SEMANTICS.md documents
   *   the divergence).
   * - class instances fence: which keys exist on one depends on runtime
   *   property creation (unset declared fields, useDefineForClassFields)
   *   that the struct model does not track — named, not guessed.
   * Bindings mirror for-of's: const/let declare the per-iteration string
   * local, `var` assigns the hoisted shared slot, a pre-declared
   * identifier target assigns per pass; destructuring heads are tsc
   * errors. */
  export function lowerForIn(L: Lowerer, stmt: ts.ForInStatement): IrStmt {
    const labels = L.takeLabels();
    const loc = locOf(stmt);
    if (stdlibGlobalNameOf(L, stmt.expression) === "globalThis") {
      return { kind: "block", body: [], loc };
    }
    const recvT = L.mapTypeOf(L.typeOf(stmt.expression));
    if (recvT?.kind === "array") return lowerForInArray(L, stmt, labels);
    if (recvT?.kind === "record") {
      const shape = L.shapes.get(recvT.shapeId);
      if (shape && !shape.tuple) {
        const receiver = L.lowerExpr(stmt.expression);
        if (receiver.type.kind !== "record") L.badType(stmt.expression, L.typeOf(stmt.expression));
        const rShape = L.shapes.get(receiver.type.shapeId);
        if (!rShape) throw new Error(`lowerer bug: unknown shape ${receiver.type.shapeId}`);
        // Accessor-carrying shapes: Node's for-in visits the accessor
        // NAMES (own enumerable properties) — the static key walk omits
        // them (accessor slots live outside declaredOrder), so the loop
        // fences rather than silently skip keys.
        if (shapeHasAccessorSlots(rShape)) {
          L.unsupported(
            "SC1090",
            stmt.expression,
            "for-in over a shape carrying get/set accessor properties (Node visits the accessor names — the static key walk cannot; read the properties explicitly)",
          );
        }
        const keysT: IrType & { kind: "array" } = { kind: "array", elem: STRING };
        if (rShape.indexValue && rShape.fields.length === 0) {
          // PURE index-signature shape — the one record kind whose keys
          // can DISAPPEAR mid-walk (`delete obj[k]` is lowered for it):
          // bind the receiver once and guard every visit with live
          // presence, Node's HasProperty re-check (a key deleted before
          // its turn is skipped; the snapshot still bounds adds).
          const recv = L.declareHiddenLocal("%inrec", receiver.type);
          const shapeId = receiver.type.shapeId;
          const recvRef = (): IrExpr => ({ kind: "varRef", localId: recv.id, type: receiver.type, loc });
          const keys = objectIterOverIndexShape(L, stmt.expression, "keys", receiver.type, rShape, recvRef(), keysT, loc);
          const guard = (kRef: IrExpr): IrExpr => ({
            kind: "arrIntrinsic",
            method: "includes",
            receiver: { kind: "recordOvfKeys", obj: recvRef(), shapeId, type: keysT, loc },
            args: [kRef],
            type: BOOL,
            loc,
          });
          const loop = lowerForInOverKeys(L, stmt, keys, labels, guard);
          return {
            kind: "block",
            body: [{ kind: "varDecl", localId: recv.id, init: receiver, loc }, loop],
            loc,
          };
        }
        // Fixed and hybrid shapes cannot lose keys mid-walk (no delete;
        // an undefined-arm write agrees with the snapshot under the
        // SEMANTICS.md 37 stance), so the snapshot alone is exact.
        const keys = rShape.indexValue
          ? objectIterOverIndexShape(L, stmt.expression, "keys", receiver.type, rShape, receiver, keysT, loc)
          : recordKeysArrayCall(L, receiver, receiver.type, rShape, loc);
        return lowerForInOverKeys(L, stmt, keys, labels);
      }
      L.unsupported(
        "SC1052",
        stmt.expression,
        "for-in over tuples (the positions are fixed — a for loop over indices reads them)",
      );
    }
    if (recvT?.kind === "object") {
      L.unsupported(
        "SC1052",
        stmt.expression,
        "for-in over class instances (which keys exist on an instance depends on runtime property creation the class model does not track — for-in over records and arrays compiles)",
      );
    }
    L.unsupported(
      "SC1052",
      stmt.expression,
      `for-in over '${L.checker.typeToString(L.typeOf(stmt.expression))}' receivers (records, index-signature shapes, arrays, and globalThis enumerate)`,
    );
  }

/** The record arms' shared tail: a for-of over the snapshotted keys array
   * with for-in's binding forms. `guard` (pure index shapes) wraps each
   * visit — writes to shared bindings and the body itself — in a live
   * presence test, so a skipped key never assigns the binding either
   * (Node: the loop variable only ever holds VISITED keys). */
  function lowerForInOverKeys(
    L: Lowerer,
    stmt: ts.ForInStatement,
    keys: IrExpr,
    labels: string[] | undefined,
    guard?: (kRef: IrExpr) => IrExpr,
  ): IrStmt {
    const loc = locOf(stmt);
    const visit = (keyLocalId: string, writes: IrStmt[], body: IrStmt[]): IrStmt[] => {
      if (!guard) return [...writes, ...body];
      const kRef: IrExpr = { kind: "varRef", localId: keyLocalId, type: STRING, loc };
      return [{ kind: "if", cond: guard(kRef), then: [...writes, ...body], else_: null, loc }];
    };
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      // `for (k in obj)` over a PRE-DECLARED writable binding: one shared
      // binding assigned once per pass, exactly for-of's rule.
      let target: ts.Node = stmt.initializer;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isIdentifier(target)) {
        const writable = L.resolveWritable(target);
        if (writable) {
          const tmp = L.declareHiddenLocal("%kin", STRING);
          const write: IrStmt = {
            kind: "assign",
            localId: writable.id,
            value: L.coerceInto(target, { kind: "varRef", localId: tmp.id, type: STRING, loc }, writable.type),
            loc,
          };
          const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
          return { kind: "forOf", localId: tmp.id, iterable: keys, body: visit(tmp.id, [write], body), ...(labels && { labels }), loc };
        }
      }
      L.unsupported(
        "SC1090",
        stmt.initializer,
        "for-in over this assignment target (declare the key in the head — for (const k in obj) — or assign a plain declared variable)",
      );
    }
    const list = stmt.initializer;
    const decl = list.declarations[0]!; // the grammar allows exactly one
    if (!ts.isIdentifier(decl.name)) L.unsupported("SC1031", decl.name);
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.BlockScoped) === 0;
    L.scopes.push(new Map());
    try {
      // `for (var k in obj)`: the key lands in a hidden per-iteration
      // local and the body opens by assigning the one hoisted binding.
      const varTarget = forOfVarTarget(L, decl);
      if (varTarget) {
        const tmp = L.declareHiddenLocal("%kin", STRING);
        const write: IrStmt = {
          kind: "assign",
          localId: varTarget.id,
          value: L.coerceInto(decl.name, { kind: "varRef", localId: tmp.id, type: STRING, loc }, varTarget.type),
          loc,
        };
        const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
        return { kind: "forOf", localId: tmp.id, iterable: keys, body: visit(tmp.id, [write], body), ...(labels && { labels }), loc };
      }
      const local = L.declareLocal(decl.name, decl.name.text, STRING, isLet);
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return { kind: "forOf", localId: local.id, iterable: keys, body: visit(local.id, [], body), ...(labels && { labels }), loc };
    } finally {
      L.scopes.pop();
    }
  }

/** for-in over an ARRAY: Node's canonical ascending index strings.
   *
   *   { const %inarr = <expr>; const %inlen = %inarr.length;
   *     for (let %ini = 0; %ini < %inlen; %ini += 1) {
   *       if (%ini < %inarr.length) { const k = String(%ini); <body> } } }
   *
   * The length SNAPSHOT bounds the walk (keys added during the body are
   * not visited — V8's own-keys snapshot, verified against Node) and the
   * live-length guard is the per-visit presence check (keys removed by
   * pops are skipped, exactly Node's HasProperty re-check; indices are
   * dense, so `i < length` IS presence). */
  function lowerForInArray(L: Lowerer, stmt: ts.ForInStatement, labels: string[] | undefined): IrStmt {
    const loc = locOf(stmt);
    const arrExpr = L.lowerExpr(stmt.expression);
    if (arrExpr.type.kind !== "array") L.badType(stmt.expression, L.typeOf(stmt.expression));
    L.scopes.push(new Map());
    try {
      const arr = L.declareHiddenLocal("%inarr", arrExpr.type);
      const len = L.declareHiddenLocal("%inlen", F64);
      const i = L.declareHiddenLocal("%ini", F64);
      i.mutable = true;
      const arrRef = (): IrExpr => ({ kind: "varRef", localId: arr.id, type: arrExpr.type, loc });
      const iRef = (): IrExpr => ({ kind: "varRef", localId: i.id, type: F64, loc });
      const liveLen = (): IrExpr => ({
        kind: "arrIntrinsic",
        method: "length",
        receiver: arrRef(),
        args: [],
        type: F64,
        loc,
      });
      const keyInit: IrExpr = { kind: "toString", operand: iRef(), type: STRING, loc };

      // The three binding forms, sharing the per-visit key declaration.
      let keyDecl: IrStmt;
      let writes: IrStmt[] = [];
      if (!ts.isVariableDeclarationList(stmt.initializer)) {
        let target: ts.Node = stmt.initializer;
        while (ts.isParenthesizedExpression(target)) target = target.expression;
        const writable = ts.isIdentifier(target) ? L.resolveWritable(target) : null;
        if (!writable) {
          L.unsupported(
            "SC1090",
            stmt.initializer,
            "for-in over this assignment target (declare the key in the head — for (const k in arr) — or assign a plain declared variable)",
          );
        }
        const tmp = L.declareHiddenLocal("%kin", STRING);
        keyDecl = { kind: "varDecl", localId: tmp.id, init: keyInit, loc };
        writes = [
          {
            kind: "assign",
            localId: writable.id,
            value: L.coerceInto(target as ts.Expression, { kind: "varRef", localId: tmp.id, type: STRING, loc }, writable.type),
            loc,
          },
        ];
      } else {
        const decl = stmt.initializer.declarations[0]!;
        if (!ts.isIdentifier(decl.name)) L.unsupported("SC1031", decl.name);
        const isLet =
          (stmt.initializer.flags & ts.NodeFlags.Let) !== 0 ||
          (stmt.initializer.flags & ts.NodeFlags.BlockScoped) === 0;
        const varTarget = forOfVarTarget(L, decl);
        if (varTarget) {
          const tmp = L.declareHiddenLocal("%kin", STRING);
          keyDecl = { kind: "varDecl", localId: tmp.id, init: keyInit, loc };
          writes = [
            {
              kind: "assign",
              localId: varTarget.id,
              value: L.coerceInto(decl.name, { kind: "varRef", localId: tmp.id, type: STRING, loc }, varTarget.type),
              loc,
            },
          ];
        } else {
          const local = L.declareLocal(decl.name, decl.name.text, STRING, isLet);
          keyDecl = { kind: "varDecl", localId: local.id, init: keyInit, loc };
        }
      }

      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return {
        kind: "block",
        body: [
          { kind: "varDecl", localId: arr.id, init: arrExpr, loc },
          { kind: "varDecl", localId: len.id, init: liveLen(), loc },
          {
            kind: "for",
            init: { kind: "varDecl", localId: i.id, init: { kind: "numLit", value: 0, type: F64, loc }, loc },
            cond: {
              kind: "bin",
              op: "<",
              left: iRef(),
              right: { kind: "varRef", localId: len.id, type: F64, loc },
              type: BOOL,
              loc,
            },
            update: {
              kind: "assign",
              localId: i.id,
              value: { kind: "bin", op: "+", left: iRef(), right: { kind: "numLit", value: 1, type: F64, loc }, type: F64, loc },
              loc,
            },
            body: [
              {
                kind: "if",
                cond: { kind: "bin", op: "<", left: iRef(), right: liveLen(), type: BOOL, loc },
                then: [keyDecl, ...writes, ...body],
                else_: null,
                loc,
              },
            ],
            ...(labels && { labels }),
            loc,
          },
        ],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

/** `for await (const chunk of process.stdin)` — the ONE lowered async
   * iteration: piped stdin, chunk by chunk. Desugars to a while-true
   * whose every pass awaits the runtime's next-chunk promise (the loop
   * fulfills it when fd 0 delivers) and exits on the EMPTY sentinel — a
   * POSIX read never yields an empty data chunk, so EOF is the only way
   * to see one. Awaiting parks the fiber like any await, so timers and
   * other fibers interleave with the reads exactly as in Node; the loop
   * variable is a fresh const Uint8Array binding per iteration. Async
   * function bodies and async module initializers can host it (the await
   * parks their fiber). */
  function lowerForAwaitStdin(L: Lowerer, stmt: ts.ForOfStatement): IrStmt {
    if (!L.ctx.isAsync) {
      L.unsupported("SC1090", stmt, "top-level 'for await' (await outside async functions)");
    }
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      L.unsupported(
        "SC1090",
        stmt.initializer,
        "for-await over a pre-declared variable (declare the loop variable in the loop: for await (const chunk of ...))",
      );
    }
    const list = stmt.initializer;
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
    // `for await (var chunk of ...)`: the chunk binding is per-await
    // machinery (a fresh value each pass, fiber-parked in between) —
    // threading it through a shared hoisted slot has no user yet.
    if (!isConst && !isLet) L.unsupported("SC1030", list, "'var' loop bindings in 'for await' (use const)");
    const decl = list.declarations[0]!; // the grammar allows exactly one
    if (!ts.isIdentifier(decl.name)) L.unsupported("SC1031", decl.name);
    const loc = locOf(stmt);
    const promiseT: IrType = { kind: "promise", inner: BYTES_U8 };
    L.scopes.push(new Map());
    try {
      const p = L.declareHiddenLocal("%stdinNext", promiseT);
      const chunk = L.declareLocal(decl.name, decl.name.text, BYTES_U8, isLet);
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement));
      const chunkRef: IrExpr = { kind: "varRef", localId: chunk.id, type: BYTES_U8, loc };
      const head: IrStmt[] = [
        {
          kind: "varDecl",
          localId: p.id,
          init: { kind: "libCall", fn: "stdin.nextChunk", args: [], type: promiseT, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: chunk.id,
          init: {
            kind: "awaitExpr",
            value: { kind: "varRef", localId: p.id, type: promiseT, loc },
            type: BYTES_U8,
            loc,
          },
          loc,
        },
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "===",
            left: { kind: "bytesIntrinsic", method: "length", receiver: chunkRef, args: [], type: F64, loc },
            right: { kind: "numLit", value: 0, type: F64, loc },
            type: BOOL,
            loc,
          },
          then: [{ kind: "break", loc }],
          else_: null,
          loc,
        },
      ];
      return {
        kind: "while",
        cond: { kind: "boolLit", value: true, type: BOOL, loc },
        body: [...head, ...body],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

/** `for await (const chunk of readable)` — the stream async iterator
   * (the stdin desugar's sibling): every pass awaits the runtime's
   * next-chunk promise — buffered content, or a REJECTION carrying the
   * stream's error (the await rethrows it, Node's iterator contract) —
   * and exits on the EOF sentinel. Chunks are Buffers in typed code
   * (encoded streams fence at the runtime entry); in the JS lane the
   * chunk is checked-dynamic and boxes by runtime tag (dyn strings once
   * an encoding applies, dyn undefined as the sentinel — chunks are
   * never undefined). Early exit leaves the stream alive (Node's
   * iterator return() would destroy it — a documented divergence). */
  function lowerForAwaitReadable(L: Lowerer, stmt: ts.ForOfStatement, recvT: IrType & { kind: "object" }): IrStmt {
    if (!L.ctx.isAsync) {
      L.unsupported("SC1090", stmt, "top-level 'for await' (await outside async functions)");
    }
    if (!ts.isVariableDeclarationList(stmt.initializer)) {
      L.unsupported(
        "SC1090",
        stmt.initializer,
        "for-await over a pre-declared variable (declare the loop variable in the loop: for await (const chunk of ...))",
      );
    }
    const list = stmt.initializer;
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
    // `for await (var chunk of ...)`: the chunk binding is per-await
    // machinery (a fresh value each pass, fiber-parked in between) —
    // threading it through a shared hoisted slot has no user yet.
    if (!isConst && !isLet) L.unsupported("SC1030", list, "'var' loop bindings in 'for await' (use const)");
    const decl = list.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) L.unsupported("SC1031", decl.name);
    const loc = locOf(stmt);
    // The chunk is CHECKED-DYNAMIC in both lanes (the shim types the
    // iterator's element as any): the runtime boxes by tag — Buffers
    // normally, strings once an encoding applies — and the dyn surface
    // carries the common consumptions (.length, [i], toString, +=,
    // typeof). A statically-typed chunk would have to pick one side of
    // the encoding question at compile time.
    const dynLane = true;
    const chunkT: IrType = DYN;
    const promiseT: IrType = { kind: "promise", inner: chunkT };
    L.scopes.push(new Map());
    try {
      // The receiver evaluates ONCE, before the loop.
      const recvLocal = L.declareHiddenLocal("%faStream", recvT);
      const recvDecl: IrStmt = {
        kind: "varDecl",
        localId: recvLocal.id,
        init: L.lowerExpr(stmt.expression),
        loc,
      };
      const p = L.declareHiddenLocal("%streamNext", promiseT);
      const chunk = L.declareLocal(decl.name, decl.name.text, chunkT, isLet);
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement));
      const chunkRef: IrExpr = { kind: "varRef", localId: chunk.id, type: chunkT, loc };
      const eofCond: IrExpr = dynLane
        ? { kind: "dynTest", test: "undefined", value: chunkRef, type: BOOL, loc }
        : {
            kind: "bin",
            op: "===",
            left: { kind: "bytesIntrinsic", method: "length", receiver: chunkRef, args: [], type: F64, loc },
            right: { kind: "numLit", value: 0, type: F64, loc },
            type: BOOL,
            loc,
          };
      const head: IrStmt[] = [
        {
          kind: "varDecl",
          localId: p.id,
          init: {
            kind: "libCall",
            fn: dynLane ? "readable.nextChunkDyn" : "readable.nextChunk",
            args: [{ kind: "varRef", localId: recvLocal.id, type: recvT, loc }],
            type: promiseT,
            loc,
          },
          loc,
        },
        {
          kind: "varDecl",
          localId: chunk.id,
          init: {
            kind: "awaitExpr",
            value: { kind: "varRef", localId: p.id, type: promiseT, loc },
            type: chunkT,
            loc,
          },
          loc,
        },
        { kind: "if", cond: eofCond, then: [{ kind: "break", loc }], else_: null, loc },
      ];
      return {
        kind: "block",
        body: [
          recvDecl,
          {
            kind: "while",
            cond: { kind: "boolLit", value: true, type: BOOL, loc },
            body: [...head, ...body],
            loc,
          },
        ],
        loc,
      };
    } finally {
      L.scopes.pop();
    }
  }

export function lowerForStatement(L: Lowerer, stmt: ts.ForStatement): IrStmt {
    const labels = L.takeLabels();
    L.scopes.push(new Map());
    try {
      let init: IrStmt | null = null;
      if (stmt.initializer) {
        if (ts.isVariableDeclarationList(stmt.initializer)) {
          init = L.lowerVarDeclList(stmt.initializer);
        } else if (!ts.isMissingDeclaration(stmt.initializer)) {
          // (MissingDeclaration is 7's error-recovery node — a preflight-
          // clean program never carries one.)
          init = L.lowerExprStatement(stmt.initializer);
        }
      }
      const cond = stmt.condition ? L.lowerCondition(stmt.condition) : null;
      const update = stmt.incrementor ? L.lowerExprStatement(stmt.incrementor) : null;
      const body = L.inCtl("loop", () => L.lowerScopedBlock(stmt.statement), labels);
      return { kind: "for", init, cond, update, body, ...(labels && { labels }), loc: locOf(stmt) };
    } finally {
      L.scopes.pop();
    }
  }
