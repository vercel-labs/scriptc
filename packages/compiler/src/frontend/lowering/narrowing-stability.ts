import * as ts from "../ts7/adapter.js";
import { withoutParentheses, withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { heritageElementTarget } from "../heritage-elements.js";
import { InternalCompilerError } from "../../errors.js";
import { typeEquals } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { isValueIdentifier } from "./binding-analysis.js";

/** Whether TypeScript's control-flow narrowing of a mutable reference still
 * holds when the narrowed read executes.
 *
 * TypeScript narrows property references (`o.p`, `this.a.b`) and bindings
 * after assignments and tests, and keeps that narrowing across calls: a
 * callback, method or getter that clears or replaces the property (or a
 * closure that reassigns the binding) leaves the reference typed by its old
 * value. Lowering bridges a narrowed union read with a payload extraction
 * that traps on the wrong arm and folds `?.`, truthiness and `typeof` by the
 * narrowed type, so such a read would abort or fold to the old value instead
 * of throwing the catchable TypeError. This analysis decides when
 * the narrowing is provably current:
 *
 * - every property in the reference is construction-only (no store to its
 *   name anywhere in the program except `this.name = ...` directly in a
 *   constructor body, no accessor of that name, no reflective or computed
 *   store into class instances) and the root binding is never assigned
 *   from another function; or
 * - nothing between the earliest occurrence of the same reference in the
 *   use's function and the use can run other code or store the property
 *   through another reference: no call or construction (except standard
 *   library operations that cannot call back), tagged template, `await`,
 *   `yield`, user accessor, user iteration or user conversion hook, and no
 *   store to a property of the same name through a different reference.
 *   A loop around the use that starts inside that span contributes its
 *   whole body, since its back edge reaches the use again.
 *
 * A binding initialized or assigned from a read whose narrowing may be
 * stale inherits that narrowing (`const held: Expr = current` keeps the arm
 * `current` was typed with), so its narrowed reads are never trusted.
 *
 * TypeScript never carries a property narrowing into a nested function,
 * and every narrowing (an assignment, test, predicate or assertion of the
 * reference) is an occurrence of the reference, so a narrowed use always
 * has one earlier in its own function. Spurious occurrences only move the
 * span start earlier, which keeps the answer conservative. */
export class NarrowingStability {
  private files: readonly ts.SourceFile[] | null = null;
  private programFacts: ProgramFacts | null = null;
  private readonly facts = new Map<ts.Node, FunctionFacts>();
  private readonly verdicts = new Map<ts.Node, boolean>();
  private readonly effects = new Map<ts.Node, boolean>();
  private readonly capturedMutable = new Map<ts.Symbol, boolean>();
  private readonly staleBindings = new Map<ts.Symbol, boolean>();
  private readonly inherited = new Map<ts.Symbol, ts.Type | null>();
  private readonly writes = new Map<ts.Symbol, BindingWrite[] | null>();
  /** Bindings whose writes or inherited type are being computed, and how
   * often a computation asked for one of them: an answer that depends on
   * itself (`copy = keep ? copy : undefined`) is not an answer, so
   * nothing derived from it is kept and the write counts as stale. */
  private readonly resolving = new Set<ts.Symbol>();
  private selfReferences = 0;
  private readonly identifierWrites = new Map<ts.SourceFile, Map<string, ts.Identifier[]>>();
  private readonly widened = new Map<ts.Node, ts.Type | null>();
  private readonly plainContainers = new Map<ts.Node, boolean>();

  constructor(private readonly lowerer: Lowerer) {}

  setFiles(files: readonly ts.SourceFile[]): void {
    this.files = files;
    this.programFacts = null;
  }

  /** The declared type a narrowed read in an absence or type test (or in a
   * slot that accepts that declared type) must observe instead of the
   * checker's stale narrowing, or null to keep the checker's type. */
  widenedType(node: ts.Node): ts.Type | null {
    if (!ts.isPropertyAccessExpression(node) && !ts.isIdentifier(node)) return null;
    // Program-level queries before the program's files are split concern
    // declarations, never narrowed reads in function bodies.
    if (this.files === null) return null;
    const cached = this.widened.get(node);
    if (cached !== undefined) return cached;
    const position = widePosition(node);
    const selfReferences = this.selfReferences;
    let result: ts.Type | null = null;
    try {
      result = this.computeWidened(node, position);
    } finally {
      if (this.selfReferences === selfReferences) this.widened.set(node, result);
    }
    return result;
  }

  /** A read whose value `expression` can evaluate to (the expression
   * itself, an arm of a conditional, an operand of `&&`, `||`, `??`, the
   * right side of a comma or an assignment), that the checker types as
   * nothing but `undefined` or `null` and widenedType restored to its
   * declared type; or null. The checker computed the type of the whole
   * expression, and of a function that returns it, from that narrowing, so
   * a lowering that discards a value because its type is `undefined`
   * consults this first. */
  restoredNothingRead(expression: ts.Expression): ts.Expression | null {
    if (this.files === null) return null;
    const e = withoutParenthesesTypeWrappers(expression);
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      return this.widenedType(e) !== null && isNothing(this.lowerer.checker.getTypeAtLocation(e))
        ? e
        : null;
    }
    if (ts.isConditionalExpression(e))
      return this.restoredNothingRead(e.whenTrue) ?? this.restoredNothingRead(e.whenFalse);
    if (ts.isBinaryExpression(e)) {
      switch (e.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
          return this.restoredNothingRead(e.left) ?? this.restoredNothingRead(e.right);
        case ts.SyntaxKind.CommaToken:
        case ts.SyntaxKind.EqualsToken:
          return this.restoredNothingRead(e.right);
      }
    }
    return null;
  }

  /** Whether `expression` can evaluate to the right operand of an `&&`
   * whose left operand can be a read restoredNothingRead answers for: the
   * checker typed that `&&` by its left operand alone. */
  private restoredAndAnswers(expression: ts.Expression): boolean {
    const e = withoutParenthesesTypeWrappers(expression);
    if (ts.isConditionalExpression(e))
      return this.restoredAndAnswers(e.whenTrue) || this.restoredAndAnswers(e.whenFalse);
    if (!ts.isBinaryExpression(e)) return false;
    switch (e.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return this.restoredNothingRead(e.left) !== null || this.restoredAndAnswers(e.right);
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return this.restoredAndAnswers(e.left) || this.restoredAndAnswers(e.right);
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return this.restoredAndAnswers(e.right);
    }
    return false;
  }

  /** The checker narrows this reference below its declared type, and the
   * narrowing may be stale at runtime: its read must check the stored
   * value instead of trusting the narrowed type. */
  untrusted(node: ts.Node, narrowed: IrType): boolean {
    // Explicit assertions (`x!`, `x as T`) are the program's own claim and
    // keep their established stance; only flow narrowing is in question.
    if (this.files === null) return false;
    if (ts.isPropertyAccessExpression(node)) {
      const declared = this.declaredPropertyType(node);
      if (declared === null) return false;
      const declaredIr = this.lowerer.mapTypeOf(declared);
      if (declaredIr === null || typeEquals(declaredIr, narrowed)) return false;
      return !this.trusted(node);
    }
    if (ts.isIdentifier(node)) {
      const symbol = this.bindingOf(node);
      if (!symbol || !this.mayHoldStaleNarrowing(symbol)) return false;
      return !this.trusted(node);
    }
    return false;
  }

  private bindingOf(node: ts.Identifier): ts.Symbol | null {
    const symbol = this.lowerer.resolveValueSymbol(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      return this.lowerer.checker.getAliasedSymbol(symbol);
    return symbol;
  }

  private computeWidened(
    node: ts.PropertyAccessExpression | ts.Identifier,
    position: WidePosition | null,
  ): ts.Type | null {
    const checker = this.lowerer.checker;
    // A narrowing to nothing but `undefined` or `null` is restored in every
    // position, so every read reaches the declared-type lookup; the other
    // narrowings only in the positions that can take the declared type.
    if (position === null && !this.mayReadNothing(node)) return null;
    let declared: ts.Type | null;
    if (ts.isPropertyAccessExpression(node)) {
      declared = this.declaredPropertyType(node);
    } else {
      const symbol = this.bindingOf(node);
      // `let y = x` with `x` such a read: the checker inferred the binding's
      // own type from the narrowing, so `y` is nothing to it as well, and it
      // holds what `x` held.
      if (symbol && isNothing(checker.getTypeAtLocation(node))) {
        // Every assignment of the binding's own that can reach this read
        // stores that nothing (`y = undefined; return y`): it ends what an
        // earlier initializer or assignment left in the binding, and the
        // checker's type is right.
        if (this.holdsNothingAt(node, symbol)) return null;
        if (isNothing(checker.getTypeOfSymbol(symbol))) return this.inheritedType(symbol);
      }
      declared =
        symbol && this.mayHoldStaleNarrowing(symbol) ? checker.getTypeOfSymbol(symbol) : null;
    }
    if (declared === null) return null;
    const narrowedTs = checker.getTypeAtLocation(node);
    if (narrowedTs === declared) return null;
    // A narrowing to nothing but `undefined` or `null` has no payload a
    // checked read could validate: a lowering that takes the checker's word
    // drops the read and continues with "absent" (`text.slice(start)` with
    // `start` assigned by a callback slices from 0). When that narrowing may
    // be stale the read has its declared type wherever it stands, so its
    // consumer lowers for the value that is stored. The declared type of a
    // binding the checker types by flow alone (`var re;`, which is
    // `undefined` to it until the read's own function assigns it) is `any`,
    // as the checker itself answers for a read from a nested function
    // (`var re; compile(); scan(re)` passes the expression `compile` stored).
    if (isNothing(narrowedTs)) return this.trusted(node) ? null : declared;
    if (position === null) return null;
    const declaredIr = this.lowerer.mapTypeOf(declared);
    const narrowedIr = this.lowerer.mapTypeOf(narrowedTs);
    if (declaredIr === null || narrowedIr === null || typeEquals(declaredIr, narrowedIr))
      return null;
    // A union narrowed to some of its arms, or a class narrowed to a
    // subclass by instanceof (whose members dispatch on the instance).
    const classNarrowing = declaredIr.kind === "object" && narrowedIr.kind === "object";
    if (declaredIr.kind !== "union" && !classNarrowing) return null;
    if (position === "member") {
      // A member the declared type itself supports (every arm has it, so
      // no arm is nullish) reads the current value's member, as Node does.
      // Calls dispatch only through a single class.
      const member = memberUse(node);
      if (member === null || (member.call && !classNarrowing)) return null;
      if (!checker.getPropertyOfType(declared, member.access.name.text)) return null;
    } else if (position === "chain") {
      if (classNarrowing) return null;
      // A chain body is lowered for the checker's present receiver type:
      // only a narrowing that removed nothing but null/undefined can be
      // restored to the guarded declared receiver.
      const present = this.lowerer.mapTypeOf(checker.getNonNullableType(declared));
      if (present === null || !typeEquals(present, narrowedIr)) return null;
    } else if (position === "context") {
      if (!this.argumentSlotIsGeneric(node)) return null;
      const contextual = checker.getContextualType(node);
      if (contextual === undefined) return null;
      if (
        !(contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
        !checker.isTypeAssignableTo(declared, contextual)
      ) {
        // A slot that takes the declared type minus null/undefined after an
        // absence test (`if (acc !== null) return acc`): the checker's
        // narrowing can also hold an arm an assignment chose before the
        // call that stored another one. Restore every present arm, the way
        // a binding narrowed only by the test reads.
        if (classNarrowing) return null;
        const present = checker.getNonNullableType(declared);
        if (
          present === declared ||
          !checker.isTypeAssignableTo(narrowedTs, present) ||
          !checker.isTypeAssignableTo(present, contextual)
        )
          return null;
        return this.trusted(node) ? null : present;
      }
    }
    return this.trusted(node) ? null : declared;
  }

  /** Whether the checker types this read as nothing but `undefined` or
   * `null`. Asked for every identifier and property read outside the wide
   * positions; the type is the one `Lowerer.typeOf` asks for next, from
   * the checker's per-node memo. */
  private mayReadNothing(node: ts.PropertyAccessExpression | ts.Identifier): boolean {
    if (ts.isIdentifier(node) && !isValueIdentifier(node)) return false;
    return isNothing(this.lowerer.checker.getTypeAtLocation(node));
  }

  /** The type an untyped binding holds when the checker inferred "nothing"
   * for it from reads widenedType restored: the declared type of those
   * reads (`let y = x` after a call that may have assigned `x`), `any`
   * when they disagree. Null when no such read initializes or assigns it. */
  private inheritedType(symbol: ts.Symbol): ts.Type | null {
    const cached = this.inherited.get(symbol);
    if (cached !== undefined) return cached;
    if (this.resolving.has(symbol)) {
      this.selfReferences++;
      return null;
    }
    const selfReferences = this.selfReferences;
    const writes = this.writesOf(symbol);
    this.resolving.add(symbol);
    let result: ts.Type | null = null;
    try {
      const decl = symbol.valueDeclaration;
      if (decl !== undefined && ts.isVariableDeclaration(decl) && decl.type === undefined) {
        for (const write of writes ?? []) {
          if (write.value === null) continue;
          const read = this.restoredNothingRead(write.value);
          const restored = read === null ? null : this.widenedType(read);
          if (restored === null) continue;
          // `read && other` stores `other` once the read holds a value, and
          // the checker, to which the read is nothing, never looked at what
          // `other` is: the binding holds more than the read's declared type.
          const held = this.restoredAndAnswers(write.value)
            ? this.lowerer.checker.getAnyType()
            : restored;
          result = result === null || result === held ? held : this.lowerer.checker.getAnyType();
        }
      }
    } finally {
      this.resolving.delete(symbol);
      if (this.selfReferences === selfReferences) this.inherited.set(symbol, result);
    }
    return result;
  }

  /** Every write of a variable declared by one plain declaration
   * statement: the declaration (`value` is its initializer; a `let`
   * without one stores `undefined`, a `var` without one is no write: it
   * holds `undefined` from the function's entry), each `=` assignment
   * (`value` is its
   * right side), and every other write (destructuring, `+=`, `++`, a
   * `for...of` target), whose stored value is unknown. `stale` says the
   * value can be a read whose narrowing may be stale. Null for any other
   * binding (a parameter, a pattern or loop declaration, a redeclared
   * `var`): its writes are not all in view. */
  private writesOf(symbol: ts.Symbol): BindingWrite[] | null {
    const cached = this.writes.get(symbol);
    if (cached !== undefined) return cached;
    if (this.resolving.has(symbol)) {
      this.selfReferences++;
      return null;
    }
    this.resolving.add(symbol);
    let result: BindingWrite[] | null = null;
    try {
      const decl = symbol.valueDeclaration;
      const list = decl?.parent;
      if (
        decl !== undefined &&
        ts.isVariableDeclaration(decl) &&
        ts.isIdentifier(decl.name) &&
        (symbol.declarations?.length ?? 1) === 1 &&
        list !== undefined &&
        ts.isVariableDeclarationList(list) &&
        list.parent !== undefined &&
        ts.isVariableStatement(list.parent)
      ) {
        const found: BindingWrite[] = [];
        // A value whose judgement asked for this binding's own writes
        // (it reads the binding, directly or through another copy) is
        // taken to be stale.
        const stale = (value: ts.Expression): boolean => {
          const selfReferences = this.selfReferences;
          const found = this.mayBeStale(value) || this.restoredNothingRead(value) !== null;
          return found || this.selfReferences !== selfReferences;
        };
        // A `var` binding is initialized to `undefined` when the function is
        // entered, not when its declaration statement runs: a declaration
        // without a value stores nothing there, and a loop around it does
        // not reset the binding on later iterations. A block-scoped
        // declaration does initialize its binding each time it runs.
        const blockScoped = (list.flags & ts.NodeFlags.BlockScoped) !== 0;
        if (decl.initializer !== undefined)
          found.push({
            at: decl,
            value: decl.initializer,
            kind: "assigned",
            stale: stale(decl.initializer),
          });
        else if (blockScoped) found.push({ at: decl, value: null, kind: "declared", stale: false });
        for (const write of this.writesIn(ts.getSourceFileOfNode(decl)).get(
          ts.symbolName(symbol),
        ) ?? []) {
          if (this.lowerer.resolveValueSymbol(write) !== symbol) continue;
          const assignment = write.parent;
          if (
            ts.isBinaryExpression(assignment) &&
            assignment.left === write &&
            assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
          )
            found.push({
              at: assignment,
              value: assignment.right,
              kind: "assigned",
              stale: stale(assignment.right),
            });
          else found.push({ at: write, value: null, kind: "unknown", stale: true });
        }
        result = found;
      }
    } finally {
      this.resolving.delete(symbol);
      this.writes.set(symbol, result);
    }
    return result;
  }

  /** Whether the binding certainly holds, at `read`, the nothing the
   * checker types the read as: every write that can reach the read along
   * the function's control flow stores that nothing, spelled as such
   * (`undefined`, `null`, `void e`, or a declaration without a value). A
   * forward pass over the statements on the way to the read
   * with one fact, "the binding may hold something else". A statement
   * that is the declaration or an assignment of the binding sets the fact
   * from what it stores; a block passes it through its statements; an
   * `if` joins its arms; everything else (a loop, `try`, `switch`, a
   * label, a short-circuit or conditional expression, a write inside a
   * larger expression) can only raise the fact, by any write in it that
   * does not store that nothing, wherever in it the write stands. So a
   * reset is believed only where it runs on every path, and where the
   * pass cannot tell, the read is of the stored value. */
  private holdsNothingAt(read: ts.Identifier, symbol: ts.Symbol): boolean {
    // Another function's assignment is not on this function's paths.
    if (this.isCapturedMutable(symbol)) return false;
    const writes = this.writesOf(symbol);
    // Only a write that is stale or unknown gives the binding something
    // the checker does not see; without one its type stands as it is.
    if (writes === null || !writes.some((write) => write.stale)) return false;
    const decl = symbol.valueDeclaration!;
    const boundary = flowBoundary(read);
    if (flowBoundary(decl) !== boundary) return false;
    const checker = this.lowerer.checker;
    const expected = nothingFlags(checker.getTypeAtLocation(read));
    const undefinedFlag = ts.TypeFlags.Undefined;
    // A write after which the binding holds the nothing the checker
    // expects at the read. A JavaScript binding whose inferred type is
    // `undefined` keeps that type after `y = null` or `y = "text"`, which
    // the checker does not report there: those do not count.
    // A `var` is hoisted: it holds `undefined` from the function's entry,
    // and its declaration without a value is no write (writesOf). A `let`
    // without a value is a fresh `undefined` each time it runs.
    const list = decl.parent;
    const hoisted =
      list !== undefined &&
      ts.isVariableDeclarationList(list) &&
      (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0;
    const holdsUndefined = (undefinedFlag & ~expected) === 0;
    const settles = (write: BindingWrite): boolean => {
      if (write.kind === "declared") return holdsUndefined;
      if (write.kind === "unknown" || write.stale || write.value === null) return false;
      // Only a value that is nothing by its own spelling: any other
      // expression the checker types as nothing (a call, a conditional, a
      // read of another binding) may carry a value its type was inferred
      // without, the copy's own included (`y = keep ? y : undefined`,
      // `y = same(y)`).
      if (!spellsNothing(write.value)) return false;
      const spelled = withoutParenthesesTypeWrappers(write.value);
      if (ts.isIdentifier(spelled)) {
        // `undefined` the global, not a binding of the program's.
        const declaration = checker.getSymbolAtLocation(spelled)?.valueDeclaration;
        if (declaration !== undefined && !ts.getSourceFileOfNode(declaration).isDeclarationFile)
          return false;
      }
      const stored = checker.getTypeAtLocation(write.value);
      return isNothing(stored) && (nothingFlags(stored) & ~expected) === 0;
    };
    const inside = (node: ts.Node, write: BindingWrite): boolean => contains(node, write.at);
    const writesIn = (node: ts.Node): boolean => writes.some((write) => inside(node, write));
    const raises = (node: ts.Node): boolean =>
      writes.some((write) => inside(node, write) && !settles(write));
    /** The write a statement is, when it is exactly the declaration or an
     * assignment of the binding and nothing else writes it. */
    const writeOf = (statement: ts.Node): BindingWrite | null => {
      let own: BindingWrite | null = null;
      for (const write of writes) {
        if (!inside(statement, write)) continue;
        if (own !== null) return null;
        own = write;
      }
      if (own === null || own.kind === "unknown") return null;
      if (ts.isVariableStatement(statement))
        return own.at.parent?.parent === statement ? own : null;
      if (ts.isExpressionStatement(statement))
        return withoutParentheses(statement.expression) === own.at ? own : null;
      return null;
    };
    /** The fact after `statement` completes, from the fact before it. */
    const after = (statement: ts.Node, may: boolean): boolean => {
      if (!writesIn(statement)) return may;
      if (ts.isBlock(statement)) {
        for (const inner of statement.statements.nodes) may = after(inner, may);
        return may;
      }
      const own = writeOf(statement);
      if (own !== null) return !settles(own);
      if (ts.isIfStatement(statement)) {
        const entered = may || raises(statement.expression);
        const then = after(statement.thenStatement, entered);
        const otherwise =
          statement.elseStatement === undefined ? entered : after(statement.elseStatement, entered);
        return then || otherwise;
      }
      return may || raises(statement);
    };
    /** The fact where `read` is evaluated, from the fact on entry to
     * `node`, which contains the read. */
    const before = (node: ts.Node, may: boolean): boolean => {
      if (ts.isBlock(node) || ts.isSourceFile(node)) {
        for (const inner of node.statements.nodes) {
          if (contains(inner, read)) return before(inner, may);
          may = after(inner, may);
        }
        return true;
      }
      if (ts.isIfStatement(node)) {
        const entered = may || raises(node.expression);
        if (contains(node.thenStatement, read)) return before(node.thenStatement, entered);
        if (node.elseStatement !== undefined && contains(node.elseStatement, read))
          return before(node.elseStatement, entered);
        return may || raises(node);
      }
      // Any other construct: whatever it can store reaches the read (a
      // loop's later iteration, a `catch` entered from anywhere in its
      // `try`, an operand evaluated before or after), and nothing in it
      // is believed to settle the binding except inside a block of it
      // that holds the read.
      const entered = may || raises(node);
      let inner: ts.Node | undefined;
      ts.forEachChild(node, (child) => {
        if (inner === undefined && contains(child, read)) inner = child;
        return undefined;
      });
      if (inner === undefined || !(ts.isBlock(inner) || ts.isStatement(inner))) return entered;
      return before(inner, entered);
    };
    const body = ts.isSourceFile(boundary)
      ? boundary
      : ts.isFunctionLike(boundary)
        ? (boundary as ts.FunctionLikeDeclaration).body
        : undefined;
    if (body === undefined || !contains(body, read)) return false;
    // On entry a hoisted binding holds `undefined`; a block-scoped one is
    // not readable before its declaration and is taken to hold anything.
    return !before(body, hoisted ? !holdsUndefined : true);
  }

  /** A read in a call or construction argument (directly or inside a literal
   * argument) reaches the callee's own lowering with the declared type. User
   * callees coerce any value of their parameter type, and so do the
   * standard library's generic slots: a parameter typed by a type parameter
   * (`push(...items: T[])`, `Map.set(key: K, value: V)`) and the console
   * methods, which format any value. Other standard-library lowerings are
   * specialized to the argument types programs pass and can refuse the
   * declared union (`JSON.stringify` of a possibly-undefined value,
   * `clearInterval` of a nullable handle). Those arguments keep the checker's
   * narrowing, and maybeNarrow reads them through the checked extraction. */
  private argumentSlotIsGeneric(node: ts.Expression): boolean {
    const slot = enclosingArgument(node);
    if (slot === null) return true;
    const { call, argument } = slot;
    const checker = this.lowerer.checker;
    const signature = checker.getResolvedSignature(call);
    const declaration = signature ? signature.declaration : undefined;
    if (!declaration || !this.lowerer.isStdlibFile(ts.getSourceFileOfNode(declaration)))
      return true;
    const callee = withoutParenthesesTypeWrappers(call.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      this.lowerer.isStdlibGlobal(withoutParenthesesTypeWrappers(callee.expression), "console")
    )
      return true;
    const index = call.arguments?.nodes.indexOf(argument) ?? -1;
    const params = declaration.parameters?.nodes ?? [];
    if (index < 0 || params.length === 0) return false;
    const param = params[Math.min(index, params.length - 1)]!;
    if (index >= params.length && param.dotDotDotToken === undefined) return false;
    return param.type !== undefined && this.mentionsTypeParameter(param.type);
  }

  private mentionsTypeParameter(node: ts.Node): boolean {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const symbol = this.lowerer.checker.getSymbolAtLocation(node.typeName);
      if (symbol && symbol.flags & ts.SymbolFlags.TypeParameter) return true;
    }
    return (
      ts.forEachChild(node, (child) => this.mentionsTypeParameter(child) || undefined) ?? false
    );
  }

  /** The type of the accessed property as declared on the receiver's
   * (instantiated) type, before any flow narrowing of this reference. */
  private declaredPropertyType(node: ts.PropertyAccessExpression): ts.Type | null {
    const checker = this.lowerer.checker;
    const receiver = checker.getTypeAtLocation(node.expression);
    const property =
      checker.getPropertyOfType(receiver, node.name.text) ?? checker.getSymbolAtLocation(node.name);
    if (!property) return null;
    return checker.getTypeOfSymbol(property);
  }

  private trusted(node: ts.Expression): boolean {
    const cached = this.verdicts.get(node);
    if (cached !== undefined) return cached;
    const verdict = this.computeTrusted(node);
    this.verdicts.set(node, verdict);
    return verdict;
  }

  private computeTrusted(node: ts.Expression): boolean {
    const chain = referenceChain(node);
    if (chain === null) return true;
    const program = this.program();
    // A getter answers a fresh value on every read: neither its own result
    // nor anything read through it keeps a narrowing.
    for (const link of chain.links) {
      if (!program.accessors.has(link.name)) continue;
      const symbol = this.lowerer.checker.getSymbolAtLocation(
        ts.isPropertyAccessExpression(link.node) ? link.node.name : link.node,
      );
      if (
        !symbol ||
        (symbol.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0
      )
        return false;
    }
    if (ts.isIdentifier(chain.root)) {
      const root = this.bindingOf(chain.root);
      if (root !== null && this.inheritsStaleNarrowing(root)) return false;
    }
    const rootStable =
      chain.root.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isIdentifier(chain.root) && !this.rootCapturedMutable(chain.root));
    if (
      rootStable &&
      chain.links.length > 0 &&
      chain.links.every((link) => this.constructionOnly(link.name))
    )
      return true;
    if (chain.links.length === 0 && rootStable) return true;
    return this.currentSinceNarrowing(node, chain);
  }

  /** The root binding can change between the narrowing and the use, or
   * names a namespace whose exported bindings are assigned as variables
   * (invisible to the member-store census). */
  private rootCapturedMutable(root: ts.Identifier): boolean {
    const symbol = this.bindingOf(root);
    if (symbol === null) return true;
    if (symbol.flags & (ts.SymbolFlags.Module | ts.SymbolFlags.Enum)) return true;
    return this.isCapturedMutable(symbol);
  }

  /** No intervening code between the reference's earliest occurrence in
   * the use's function and the use can change it. */
  private currentSinceNarrowing(node: ts.Expression, chain: ReferenceChain): boolean {
    const boundary = flowBoundary(node);
    const facts = this.functionFacts(boundary);
    const last = chain.links[chain.links.length - 1];
    const refKey = last ? `.${last.name}` : (chain.root as ts.Identifier).text;
    const candidates = facts.refs.get(refKey) ?? [];
    const useStart = ts.tokenStartOfNode(node);
    let start = -1;
    for (const candidate of candidates) {
      if (candidate === node) continue;
      const candidateStart = ts.tokenStartOfNode(candidate);
      if (candidateStart >= useStart) break;
      if (referenceKey(candidate) !== chain.key) continue;
      start = candidateStart;
      // An assignment narrows once it completes: code its right side runs
      // happens before the stored value exists.
      const parent = candidate.parent;
      if (
        ts.isBinaryExpression(parent) &&
        parent.left === candidate &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.end <= useStart
      )
        start = parent.end;
      break;
    }
    if (start < 0) return false;
    // A loop around the use that starts after the narrowing reaches the
    // use again through its back edge: its whole body (and header) runs in
    // between.
    let end = useStart;
    for (const loop of facts.loops) {
      const loopStart = ts.tokenStartOfNode(loop);
      if (loopStart >= start && loopStart <= useStart && loop.end >= node.end)
        end = Math.max(end, loop.end);
    }
    // Effects and stores are ordered by where they take effect (a call
    // after its arguments, a store after its right side). Code enclosing
    // the use takes effect after it unless a loop brings the use around.
    for (const { node: effect } of between(facts.effects, start, end)) {
      if (this.isEffect(effect)) return false;
    }
    if (chain.links.length === 0) return true;
    const names = new Set(chain.links.map((link) => link.name));
    for (const { node: write } of between(facts.writes, start, end)) {
      const name = accessName(write);
      if (name === null) {
        if (!this.isPlainContainerWrite(write)) return false;
        continue;
      }
      if (!names.has(name)) continue;
      const key = referenceKey(write);
      // A store through the same reference (or a prefix of it) is a flow
      // assignment the checker already accounts for.
      if (key !== null && (key === chain.key || chain.key.startsWith(`${key}.`))) continue;
      return false;
    }
    return true;
  }

  private isPlainContainerWrite(write: ts.Expression): boolean {
    if (!ts.isElementAccessExpression(write)) return false;
    const cached = this.plainContainers.get(write);
    if (cached !== undefined) return cached;
    const checker = this.lowerer.checker;
    const type = checker.getTypeAtLocation(write.expression);
    const plain = isPlainContainerType(checker, type);
    this.plainContainers.set(write, plain);
    return plain;
  }

  private constructionOnly(name: string): boolean {
    const program = this.program();
    return !program.wildcard && !program.mutable.has(name) && !program.accessors.has(name);
  }

  /** A binding whose narrowed reads may observe a narrowing that no longer
   * holds: another function assigns it, or it inherits a stale narrowing. */
  private mayHoldStaleNarrowing(symbol: ts.Symbol): boolean {
    return this.isCapturedMutable(symbol) || this.inheritsStaleNarrowing(symbol);
  }

  /** The binding is initialized or assigned from a narrowed read that may be
   * stale, so TypeScript's narrowing of the binding may be stale too. */
  private inheritsStaleNarrowing(symbol: ts.Symbol): boolean {
    const cached = this.staleBindings.get(symbol);
    if (cached !== undefined) return cached;
    // A cycle of bindings assigned from each other contributes nothing.
    this.staleBindings.set(symbol, false);
    let result = false;
    try {
      const decl = symbol.valueDeclaration;
      if (decl !== undefined && ts.isVariableDeclaration(decl)) {
        if (decl.initializer !== undefined && this.mayBeStale(decl.initializer)) result = true;
        else {
          for (const write of this.writesIn(ts.getSourceFileOfNode(decl)).get(
            ts.symbolName(symbol),
          ) ?? []) {
            const assignment = write.parent;
            if (
              ts.isBinaryExpression(assignment) &&
              assignment.left === write &&
              assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              this.lowerer.resolveValueSymbol(write) === symbol &&
              this.mayBeStale(assignment.right)
            ) {
              result = true;
              break;
            }
          }
        }
      }
    } finally {
      this.staleBindings.set(symbol, result);
    }
    return result;
  }

  /** A reference TypeScript narrows below its declared type where the
   * narrowing may no longer hold. */
  private mayBeStale(expression: ts.Expression): boolean {
    let e = expression;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
    const checker = this.lowerer.checker;
    let declared: ts.Type | null;
    if (ts.isPropertyAccessExpression(e)) declared = this.declaredPropertyType(e);
    else {
      const symbol = this.bindingOf(e);
      declared = symbol === null ? null : checker.getTypeOfSymbol(symbol);
    }
    if (declared === null || checker.getTypeAtLocation(e) === declared) return false;
    return !this.trusted(e);
  }

  /** A `let`/`var`/parameter binding assigned from a function other than
   * the one that declares it: any call may change it. */
  private isCapturedMutable(symbol: ts.Symbol): boolean {
    const cached = this.capturedMutable.get(symbol);
    if (cached !== undefined) return cached;
    let result = false;
    try {
      const decl = symbol.valueDeclaration;
      const mutableBinding =
        decl !== undefined &&
        ((ts.isVariableDeclaration(decl) &&
          ts.isVariableDeclarationList(decl.parent) &&
          (decl.parent.flags & ts.NodeFlags.Const) === 0) ||
          ts.isParameter(decl));
      if (decl && mutableBinding) {
        const home = flowBoundary(decl);
        const writes = this.writesIn(ts.getSourceFileOfNode(decl)).get(ts.symbolName(symbol)) ?? [];
        for (const write of writes) {
          if (flowBoundary(write) === home) continue;
          if (this.lowerer.resolveValueSymbol(write) === symbol) {
            result = true;
            break;
          }
        }
      }
    } finally {
      this.capturedMutable.set(symbol, result);
    }
    return result;
  }

  private writesIn(file: ts.SourceFile): Map<string, ts.Identifier[]> {
    let writes = this.identifierWrites.get(file);
    if (writes) return writes;
    const found = new Map<string, ts.Identifier[]>();
    writes = found;
    this.identifierWrites.set(file, found);
    // A declaration file holds no code that runs, so none of its writes
    // happen. Its bindings (`console`, `JSON`) are read in most programs,
    // and the walk would read every node of the file.
    if (file.isDeclarationFile) return writes;
    const add = (target: ts.Node): void => {
      forEachWriteTarget(target, (t) => {
        if (!ts.isIdentifier(t)) return;
        let list = found.get(t.text);
        if (!list) found.set(t.text, (list = []));
        list.push(t);
      });
    };
    ts.walkPreorder(file, (node) => {
      const target = writeTargetOf(node);
      if (target) add(target);
    });
    return writes;
  }

  private program(): ProgramFacts {
    if (this.programFacts) return this.programFacts;
    if (this.files === null) {
      throw new InternalCompilerError("narrowing stability queried before the program files");
    }
    const facts: ProgramFacts = {
      mutable: new Set(),
      accessors: new Set(),
      wildcard: false,
      conversion: false,
      iteration: false,
    };
    this.programFacts = facts;
    for (const file of this.files) {
      if (file.isDeclarationFile) continue;
      ts.walkPreorder(file, (node) => {
        if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
          const name = memberName(node.name);
          if (name !== null) facts.accessors.add(name);
          else facts.wildcard = true;
        }
        if (
          ts.isMethodDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isGetAccessorDeclaration(node)
        ) {
          const name = memberName(node.name);
          if (name === "toString" || name === "valueOf" || name === "toJSON")
            facts.conversion = true;
          if (ts.isComputedPropertyName(node.name)) {
            const text = ts.getTextOfNode(node.name.expression);
            if (text.includes("toPrimitive")) facts.conversion = true;
            if (text.includes("iterator") || text.includes("asyncIterator")) facts.iteration = true;
          }
        }
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isMethodDeclaration(node)) &&
          node.asteriskToken
        ) {
          facts.iteration = true;
        }
        if (ts.isCallExpression(node) && reflectiveStore(node)) facts.wildcard = true;
        const target = writeTargetOf(node);
        if (target) {
          forEachWriteTarget(target, (t) => {
            if (ts.isIdentifier(t)) return;
            const name = accessName(t);
            if (name === null) {
              if (!this.isPlainContainerWrite(t)) facts.wildcard = true;
              return;
            }
            if (isConstructorThisStore(t)) return;
            facts.mutable.add(name);
          });
        }
      });
    }
    return facts;
  }

  private functionFacts(boundary: ts.Node): FunctionFacts {
    let facts = this.facts.get(boundary);
    if (facts) return facts;
    const program = this.program();
    const found: FunctionFacts = { effects: [], writes: [], loops: [], refs: new Map() };
    facts = found;
    this.facts.set(boundary, found);
    const addRef = (key: string, node: ts.Expression): void => {
      let list = found.refs.get(key);
      if (!list) found.refs.set(key, (list = []));
      list.push(node);
    };
    const effect = (node: ts.Node, at = node.end): void => {
      found.effects.push({ node, at });
    };
    ts.walkPreorder(boundary, (node) => {
      if (node !== boundary && isFlowBoundary(node)) return "skip";
      if (ts.isClassLikeDeclaration(node) && node !== boundary) {
        effect(node);
        return "skip";
      }
      switch (node.kind) {
        case ts.SyntaxKind.CallExpression:
        case ts.SyntaxKind.NewExpression:
        case ts.SyntaxKind.TaggedTemplateExpression:
        case ts.SyntaxKind.Decorator:
        case ts.SyntaxKind.AwaitExpression:
        case ts.SyntaxKind.YieldExpression:
        case ts.SyntaxKind.SpreadElement:
          effect(node);
          break;
        case ts.SyntaxKind.ForOfStatement:
          // The iterator steps between the iterable and the body.
          effect(node, (node as ts.ForOfStatement).expression.end);
          found.loops.push(node);
          break;
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
          found.loops.push(node);
          break;
        case ts.SyntaxKind.ArrayBindingPattern:
        case ts.SyntaxKind.ArrayLiteralExpression:
          if (program.iteration) effect(node, node.parent?.end ?? node.end);
          break;
        case ts.SyntaxKind.TemplateSpan:
          if (program.conversion) effect(node, (node as ts.TemplateSpan).expression.end);
          break;
        case ts.SyntaxKind.BinaryExpression:
          if (program.conversion) effect(node);
          break;
      }
      if (ts.isPropertyAccessExpression(node)) {
        addRef(`.${node.name.text}`, node);
        if (program.accessors.has(node.name.text)) effect(node);
      } else if (ts.isElementAccessExpression(node)) {
        const name = accessName(node);
        if (name !== null) {
          addRef(`.${name}`, node);
          if (program.accessors.has(name)) effect(node);
        }
      } else if (ts.isIdentifier(node) && isValueIdentifier(node)) {
        addRef(node.text, node);
      }
      const target = writeTargetOf(node);
      if (target) {
        forEachWriteTarget(target, (t) => {
          if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t))
            found.writes.push({ node: t, at: node.end });
        });
      }
      return undefined;
    });
    found.effects.sort((a, b) => a.at - b.at);
    found.writes.sort((a, b) => a.at - b.at);
    return facts;
  }

  /** Whether evaluating this candidate can run code other than standard
   * library operations that cannot call back into the program. */
  private isEffect(node: ts.Node): boolean {
    const cached = this.effects.get(node);
    if (cached !== undefined) return cached;
    let result = true;
    try {
      result = this.computeEffect(node);
    } finally {
      this.effects.set(node, result);
    }
    return result;
  }

  private computeEffect(node: ts.Node): boolean {
    const checker = this.lowerer.checker;
    if (ts.isCallExpression(node)) return !this.isInertLibraryCall(node);
    if (ts.isNewExpression(node)) return !this.isInertConstruction(node);
    if (ts.isForOfStatement(node)) {
      if (node.awaitModifier) return true;
      return this.program().iteration && !this.isBuiltinIterable(node.expression);
    }
    if (ts.isSpreadElement(node)) return !this.isBuiltinIterable(node.expression);
    if (ts.isArrayBindingPattern(node)) {
      const owner = node.parent;
      return !(
        ts.isVariableDeclaration(owner) &&
        owner.initializer !== undefined &&
        this.isBuiltinIterable(owner.initializer)
      );
    }
    if (ts.isArrayLiteralExpression(node)) {
      const parent = node.parent;
      if (
        !ts.isBinaryExpression(parent) ||
        parent.left !== node ||
        parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      )
        return false;
      return !this.isBuiltinIterable(parent.right);
    }
    if (ts.isTemplateSpan(node)) return !this.isPrimitive(node.expression);
    if (ts.isBinaryExpression(node)) {
      if (!CONVERTING_OPERATORS.has(node.operatorToken.kind)) return false;
      return !this.isPrimitive(node.left) || !this.isPrimitive(node.right);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(
        ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression,
      );
      if (!symbol) return true;
      return (
        (symbol.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0 &&
        !this.lowerer.isStdlibSymbol(symbol)
      );
    }
    if (ts.isClassLikeDeclaration(node)) {
      if (node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.Decorator)) return true;
      for (const clause of node.heritageClauses?.nodes ?? []) {
        for (const heritage of clause.types.nodes) {
          const e = heritageElementTarget(heritage);
          if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e) && !ts.isQualifiedName(e))
            return true;
        }
      }
      return node.members.nodes.some(
        (member) =>
          ts.isClassStaticBlockDeclaration(member) ||
          (member.name !== undefined && ts.isComputedPropertyName(member.name)) ||
          member.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.Decorator) === true ||
          (ts.isPropertyDeclaration(member) &&
            member.initializer !== undefined &&
            member.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true),
      );
    }
    return true;
  }

  private isInertLibraryCall(call: ts.CallExpression): boolean {
    if (call.expression.kind === ts.SyntaxKind.SuperKeyword) return false;
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return false;
    if (!this.inertArguments(call.arguments.nodes)) return false;
    const callee = withoutParenthesesTypeWrappers(call.expression);
    if (ts.isIdentifier(callee)) {
      if (!INERT_GLOBAL_FUNCTIONS.has(callee.text)) return false;
      if (!this.lowerer.isStdlibGlobal(callee, callee.text)) return false;
      return call.arguments.nodes.every((arg) => this.isPrimitive(arg));
    }
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const method = callee.name.text;
    const receiver = withoutParenthesesTypeWrappers(callee.expression);
    if (ts.isIdentifier(receiver)) {
      const members = INERT_NAMESPACE_MEMBERS.get(receiver.text);
      if (members !== undefined && this.lowerer.isStdlibGlobal(receiver, receiver.text))
        return members === "*" || members.has(method);
    }
    const checker = this.lowerer.checker;
    const type = checker.getTypeAtLocation(callee.expression);
    if (type.flags & PRIMITIVE_FLAGS) return true;
    if (checker.isArrayType(type) || checker.isTupleType(type))
      return !ARRAY_CONVERTING_METHODS.has(method);
    const symbol = type.getSymbol();
    return (
      symbol !== undefined &&
      BUILTIN_COLLECTIONS.has(ts.symbolName(symbol)) &&
      this.lowerer.isStdlibSymbol(symbol)
    );
  }

  private isInertConstruction(node: ts.NewExpression): boolean {
    const callee = withoutParenthesesTypeWrappers(node.expression);
    if (!ts.isIdentifier(callee) || !INERT_CONSTRUCTORS.has(callee.text)) return false;
    if (!this.lowerer.isStdlibGlobal(callee, callee.text)) return false;
    const args = node.arguments?.nodes ?? [];
    if (!this.inertArguments(args)) return false;
    return args.every((arg) => this.isPrimitive(arg) || this.isBuiltinIterable(arg));
  }

  /** No argument is a function the callee could invoke. */
  private inertArguments(args: readonly ts.Expression[]): boolean {
    const checker = this.lowerer.checker;
    for (const arg of args) {
      const e = withoutParenthesesTypeWrappers(arg);
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return false;
      if (ts.isSpreadElement(e)) continue;
      if (
        ts.isStringLiteral(e) ||
        ts.isNumericLiteral(e) ||
        ts.isNoSubstitutionTemplateLiteral(e) ||
        e.kind === ts.SyntaxKind.TrueKeyword ||
        e.kind === ts.SyntaxKind.FalseKeyword
      )
        continue;
      const type = checker.getTypeAtLocation(e);
      if (type.flags & PRIMITIVE_FLAGS) continue;
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
      if (checker.getCallSignatures(type).length > 0) return false;
      if (this.program().conversion && !(type.flags & ts.TypeFlags.Object)) return false;
    }
    return true;
  }

  private isPrimitive(node: ts.Expression): boolean {
    return (this.lowerer.checker.getTypeAtLocation(node).flags & PRIMITIVE_FLAGS) !== 0;
  }

  private isBuiltinIterable(node: ts.Expression): boolean {
    const checker = this.lowerer.checker;
    const type = checker.getTypeAtLocation(node);
    if (type.flags & ts.TypeFlags.StringLike) return true;
    return checker.isArrayType(type) || checker.isTupleType(type);
  }
}

