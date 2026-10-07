import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isJsSourceFile } from "../program.js";
import { dynFallbackType } from "./lowerer.js";

/** True when nothing in `sym`'s DECLARING FILE ever writes it after the
 * initializer: assignments (plain and compound, destructuring targets
 * included), ++/--, and for-of/for-in expression targets all count.
 * Sound file-locally for module-scope bindings because ESM import
 * bindings are read-only — no other file can write one. Cached per
 * symbol (the scan walks the whole file once). */
export function bindingNeverReassigned(lowerer: Lowerer, sym: ts.Symbol, decl: ts.Node): boolean {
  const cached = lowerer.neverReassignedCache.get(sym);
  if (cached !== undefined) return cached;
  let written = false;
  // Text pre-check keeps the file walk cheap: only same-named
  // identifiers pay a symbol resolution.
  const symText = sym.name;
  const namesSym = (e: ts.Node): boolean =>
    ts.isIdentifier(e) && e.text === symText && lowerer.resolveValueSymbol(e) === sym;
  const scanTarget = (t: ts.Expression): void => {
    let e: ts.Expression = t;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (namesSym(e)) {
      written = true;
      return;
    }
    // Destructuring assignment targets: any identifier inside the LHS
    // pattern could be the binding — over-approximate by scanning.
    if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) {
      const walk = (n: ts.Node): void => {
        if (namesSym(n)) written = true;
        else n.forEachChild(walk);
      };
      walk(e);
    }
  };
  const visit = (n: ts.Node): void => {
    if (written) return;
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
        scanTarget(n.left);
      }
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      scanTarget(n.operand as ts.Expression);
    } else if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer)
    ) {
      scanTarget(n.initializer as ts.Expression);
    }
    n.forEachChild(visit);
  };
  decl.getSourceFile().forEachChild(visit);
  lowerer.neverReassignedCache.set(sym, !written);
  return !written;
}

/** Strips the value-preserving wrappers off an expression: parens,
 * non-null assertions, `as`/`satisfies`/angle-bracket casts. What
 * remains is the expression that actually evaluates. */
export function stripValueWrappers(e: ts.Expression): ts.Expression {
  let v: ts.Expression = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(v) ||
      ts.isNonNullExpression(v) ||
      ts.isAsExpression(v) ||
      ts.isSatisfiesExpression(v) ||
      ts.isTypeAssertion(v)
    ) {
      v = v.expression;
      continue;
    }
    return v;
  }
}

/** The nullish unit `e` provably evaluates to: a bare null/undefined
 * literal (assertion-wrapped — `null as any`, `null!`), or a read of a
 * registered NULLISH binding (nullishGenericBindingUnitOf). Null when
 * the value could be anything else. */
export function nullishExprUnitOf(lowerer: Lowerer, e: ts.Expression): "null" | "undefined" | null {
  const v = stripValueWrappers(e);
  if (v.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isIdentifier(v)) {
    if (v.text === "undefined" && (lowerer.typeOf(v).flags & ts.TypeFlags.Undefined) !== 0) {
      return "undefined";
    }
    return nullishValueUnitOf(lowerer, lowerer.resolveValueSymbol(v));
  }
  return null;
}

/** The nullish unit a binding provably holds FOREVER, by VALUE alone: its
 * initializer is nullish (`const i: I<A & B> = null as any`) and every
 * write in its declaring file is nullish too (`a = b` where b is
 * another nullish binding). No type condition — callers add their own
 * (nullishGenericBindingUnitOf gates the no-storage family on
 * unmappable types; the generic-method call path rescues its fence with
 * the value fact alone). Cached per symbol; the pre-seeded null entry
 * guards probe cycles (mutually-assigned bindings resolve link by link,
 * declaration order). */
export function nullishValueUnitOf(
  lowerer: Lowerer,
  sym: ts.Symbol | null,
): "null" | "undefined" | null {
  if (!sym) return null;
  const cached = lowerer.nullishBindings.get(sym);
  if (cached !== undefined) return cached;
  lowerer.nullishBindings.set(sym, null); // cycle guard: self-referential probes answer non-qualifying
  const decl = lowerer.checker.valueDeclarationOf(sym);
  // Statement-position declarators only: a for-loop head (`for (let x =
  // null as any; ...)`) declares a LOCAL with per-iteration semantics —
  // lowerVarDeclList's contract requires a lowered statement for it, so
  // the no-storage family never claims it.
  if (
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    !ts.isIdentifier(decl.name) ||
    decl.getSourceFile().isDeclarationFile ||
    decl.initializer === undefined ||
    !ts.isVariableStatement(decl.parent?.parent)
  ) {
    return null;
  }
  const unit = nullishExprUnitOf(lowerer, decl.initializer);
  if (unit === null) return null;
  // Bindings with a CHECKED-DYNAMIC fallback (`const maybe: any =
  // undefined`, JS inference residue) keep that story: the dyn world
  // already holds null/undefined correctly and serves every read form
  // (optional chains included) — this family exists for types with NO
  // other home.
  if (dynFallbackType(lowerer, decl.name, lowerer.checker.getTypeOfSymbol(sym)) !== null)
    return null;
  if (!allWritesNullish(lowerer, sym, decl)) return null;
  // A use inside a class HERITAGE clause (`class X extends Mixin(...)`)
  // declines the whole family: heritage resolution is structural (the
  // mixin machinery can pin the instantiation from the ARGUMENT class
  // expression without ever reading the callee binding), so a claimed
  // nullish callee would compile a working class where Node throws
  // "Mixin is not a function" evaluating the extends expression. The
  // declaration keeps its type fence instead.
  if (usedInHeritageClause(lowerer, sym)) return null;
  lowerer.nullishBindings.set(sym, unit);
  return unit;
}