interface ProgramFacts {
  /** Property names stored anywhere outside a constructor's own `this`. */
  mutable: Set<string>;
  /** Names of user-declared accessors. */
  accessors: Set<string>;
  /** A computed or reflective store can reach any class instance field. */
  wildcard: boolean;
  /** The program defines `toString`/`valueOf`/`toJSON`/`Symbol.toPrimitive`. */
  conversion: boolean;
  /** The program defines generators or `Symbol.iterator` members. */
  iteration: boolean;
}

/** A node and the source position at which its evaluation takes effect. */
interface Timed<T extends ts.Node> {
  node: T;
  at: number;
}

interface FunctionFacts {
  /** Candidates that may run other code, ordered by `at`. */
  effects: Timed<ts.Node>[];
  /** Member store targets, ordered by when the store happens. */
  writes: Timed<ts.Expression>[];
  loops: ts.Node[];
  /** References by final name (`.name` for members), in source order. */
  refs: Map<string, ts.Expression[]>;
}

interface ReferenceChain {
  key: string;
  root: ts.Node;
  links: { name: string; node: ts.PropertyAccessExpression | ts.ElementAccessExpression }[];
}

type WidePosition = "chain" | "member" | "test" | "context";

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Void;

const CONVERTING_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
]);

/** Global functions that never call back when given primitive arguments. */
const INERT_GLOBAL_FUNCTIONS = new Set([
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "String",
  "Number",
  "Boolean",
]);

/** Standard namespaces whose listed members never call back into the
 * program when given no function argument. */
const INERT_NAMESPACE_MEMBERS = new Map<string, ReadonlySet<string> | "*">([
  ["Math", "*"],
  ["console", "*"],
  [
    "Number",
    new Set(["isInteger", "isFinite", "isNaN", "isSafeInteger", "parseFloat", "parseInt"]),
  ],
  ["String", new Set(["fromCharCode", "fromCodePoint"])],
  [
    "Object",
    new Set(["keys", "values", "entries", "hasOwn", "getPrototypeOf", "is", "getOwnPropertyNames"]),
  ],
  ["Array", new Set(["isArray"])],
  ["Date", new Set(["now"])],
]);

/** Array methods that convert their elements through user hooks. */
const ARRAY_CONVERTING_METHODS = new Set([
  "join",
  "toString",
  "toLocaleString",
  "sort",
  "toSorted",
]);

const BUILTIN_COLLECTIONS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ReadonlyMap",
  "ReadonlySet",
]);

const INERT_CONSTRUCTORS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Array",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Date",
  "RegExp",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/** One write of a variable: `at` is the declaration, the `=` assignment, or
 * for any other write the identifier written. */
interface BindingWrite {
  at: ts.Node;
  value: ts.Expression | null;
  kind: "declared" | "assigned" | "unknown";
  stale: boolean;
}