/** True when any identifier resolving to `sym` sits inside a class
 * heritage clause anywhere in the program. */
function usedInHeritageClause(lowerer: Lowerer, sym: ts.Symbol): boolean {
  const symText = sym.name;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === symText && lowerer.resolveValueSymbol(n) === sym) {
      for (
        let p: ts.Node | undefined = n.parent;
        p !== undefined && !ts.isSourceFile(p);
        p = p.parent
      ) {
        if (ts.isHeritageClause(p)) {
          found = true;
          return;
        }
      }
      return;
    }
    n.forEachChild(visit);
  };
  for (const file of lowerer.program.getImplementationSourceFiles()) {
    if (found) break;
    if (file.isDeclarationFile) continue;
    file.forEachChild(visit);
  }
  return found;
}

/** nullishValueUnitOf gated on a declared type that CANNOT hold the
 * value — the NO-STORAGE family: an unmappable type has no other story,
 * and a RECORD-mapped one (`const i: I<A & B> = null as any` — an
 * interface whose members are all generic signatures interns an empty
 * shape) has a slot null can never inhabit, so storing would throw the
 * representation error where Node stores null silently. Either way the
 * declaration emits nothing and reads know the value. Null-tolerant
 * mappings (unions with a null/undefined arm, dyn) keep their real
 * storage and every ordinary lowering. */
export function nullishGenericBindingUnitOf(
  lowerer: Lowerer,
  sym: ts.Symbol | null,
): "null" | "undefined" | null {
  if (!sym) return null;
  // The VALUE probe first — it is purely syntactic, so no checker type
  // query runs for the overwhelmingly common non-nullish declarations
  // (a query can even panic upstream — the 1e999 checker bug).
  const unit = nullishValueUnitOf(lowerer, sym);
  if (unit === null) return null;
  const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(sym));
  if (mapped !== null) {
    // Only the EMPTY interned shape qualifies among record mappings —
    // the all-generic-signature interface (`I<A & B>`) whose struct has
    // no slot at all. A record with DATA fields (`const value: { inner:
    // number | string } = null as any`) keeps its real storage and
    // every ordinary lowering: its reads flow through positions (comma
    // chains, call arguments) the no-storage read paths never claim,
    // so claiming the binding would fence working programs.
    if (mapped.kind !== "record") return null;
    const shape = lowerer.shapes.get(mapped.shapeId);
    if (
      !shape ||
      shape.fields.length > 0 ||
      shape.tuple !== undefined ||
      shape.indexValue !== undefined
    ) {
      return null;
    }
  }
  return unit;
}

/** True when every write of `sym` in its declaring file is a plain `x =
 * <nullish>` assignment — the discipline that keeps a nullish binding's
 * value knowable. Compound assignments, ++/--, for-in/of cursors, and
 * destructuring targets all disqualify. */
function allWritesNullish(lowerer: Lowerer, sym: ts.Symbol, decl: ts.Node): boolean {
  const symText = sym.name;
  const namesSym = (e: ts.Node): boolean =>
    ts.isIdentifier(e) && e.text === symText && lowerer.resolveValueSymbol(e) === sym;
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok) return;
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
        let lhs: ts.Expression = n.left;
        while (ts.isParenthesizedExpression(lhs)) lhs = lhs.expression;
        if (namesSym(lhs)) {
          if (k !== ts.SyntaxKind.EqualsToken || nullishExprUnitOf(lowerer, n.right) === null)
            ok = false;
        } else if (ts.isArrayLiteralExpression(lhs) || ts.isObjectLiteralExpression(lhs)) {
          const walk = (m: ts.Node): void => {
            if (namesSym(m)) ok = false;
            else m.forEachChild(walk);
          };
          walk(lhs);
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      let op: ts.Expression = n.operand as ts.Expression;
      while (ts.isParenthesizedExpression(op)) op = op.expression;
      if (namesSym(op)) ok = false;
    } else if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer)
    ) {
      let t: ts.Node = n.initializer;
      while (ts.isParenthesizedExpression(t as ts.Expression))
        t = (t as ts.ParenthesizedExpression).expression;
      if (namesSym(t)) ok = false;
    }
    n.forEachChild(visit);
  };
  decl.getSourceFile().forEachChild(visit);
  return ok;
}