/** `undefined`, `null` or `void e`, through parentheses and assertions. */
function spellsNothing(value: ts.Expression): boolean {
  const e = withoutParenthesesTypeWrappers(value);
  return (
    e.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(e) ||
    (ts.isIdentifier(e) && e.text === "undefined")
  );
}

/** Whether `node` is `inner` or contains it. */
function contains(node: ts.Node, inner: ts.Node): boolean {
  for (let n: ts.Node | undefined = inner; n !== undefined; n = n.parent) {
    if (n === node) return true;
  }
  return false;
}

/** Which of `undefined`, `null` and `void` a type includes. */
function nothingFlags(type: ts.Type): number {
  const nothing = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
  if (!type.isUnionType()) return type.flags & nothing;
  let flags = 0;
  for (const part of ts.constituentTypes(type)) flags |= part.flags & nothing;
  return flags;
}

/** `undefined`, `null`, `void`, or a union of only those. */
function isNothing(type: ts.Type): boolean {
  const nothing = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
  if (type.flags & nothing) return true;
  return type.isUnionType() && ts.constituentTypes(type).every((part) => part.flags & nothing);
}

/** The receiver whose type widenedType reads for `node`: a property read in
 * a slot that accepts its declared type (an argument, a return, a typed
 * binding or literal). Whole-program analyses batch these receivers. */