/** A VALUE-ONLY expression: materializing it has no observable effect
 * beyond the value itself — function/arrow literals, class-free
 * literals, nullish units. The dead-binding rule's purity test: Node
 * builds the value and drops it, so skipping the build entirely is
 * unobservable. Bare identifier reads stay OUT (a read above a `let`
 * declaration is a TDZ throw Node WOULD serve). */
function sideEffectFreeValueExpr(lowerer: Lowerer, e: ts.Expression): boolean {
  const v = stripValueWrappers(e);
  if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) return true;
  if (
    ts.isLiteralExpression(v) ||
    v.kind === ts.SyntaxKind.NullKeyword ||
    v.kind === ts.SyntaxKind.TrueKeyword ||
    v.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (
    ts.isIdentifier(v) &&
    v.text === "undefined" &&
    (lowerer.typeOf(v).flags & ts.TypeFlags.Undefined) !== 0
  ) {
    return true;
  }
  return false;
}

/** True when `sym` — a binding whose type has NO static mapping — is DEAD:
 * never read anywhere in the program, not exported through a specifier,
 * declared with no initializer or a side-effect-free one, and written
 * (if at all) only by plain assignments of side-effect-free values. Node
 * materializes those values and drops them — zero observable effect —
 * so the declaration and its writes lower to NOTHING instead of fencing
 * on a type the program never consumes (`var xs2: typeof Array;`, the
 * write-only `var f2: { <T, U>(x: T, y: U): T }`). TS program files
 * only: JS bindings keep their checked-dynamic fallbacks. Positive
 * answers register in lowerer.deadBindings (the assignment lowering skips
 * writes by the same set). */
export function deadUnmappableBinding(
  lowerer: Lowerer,
  sym: ts.Symbol | null,
  decl: ts.VariableDeclaration,
): boolean {
  if (!sym) return false;
  if (lowerer.deadBindings.has(sym)) return true;
  if (!ts.isIdentifier(decl.name)) return false;
  // Statement-position declarators only: a for-loop head (`for (let x;
  // false;) {}`) declares a LOCAL with per-iteration semantics —
  // lowerVarDeclList's contract requires a lowered statement for it, so
  // the no-storage family never claims it (catch bindings sit outside a
  // variable statement too and stay out the same way).
  if (!ts.isVariableStatement(decl.parent?.parent)) return false;
  const sf = decl.getSourceFile();
  if (sf.isDeclarationFile || isJsSourceFile(sf)) return false;
  if (decl.initializer !== undefined && !sideEffectFreeValueExpr(lowerer, decl.initializer))
    return false;
  // Exported bindings stay out: a library build's exports are consumed
  // from outside the graph, and export specifiers double as reads.
  if (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) return false;
  // The type gate LAST among the cheap checks: querying the checker for
  // a type is the expensive step (and can panic upstream — the 1e999
  // bug), so only survivors of the syntactic filters pay it. Mappable
  // types keep their real storage.
  if (lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(sym)) !== null) return false;
  const symText = sym.name;
  const namesSym = (e: ts.Node): boolean =>
    ts.isIdentifier(e) && e.text === symText && lowerer.resolveValueSymbol(e) === sym;
  let dead = true;
  const visit = (n: ts.Node): void => {
    if (!dead) return;
    if (ts.isIdentifier(n) && n.text === symText) {
      // Declaration-name occurrences are not reads.
      if (n.parent !== undefined && ts.isVariableDeclaration(n.parent) && n.parent.name === n) {
        n.forEachChild(visit);
        return;
      }
      // A plain-assignment LHS is a WRITE — dead only when the RHS
      // builds no observable effect (the value is dropped with the
      // binding).
      const p = n.parent;
      if (
        p !== undefined &&
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        p.left === n
      ) {
        if (!namesSym(n)) return;
        if (!sideEffectFreeValueExpr(lowerer, p.right)) dead = false;
        return;
      }
      // Import/export specifiers, and every other occurrence, count as
      // reads.
      if (namesSym(n)) dead = false;
      return;
    }
    n.forEachChild(visit);
  };
  for (const file of lowerer.program.getImplementationSourceFiles()) {
    if (!dead) break;
    if (file.isDeclarationFile) continue;
    file.forEachChild(visit);
  }
  if (dead) lowerer.deadBindings.add(sym);
  return dead;
}