export function widenedReceiver(node: ts.Node): ts.Expression | null {
  return ts.isPropertyAccessExpression(node) && widePosition(node) === "context"
    ? node.expression
    : null;
}

/** Where a stale narrowed read can keep its declared representation: the
 * receiver of `?.`, an absence/type/truthiness test, or a slot whose
 * contextual type may accept the declared type. */
function widePosition(node: ts.Expression): WidePosition | null {
  let child: ts.Node = node;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isCallExpression(parent)) &&
    parent.expression === child
  ) {
    if (parent.questionDotToken !== undefined) return "chain";
    return memberUse(node) !== null ? "member" : null;
  }
  if (ts.isBinaryExpression(parent)) {
    switch (parent.operatorToken.kind) {
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.InstanceOfKeyword:
        return parent.left === child ? "test" : null;
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return "test";
      case ts.SyntaxKind.EqualsToken:
        return parent.right === child ? "context" : null;
      default:
        return null;
    }
  }
  if (ts.isPrefixUnaryExpression(parent))
    return parent.operator === ts.SyntaxKind.ExclamationToken ? "test" : null;
  if (ts.isTypeOfExpression(parent)) return "test";
  if (ts.isTemplateSpan(parent)) return "test";
  if (
    (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
    parent.expression === child
  )
    return "test";
  if (ts.isConditionalExpression(parent) && parent.condition === child) return "test";
  if (ts.isForStatement(parent) && parent.condition === child) return "test";
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.nodes.some((arg) => arg === child)
  )
    return "context";
  // Only slots whose type IS the contextual type: an array or object
  // literal (or an unannotated arrow body) infers its own type from the
  // narrowed element instead, unless the literal itself sits in a typed
  // slot (`const xs: Expr[] = [x]`, `{ value }` passed as a parameter).
  if (ts.isReturnStatement(parent)) return "context";
  if (
    (ts.isArrayLiteralExpression(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === child) ||
      ts.isShorthandPropertyAssignment(parent)) &&
    typedLiteral(parent)
  )
    return "context";
  if (ts.isVariableDeclaration(parent) && parent.initializer === child && parent.type)
    return "context";
  return null;
}

/** The call or construction whose argument holds `node`, directly or as an
 * element or property of literal arguments, with that argument. */
function enclosingArgument(
  node: ts.Expression,
): { call: ts.CallExpression | ts.NewExpression; argument: ts.Expression } | null {
  let child: ts.Node = node;
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === child)
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!(ts.isCallExpression(parent) || ts.isNewExpression(parent))) return null;
  const argument = parent.arguments?.nodes.find((arg) => arg === child);
  return argument ? { call: parent, argument } : null;
}

/** The array or object literal holding `parent` (an element's literal or a
 * property assignment) is itself lowered against a declared slot type. */
function typedLiteral(
  parent: ts.ArrayLiteralExpression | ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): boolean {
  let literal: ts.Node | undefined = ts.isArrayLiteralExpression(parent) ? parent : parent.parent;
  while (literal) {
    let slot: ts.Node | undefined = literal.parent;
    while (slot && ts.isParenthesizedExpression(slot)) {
      literal = slot;
      slot = slot.parent;
    }
    if (!slot) return false;
    if (ts.isVariableDeclaration(slot)) return slot.initializer === literal && !!slot.type;
    if (ts.isCallExpression(slot) || ts.isNewExpression(slot))
      return slot.arguments?.nodes.some((arg) => arg === literal) ?? false;
    if (ts.isBinaryExpression(slot))
      return slot.operatorToken.kind === ts.SyntaxKind.EqualsToken && slot.right === literal;
    if (ts.isReturnStatement(slot)) {
      let fn: ts.Node | undefined = slot.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      return fn !== undefined && ts.isFunctionLike(fn) && fn.type !== undefined;
    }
    if (ts.isArrayLiteralExpression(slot)) {
      literal = slot;
      continue;
    }
    if (ts.isPropertyAssignment(slot) && slot.initializer === literal) {
      literal = slot.parent;
      continue;
    }
    return false;
  }
  return false;
}

/** The plain member read or method call `node` is the receiver of
 * (`node.name`, `node.name(...)`; not a store target or optional step). */
function memberUse(
  node: ts.Expression,
): { access: ts.PropertyAccessExpression; call: boolean } | null {
  let child: ts.Node = node;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== child) return null;
  if (parent.questionDotToken !== undefined) return null;
  const outer = parent.parent;
  if (outer && writeTargetOf(outer) === parent) return null;
  const call = outer !== undefined && ts.isCallExpression(outer) && outer.expression === parent;
  if (call && (outer as ts.CallExpression).questionDotToken !== undefined) return null;
  return { access: parent, call };
}

/** The function-like body, class member initializer or file whose flow
 * contains `node`. */
function flowBoundary(node: ts.Node): ts.Node {
  let n: ts.Node | undefined = node.parent;
  while (n && !isFlowBoundary(n)) n = n.parent;
  return n ?? ts.getSourceFileOfNode(node);
}

function isFlowBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionLike(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isSourceFile(node)
  );
}

/** A member access's name when it is static (`o.p`, `o["p"]`, `o[0]`). */
function accessName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
    if (ts.isNumericLiteral(arg)) return String(Number(arg.text));
  }
  return null;
}

/** The normalized spelling TypeScript's reference matching would equate:
 * parentheses, non-null and type assertions erased, `o["p"]` as `o.p`. */
function referenceKey(node: ts.Node): string | null {
  const e = withoutParenthesesTypeWrappers(node as ts.Expression);
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const name = accessName(e);
    if (name === null) return null;
    const receiver = referenceKey(e.expression);
    return receiver === null ? null : `${receiver}.${name}`;
  }
  return null;
}

function referenceChain(node: ts.Expression): ReferenceChain | null {
  const key = referenceKey(node);
  if (key === null) return null;
  const links: ReferenceChain["links"] = [];
  let e = withoutParenthesesTypeWrappers(node);
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    links.unshift({ name: accessName(e)!, node: e });
    e = withoutParenthesesTypeWrappers(e.expression);
  }
  return { key, root: e, links };
}

function memberName(name: ts.Node): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

/** The store target expression of an assignment-like node. */
function writeTargetOf(node: ts.Node): ts.Node | null {
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) return node.left;
    return null;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return node.operand;
  if (ts.isDeleteExpression(node)) return node.expression;
  if (
    (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)
  )
    return node.initializer;
  return null;
}

/** Each stored-to reference in a target, through destructuring patterns. */
function forEachWriteTarget(target: ts.Node, visit: (target: ts.Expression) => void): void {
  const e = withoutParenthesesTypeWrappers(target as ts.Expression);
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    visit(e);
    return;
  }
  if (ts.isArrayLiteralExpression(e)) {
    for (const element of e.elements.nodes) {
      forEachWriteTarget(ts.isSpreadElement(element) ? element.expression : element, visit);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(e)) {
    for (const property of e.properties.nodes) {
      if (ts.isPropertyAssignment(property)) forEachWriteTarget(property.initializer, visit);
      else if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name))
        visit(property.name);
      else if (ts.isSpreadAssignment(property)) forEachWriteTarget(property.expression, visit);
    }
    return;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // A destructuring default: `[a = 1] = xs`.
    forEachWriteTarget(e.left, visit);
  }
}

/** `this.p = ...` directly in a constructor body, before the object can
 * be observed by code that narrowed it. */
function isConstructorThisStore(target: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
  if (withoutParenthesesTypeWrappers(target.expression).kind !== ts.SyntaxKind.ThisKeyword)
    return false;
  return ts.isConstructorDeclaration(flowBoundary(target));
}

/** `Object.assign(target, ...)` and similar reflective stores into an
 * existing object. */
function reflectiveStore(call: ts.CallExpression): boolean {
  const callee = withoutParenthesesTypeWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const owner = callee.expression.text;
  const method = callee.name.text;
  const reflective =
    (owner === "Object" &&
      (method === "assign" ||
        method === "defineProperty" ||
        method === "defineProperties" ||
        method === "setPrototypeOf")) ||
    (owner === "Reflect" &&
      (method === "set" ||
        method === "defineProperty" ||
        method === "deleteProperty" ||
        method === "setPrototypeOf"));
  if (!reflective) return false;
  const target = call.arguments.nodes[0];
  return (
    target === undefined || !ts.isObjectLiteralExpression(withoutParenthesesTypeWrappers(target))
  );
}

function isPlainContainerType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
  return parts.every((part) => {
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return true;
    if (checker.isArrayType(part) || checker.isTupleType(part) || checker.isArrayLikeType(part))
      return true;
    const symbol = part.getSymbol();
    if (symbol && symbol.flags & ts.SymbolFlags.Class) return false;
    return checker.getIndexInfosOfType(part).length > 0;
  });
}

/** Entries of an `at`-ordered list taking effect in `(start, end]`. */
function between<T extends ts.Node>(
  entries: readonly Timed<T>[],
  start: number,
  end: number,
): Timed<T>[] {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.at <= start) lo = mid + 1;
    else hi = mid;
  }
  const out: Timed<T>[] = [];
  for (let i = lo; i < entries.length && entries[i]!.at <= end; i++) out.push(entries[i]!);
  return out;
}
