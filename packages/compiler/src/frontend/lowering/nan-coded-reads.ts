import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import type { IrBytesElem } from "../../ir/ir.js";
import { isIntegerBytesElem } from "../../ir/ir.js";

/* NaN-coded typed-array reads.
 *
 * In Node a typed-array element read `t[i]` answers undefined when `i` is not
 * an integer in [0, length). The checker types the read as `number`, so the
 * default lowering returns a heap-boxed `number | undefined` union and widens
 * every binding, parameter and return it reaches.
 *
 * Many consumers cannot tell undefined from NaN: relational and arithmetic
 * operators and bitwise operators convert undefined to NaN (or 0, exactly as
 * NaN converts), truthiness treats both as false, `Math` functions convert
 * them alike, and strict or loose equality with a number that is never
 * undefined is false for both. Where every consumer of a read is of this
 * kind, the read lowers to a plain double that holds NaN for an invalid
 * index: no box, no widening, and no observable difference.
 *
 * The analysis follows values through local `let`/`const` bindings,
 * parameters of directly called functions and methods, and their returns.
 * Such a slot is NaN-coded when every value it receives is a NaN-coded value
 * or a number that is never undefined, and every use of it is one of the
 * consumers above or flows into another NaN-coded slot. Equality between two
 * NaN-coded values must answer true when both stand for undefined, so it is
 * lowered as `a === b || (a !== a && b !== b)`; that is exact only while
 * neither side can also hold a genuine NaN, which the analysis tracks (an
 * integer element is never NaN; arithmetic and float elements may be).
 *
 * Everything else keeps the established `number | undefined` lowering. */

export interface NanCodedHost {
  symbolOf(node: ts.Node): ts.Symbol | null;
  declarationOf(symbol: ts.Symbol): ts.Node | undefined;
  /** The element kind of a typed-array receiver, or null. */
  bytesElemOf(receiver: ts.Expression): IrBytesElem | null;
  /** The static IR type of the node is a plain number. */
  isNumber(node: ts.Node): boolean;
  isString(node: ts.Expression): boolean;
  /** The receiver is an array or a typed array (for `.length`). */
  hasLength(node: ts.Expression): boolean;
  isStdlibGlobal(node: ts.Expression, name: string): boolean;
  /** Parameter `index` of the callable is a plain `number` in its signature. */
  paramIsNumber(fn: ts.Symbol, index: number): boolean;
  /** The callable's signature returns a plain `number`. */
  returnIsNumber(fn: ts.Symbol): boolean;
  /** The method shares its dispatch slot with another class's method. */
  methodOverridden(fn: ts.Symbol): boolean;
}

interface ValueInfo {
  /** May stand for undefined (NaN-coded). */
  nce: boolean;
  /** May also hold a genuine NaN. */
  nan: boolean;
}

type Slot = BindingSlot | ReturnSlot;

interface SlotBase {
  /** Values written into the slot (initializers, assignments, arguments,
   * return expressions); null marks a write of unknown value. */
  sources: (ts.Expression | null)[];
  /** Value occurrences whose consumers must be NaN-insensitive. */
  uses: ts.Expression[];
  /** Compound writes and increments store arithmetic results. */
  arithmeticWrites: boolean;
}

interface BindingSlot extends SlotBase {
  kind: "binding";
  symbol: ts.Symbol;
}

interface ReturnSlot extends SlotBase {
  kind: "return";
  symbol: ts.Symbol;
}

function peelTransparent(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

/** The node whose consumer decides how `node`'s value is used. */
function transparentParent(node: ts.Expression): ts.Expression {
  let e: ts.Expression = node;
  for (;;) {
    const p = e.parent;
    if (
      p &&
      (ts.isParenthesizedExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isTypeAssertion(p) ||
        ts.isSatisfiesExpression(p) ||
        ts.isNonNullExpression(p)) &&
      p.expression === e
    ) {
      e = p;
      continue;
    }
    return e;
  }
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

const RELATIONAL = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
const EQUALITY = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
/** Results never NaN-free: ToNumber of each operand may be NaN. */
const ARITHMETIC = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
]);
/** ToInt32/ToUint32 map undefined and NaN to 0 alike; results are integers. */
const BITWISE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
/** Compound assignments whose operator converts undefined like NaN. */
const NUMERIC_COMPOUND = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

/** `Math` functions convert every argument with ToNumber. */
const MATH_INTEGER_RESULTS = new Set(["imul", "clz32", "sign"]);

function isLoopOrIf(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isForStatement(node)
  );
}

export class NanCodedReads {
  /** Typed-array element reads that can lower as NaN-coded doubles. */
  private readonly reads = new Map<ts.ElementAccessExpression, IrBytesElem>();
  private readonly bindings = new Map<ts.Symbol, BindingSlot>();
  private readonly notSlots = new Set<ts.Symbol>();
  /** Every slot's value occurrences. */
  private readonly useNodes = new Set<ts.Node>();
  private readonly returns = new Map<ts.Symbol, ReturnSlot>();
  /** Identifiers by text across the analyzed files. */
  private readonly names = new Map<string, ts.Identifier[]>();
  private readonly symbolCache = new Map<ts.Node, ts.Symbol | null>();
  private readonly pneCache = new Map<ts.Node, ValueInfo | null>();
  private readonly pneReturnCache = new Map<ts.Symbol, ValueInfo | null>();
  private readonly fnEligibility = new Map<ts.Symbol, ts.FunctionLikeDeclaration | null>();
  private readonly callSites = new Map<ts.Symbol, ts.CallExpression[] | null>();
  /** Slots that are NaN-coded after the fixed point. */
  private readonly eligible = new Set<Slot>();
  private readonly genuineNaN = new Set<Slot>();
  private readonly numericReads = new Set<ts.ElementAccessExpression>();
  private analyzed = false;

  constructor(
    private readonly host: NanCodedHost,
    private readonly files: readonly ts.SourceFile[],
  ) {}

  /** The read lowers to a double holding NaN for an invalid index. */
  isNumericRead(read: ts.ElementAccessExpression): boolean {
    return this.numericReads.has(read);
  }

  /** Both operands of this equality are NaN-coded values that may stand
   * for undefined: undefined equals undefined, so equal NaNs compare equal. */
  needsUndefinedEquality(expr: ts.BinaryExpression): boolean {
    if (!EQUALITY.has(expr.operatorToken.kind)) return false;
    const left = this.loweredInfo(expr.left);
    const right = this.loweredInfo(expr.right);
    return left.nce && right.nce && !left.nan && !right.nan;
  }

  /** Bindings and returns that are NaN-coded (consistency checks). */
  nanCodedBinding(symbol: ts.Symbol): boolean {
    const slot = this.bindings.get(symbol);
    return slot !== undefined && this.eligible.has(slot);
  }

  nanCodedReturn(symbol: ts.Symbol): boolean {
    const slot = this.returns.get(symbol);
    return slot !== undefined && this.eligible.has(slot);
  }

  get size(): { reads: number; slots: number } {
    return { reads: this.numericReads.size, slots: this.eligible.size };
  }

  analyze(): void {
    if (this.analyzed) return;
    this.analyzed = true;
    for (const sf of this.files) {
      if (isJsSourceFile(sf) || sf.isDeclarationFile) continue;
      ts.walkPreorder(sf, (node) => {
        if (ts.isIdentifier(node)) {
          const list = this.names.get(node.text);
          if (list) list.push(node);
          else this.names.set(node.text, [node]);
          return;
        }
        if (ts.isElementAccessExpression(node) && this.isReadCandidate(node)) {
          const elem = this.host.bytesElemOf(node.expression);
          if (elem) this.reads.set(node, elem);
        }
      });
    }
    if (this.reads.size === 0) return;
    // Forward: the slots a read can reach.
    const work: ts.Expression[] = [...this.reads.keys()];
    const reached = new Set<Slot>();
    while (work.length > 0) {
      const value = work.pop()!;
      const slot = this.sinkOf(value);
      if (!slot || reached.has(slot)) continue;
      reached.add(slot);
      for (const use of slot.uses) work.push(use);
    }
    for (const slot of reached) this.eligible.add(slot);
    // Backward: drop slots with an unsafe use or source until stable.
    for (let changed = true; changed;) {
      changed = false;
      this.computeGenuineNaN();
      for (const slot of [...this.eligible]) {
        if (this.slotOk(slot)) continue;
        if (this.removals) this.removals.set(slot, this.removalReason(slot));
        this.eligible.delete(slot);
        changed = true;
      }
    }
    this.computeGenuineNaN();
    for (const read of this.reads.keys()) if (this.useSafe(read)) this.numericReads.add(read);
    if (process.env["SCRIPTC_DEBUG_NAN_CODED"]) this.debugReport(reached);
  }

  private readonly removals: Map<Slot, string> | null = process.env["SCRIPTC_DEBUG_NAN_CODED"]
    ? new Map()
    : null;

  private removalReason(slot: Slot): string {
    const badSource = slot.sources.find((s) => s === null || this.sourceInfo(s) === null);
    if (badSource !== undefined)
      return `source ${badSource ? badSource.getText().slice(0, 60) : "<unknown>"}`;
    const nan = this.genuineNaN.has(slot);
    const badUse = slot.uses.find((u) => !this.useSafe(u) && (nan || !this.reboxConsumer(u)));
    if (badUse)
      return `${nan ? "nan-use" : "use"} ${transparentParent(badUse).parent?.getText().slice(0, 80) ?? "?"}`;
    return "?";
  }

  private debugReport(reached: Set<Slot>): void {
    const name = (slot: Slot): string => {
      const decl = this.host.declarationOf(slot.symbol);
      const sf = decl?.getSourceFile();
      const where = sf && decl ? `${sf.fileName}:${decl.getStart()}` : "?";
      return `${slot.kind} ${slot.symbol.name} @ ${where}`;
    };
    for (const slot of reached) {
      const ok = this.eligible.has(slot);
      const why = ok
        ? this.genuineNaN.has(slot)
          ? "(nan)"
          : `(rebox ${slot.uses.filter((u) => !this.useSafe(u)).length})`
        : (this.removals?.get(slot) ?? "?");
      process.stderr.write(`nan-coded ${ok ? "yes" : "no "} ${name(slot)} ${why}\n`);
    }
    process.stderr.write(
      `nan-coded reads ${this.numericReads.size}/${this.reads.size}, slots ${this.eligible.size}/${reached.size}\n`,
    );
  }

  private symbolOf(node: ts.Node): ts.Symbol | null {
    // A cached null is an answer: `!` would be a checked extraction in a
    // native build of the compiler.
    const cached = this.symbolCache.get(node);
    if (cached !== undefined) return cached;
    const symbol = this.host.symbolOf(node);
    this.symbolCache.set(node, symbol);
    return symbol;
  }

  /** An element read (never a write target) of a TypeScript file. */
  private isReadCandidate(read: ts.ElementAccessExpression): boolean {
    if (read.questionDotToken) return false;
    let n: ts.Node = read;
    let p = n.parent;
    while (p && ts.isParenthesizedExpression(p)) {
      n = p;
      p = n.parent;
    }
    // `t[i]!` asserts presence: it already lowers to the plain numeric read
    // and is never optional.
    if (!p || ts.isNonNullExpression(p)) return false;
    if (ts.isBinaryExpression(p) && p.left === n && isAssignmentOperator(p.operatorToken.kind))
      return false;
    if (
      (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
    )
      return false;
    if (ts.isDeleteExpression(p)) return false;
    if (
      ts.isArrayLiteralExpression(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isSpreadElement(p) ||
      ts.isForOfStatement(p) ||
      ts.isForInStatement(p)
    )
      return false;
    return true;
  }

  // ---- slots --------------------------------------------------------------

  /** The function whose `return` statement contains `node`. */
  private containingFunction(node: ts.Node): ts.Node | undefined {
    let n = node.parent;
    while (
      n &&
      !ts.isFunctionLike(n) &&
      !ts.isClassStaticBlockDeclaration(n) &&
      !ts.isSourceFile(n)
    )
      n = n.parent;
    return n;
  }

  /** The declaration of a directly called function or method, when every
   * reference to it is a direct call (no value use, no overrides). */
  private eligibleFunction(symbol: ts.Symbol): ts.FunctionLikeDeclaration | null {
    const known = this.fnEligibility.get(symbol);
    if (known !== undefined) return known;
    this.fnEligibility.set(symbol, null);
    const decl = this.host.declarationOf(symbol);
    if (!decl || (!ts.isFunctionDeclaration(decl) && !ts.isMethodDeclaration(decl))) return null;
    if (!decl.body || decl.asteriskToken || decl.typeParameters || !decl.name) return null;
    if (!ts.isIdentifier(decl.name)) return null;
    const sf = decl.getSourceFile();
    if (isJsSourceFile(sf) || sf.isDeclarationFile) return null;
    const flags = ts.getCombinedModifierFlags(decl);
    if (flags & (ts.ModifierFlags.Async | ts.ModifierFlags.Abstract | ts.ModifierFlags.Ambient))
      return null;
    if (ts.isMethodDeclaration(decl)) {
      const cls = decl.parent;
      if (!ts.isClassDeclaration(cls) || (cls.heritageClauses?.length ?? 0) > 0) return null;
      if (this.host.methodOverridden(symbol)) return null;
    }
    // Sloppy-mode `arguments` aliases parameters.
    let usesArguments = false;
    ts.walkPreorder(decl.body, (node) => {
      if (ts.isIdentifier(node) && node.text === "arguments") usesArguments = true;
    });
    if (usesArguments) return null;
    const calls = this.directCalls(symbol, decl.name);
    if (!calls) return null;
    this.fnEligibility.set(symbol, decl);
    return decl;
  }

  /** Every call of the function, or null when some reference is not a
   * direct, non-optional call. */
  private directCalls(symbol: ts.Symbol, declName: ts.Identifier): ts.CallExpression[] | null {
    const known = this.callSites.get(symbol);
    if (known !== undefined) return known;
    const calls: ts.CallExpression[] = [];
    let ok = true;
    for (const id of this.names.get(declName.text) ?? []) {
      if (id === declName) continue;
      // Import and export specifiers only alias the function.
      const parent = id.parent;
      if (
        parent &&
        (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent))
      )
        continue;
      if (this.symbolOf(id) !== symbol) continue;
      let callee: ts.Expression = id;
      const p = id.parent;
      if (p && ts.isPropertyAccessExpression(p) && p.name === id) {
        if (p.questionDotToken) ok = false;
        callee = p;
      }
      const call = callee.parent;
      if (
        !call ||
        !ts.isCallExpression(call) ||
        call.expression !== callee ||
        call.questionDotToken ||
        call.arguments.some((a) => ts.isSpreadElement(a))
      ) {
        ok = false;
        break;
      }
      calls.push(call);
    }
    const result = ok ? calls : null;
    this.callSites.set(symbol, result);
    return result;
  }

  private bindingSlot(symbol: ts.Symbol): BindingSlot | null {
    const existing = this.bindings.get(symbol);
    if (existing) return existing;
    if (this.notSlots.has(symbol)) return null;
    const slot = this.scanBindingSlot(symbol);
    if (slot) this.bindings.set(symbol, slot);
    else this.notSlots.add(symbol);
    return slot;
  }

  private scanBindingSlot(symbol: ts.Symbol): BindingSlot | null {
    const decl = this.host.declarationOf(symbol);
    if (!decl) return null;
    const sf = decl.getSourceFile();
    if (isJsSourceFile(sf) || sf.isDeclarationFile) return null;
    let nameNode: ts.Identifier;
    const slot: BindingSlot = {
      kind: "binding",
      symbol,
      sources: [],
      uses: [],
      arithmeticWrites: false,
    };
    if (ts.isVariableDeclaration(decl)) {
      const list = decl.parent;
      if (
        !ts.isIdentifier(decl.name) ||
        !ts.isVariableDeclarationList(list) ||
        !(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) ||
        ts.isForOfStatement(list.parent) ||
        ts.isForInStatement(list.parent)
      )
        return null;
      // Module bindings are globals with their own promotion rules.
      if (ts.isVariableStatement(list.parent) && ts.isSourceFile(list.parent.parent)) return null;
      if (!this.host.isNumber(decl.name)) return null;
      nameNode = decl.name;
      if (decl.initializer) slot.sources.push(decl.initializer);
    } else if (ts.isParameter(decl)) {
      if (!ts.isIdentifier(decl.name) || decl.dotDotDotToken || decl.questionToken) return null;
      const fn = decl.parent;
      if (!ts.isFunctionDeclaration(fn) && !ts.isMethodDeclaration(fn)) return null;
      const fnSymbol = fn.name ? this.symbolOf(fn.name) : null;
      if (!fnSymbol || !this.eligibleFunction(fnSymbol)) return null;
      const index = fn.parameters.indexOf(decl);
      if (index < 0 || !this.host.paramIsNumber(fnSymbol, index)) return null;
      nameNode = decl.name;
      if (decl.initializer) slot.sources.push(decl.initializer);
      for (const call of this.callSites.get(fnSymbol) ?? []) {
        const arg = call.arguments[index];
        if (arg) slot.sources.push(arg);
        else if (!decl.initializer) slot.sources.push(null);
      }
    } else return null;
    for (const id of this.names.get(nameNode.text) ?? []) {
      if (id === nameNode || this.symbolOf(id) !== symbol) continue;
      const write = this.writeOf(id);
      if (write === "read") slot.uses.push(id);
      else if (write === "arith") {
        slot.arithmeticWrites = true;
        // The compound operator reads the binding as well.
        slot.uses.push(id);
      } else if (write === "unknown") slot.sources.push(null);
      else slot.sources.push(write);
    }
    for (const use of slot.uses) this.useNodes.add(use);
    return slot;
  }

  /** How an identifier reference touches its binding. */
  private writeOf(id: ts.Identifier): "read" | "arith" | "unknown" | ts.Expression {
    let n: ts.Node = id;
    let p = n.parent;
    while (p && ts.isParenthesizedExpression(p)) {
      n = p;
      p = n.parent;
    }
    if (!p) return "read";
    if (ts.isBinaryExpression(p) && p.left === n && isAssignmentOperator(p.operatorToken.kind)) {
      const k = p.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsToken) return p.right;
      if (k === ts.SyntaxKind.PlusEqualsToken)
        return this.host.isNumber(p.right) ? "arith" : "unknown";
      return NUMERIC_COMPOUND.has(k) ? "arith" : "unknown";
    }
    if (
      (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
    )
      return "arith";
    if (
      ts.isArrayLiteralExpression(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isSpreadElement(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === n) ||
      ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n)
    ) {
      // A destructuring target, or an object literal value (a read).
      return ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
        ? this.inDestructuringTarget(p)
          ? "unknown"
          : "read"
        : ts.isForOfStatement(p) || ts.isForInStatement(p)
          ? "unknown"
          : this.inDestructuringTarget(p)
            ? "unknown"
            : "read";
    }
    return "read";
  }

  private inDestructuringTarget(node: ts.Node): boolean {
    let n: ts.Node = node;
    let p = n.parent;
    while (
      p &&
      (ts.isArrayLiteralExpression(p) ||
        ts.isObjectLiteralExpression(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isSpreadElement(p) ||
        ts.isSpreadAssignment(p) ||
        ts.isParenthesizedExpression(p))
    ) {
      n = p;
      p = n.parent;
    }
    if (!p) return false;
    if (
      ts.isBinaryExpression(p) &&
      p.left === n &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      return true;
    return (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n;
  }

  private returnSlot(symbol: ts.Symbol): ReturnSlot | null {
    const existing = this.returns.get(symbol);
    if (existing) return existing;
    const decl = this.eligibleFunction(symbol);
    if (!decl || !decl.body || !this.host.returnIsNumber(symbol)) return null;
    const slot: ReturnSlot = {
      kind: "return",
      symbol,
      sources: [],
      uses: [...(this.callSites.get(symbol) ?? [])],
      arithmeticWrites: false,
    };
    const body = decl.body;
    ts.walkPreorder(body, (node) => {
      if (!ts.isReturnStatement(node) || this.containingFunction(node) !== decl) return;
      slot.sources.push(node.expression ?? null);
    });
    for (const use of slot.uses) this.useNodes.add(use);
    this.returns.set(symbol, slot);
    return slot;
  }

  /** The callee of a call: a function or method symbol. */
  private calleeSymbol(call: ts.CallExpression): ts.Symbol | null {
    if (call.questionDotToken) return null;
    let callee = call.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (ts.isIdentifier(callee)) return this.symbolOf(callee);
    if (ts.isPropertyAccessExpression(callee) && !callee.questionDotToken)
      return this.symbolOf(callee.name);
    return null;
  }

  /** The slot a value flows into, through transparent wrappers and
   * conditional branches; null for a direct consumer. */
  private sinkOf(value: ts.Expression): Slot | null {
    const e = transparentParent(value);
    const p = e.parent;
    if (!p) return null;
    if (ts.isConditionalExpression(p) && p.condition !== e) return this.sinkOf(p);
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (k === ts.SyntaxKind.CommaToken && p.right === e) return this.sinkOf(p);
      if (k === ts.SyntaxKind.EqualsToken && p.right === e) {
        const target = peelTransparent(p.left);
        if (!ts.isIdentifier(target)) return null;
        const symbol = this.symbolOf(target);
        return symbol ? this.bindingSlot(symbol) : null;
      }
      return null;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === e && ts.isIdentifier(p.name)) {
      const symbol = this.symbolOf(p.name);
      return symbol ? this.bindingSlot(symbol) : null;
    }
    if (ts.isReturnStatement(p)) {
      const fn = this.containingFunction(p);
      if (!fn || (!ts.isFunctionDeclaration(fn) && !ts.isMethodDeclaration(fn)) || !fn.name)
        return null;
      const symbol = this.symbolOf(fn.name);
      return symbol ? this.returnSlot(symbol) : null;
    }
    if (ts.isCallExpression(p) && p.expression !== e) {
      const index = p.arguments.indexOf(e);
      const fn = this.calleeSymbol(p);
      if (index < 0 || !fn) return null;
      const decl = this.eligibleFunction(fn);
      const param = decl?.parameters[index];
      if (!param || !ts.isIdentifier(param.name)) return null;
      const symbol = this.symbolOf(param.name);
      return symbol ? this.bindingSlot(symbol) : null;
    }
    return null;
  }

  /** A slot that never holds a genuine NaN encodes undefined exactly, so
   * any consumer can rebuild the union (see `reboxes`); a slot that may
   * hold a genuine NaN needs NaN-insensitive consumers throughout. */
  private slotOk(slot: Slot): boolean {
    for (const source of slot.sources)
      if (source === null || !this.sourceInfo(source)) return false;
    const nan = this.genuineNaN.has(slot);
    for (const use of slot.uses)
      if (!this.useSafe(use) && (nan || !this.reboxConsumer(use))) return false;
    return true;
  }

  /** The eligible slot whose value this occurrence reads, if any. */
  private slotOfValue(node: ts.Expression): Slot | null {
    if (ts.isIdentifier(node)) {
      const symbol = this.symbolOf(node);
      const slot = symbol ? this.bindings.get(symbol) : undefined;
      return slot && this.eligible.has(slot) && this.useNodes.has(node) ? slot : null;
    }
    if (ts.isCallExpression(node)) {
      const fn = this.calleeSymbol(node);
      const slot = fn ? this.returns.get(fn) : undefined;
      return slot && this.eligible.has(slot) && this.useNodes.has(node) ? slot : null;
    }
    return null;
  }

  /** This read of a NaN-coded slot reaches a consumer that could observe
   * undefined: lowering rebuilds `number | undefined` from the double (NaN
   * is undefined, exactly, since the slot never holds a genuine NaN), and
   * the optional-read analysis treats the occurrence as optional, so the
   * consumer lowers exactly as it does for an ordinary read. */
  reboxes(node: ts.Expression): boolean {
    if (!ts.isIdentifier(node) && !ts.isCallExpression(node)) return false;
    const slot = this.slotOfValue(node);
    return slot !== null && !this.genuineNaN.has(slot) && !this.useSafe(node);
  }

  /** A consumer that takes the value whole, so the rebuilt union lowers
   * there exactly like an ordinary optional read: an argument, a stored
   * or returned value, a literal element, or string concatenation. Any
   * other consumer (a member access, `typeof`, `??`, ...) keeps the slot
   * on the ordinary optional lowering instead. */
  private reboxConsumer(value: ts.Expression): boolean {
    const e = transparentParent(value);
    const p = e.parent;
    if (!p) return false;
    if (ts.isConditionalExpression(p)) return p.condition !== e && this.reboxConsumer(p);
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) return p.expression !== e;
    if (ts.isVariableDeclaration(p) || ts.isReturnStatement(p)) return true;
    if (ts.isArrayLiteralExpression(p) || ts.isTemplateSpan(p)) return true;
    if (ts.isPropertyAssignment(p)) return p.initializer === e;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsToken) return p.right === e;
      if (k === ts.SyntaxKind.PlusToken) return true;
      if (k === ts.SyntaxKind.CommaToken) return p.right === e && this.reboxConsumer(p);
    }
    return false;
  }

  private computeGenuineNaN(): void {
    this.genuineNaN.clear();
    for (let changed = true; changed;) {
      changed = false;
      for (const slot of this.eligible) {
        if (this.genuineNaN.has(slot)) continue;
        let nan = slot.arithmeticWrites;
        for (const source of slot.sources) {
          if (nan) break;
          if (source) nan = this.sourceInfo(source)?.nan ?? true;
        }
        if (nan) {
          this.genuineNaN.add(slot);
          changed = true;
        }
      }
    }
  }

  // ---- values -------------------------------------------------------------

  /** A value allowed into a NaN-coded slot, or null. */
  private sourceInfo(node: ts.Expression): ValueInfo | null {
    const e = peelTransparent(node);
    if (ts.isConditionalExpression(e)) {
      const a = this.sourceInfo(e.whenTrue);
      const b = a && this.sourceInfo(e.whenFalse);
      return a && b ? { nce: a.nce || b.nce, nan: a.nan || b.nan } : null;
    }
    if (ts.isElementAccessExpression(e)) {
      const elem = this.reads.get(e);
      if (elem !== undefined) return { nce: true, nan: !isIntegerBytesElem(elem) };
    }
    if (ts.isIdentifier(e)) {
      const symbol = this.symbolOf(e);
      const slot = symbol ? this.bindings.get(symbol) : undefined;
      if (slot && this.eligible.has(slot)) return { nce: true, nan: this.genuineNaN.has(slot) };
    }
    if (ts.isCallExpression(e)) {
      const fn = this.calleeSymbol(e);
      const slot = fn ? this.returns.get(fn) : undefined;
      if (slot && this.eligible.has(slot) && this.useNodes.has(e))
        return { nce: true, nan: this.genuineNaN.has(slot) };
    }
    if (ts.isBinaryExpression(e) && this.nanFreeArithmetic(e, 0)) return { nce: false, nan: false };
    const plain = this.plainNumber(e, 0);
    if (plain) return plain;
    // Any other number value may be undefined at run time (an optional
    // read the default lowering widens): lowering converts it with
    // ToNumber on entry (see `convertsSource`), so the slot may then hold
    // a genuine NaN.
    return this.host.isNumber(e) ? { nce: true, nan: true } : null;
  }

  /** The value flows into a NaN-coded slot: lowering converts an optional
   * number to NaN-for-undefined on entry. */
  convertsSource(node: ts.Expression): boolean {
    const slot = this.sinkOf(node);
    return slot !== null && this.eligible.has(slot);
  }

  /** The occurrence reads a NaN-coded slot. */
  readsNanCodedSlot(node: ts.Expression): boolean {
    return this.slotOfValue(node) !== null;
  }

  /** `+`, `-` or `*` over finite literals and integer values proven present
   * where they are read: the result is never NaN. A NaN-coded slot that
   * never holds a genuine NaN holds integers, finite plain numbers or NaN
   * for undefined, and a comparison guarding the read excludes NaN. */
  private nanFreeArithmetic(node: ts.Expression, depth: number): boolean {
    if (depth > 6) return false;
    const e = peelTransparent(node);
    if (ts.isNumericLiteral(e))
      return Number.isFinite(Number(e.text)) && Math.abs(Number(e.text)) < 2 ** 53;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken)
      return this.nanFreeArithmetic(e.operand, depth + 1);
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) {
        if (!this.host.isNumber(e.left) || !this.host.isNumber(e.right)) return false;
        return (
          this.nanFreeArithmetic(e.left, depth + 1) && this.nanFreeArithmetic(e.right, depth + 1)
        );
      }
      if (k === ts.SyntaxKind.AsteriskToken)
        return (
          (ts.isNumericLiteral(peelTransparent(e.left)) ||
            ts.isNumericLiteral(peelTransparent(e.right))) &&
          this.nanFreeArithmetic(e.left, depth + 1) &&
          this.nanFreeArithmetic(e.right, depth + 1)
        );
      return false;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const info = this.plainNumber(e, 0);
      return info !== null && !info.nan;
    }
    if (!ts.isIdentifier(e)) return false;
    const symbol = this.symbolOf(e);
    if (!symbol) return false;
    const slot = this.bindings.get(symbol);
    if (slot && this.eligible.has(slot)) {
      return (
        !this.genuineNaN.has(slot) &&
        slot.sources.length <= 1 &&
        !slot.arithmeticWrites &&
        this.provenPresent(e, symbol)
      );
    }
    const info = this.plainNumber(e, 0);
    return info !== null && !info.nan;
  }

  /** A dominating condition compares the never-reassigned binding with a
   * number literal, which is false for undefined. */
  private provenPresent(use: ts.Identifier, symbol: ts.Symbol): boolean {
    let child: ts.Node = use;
    for (let n = use.parent; n && !ts.isFunctionLike(n); child = n, n = n.parent) {
      let condition: ts.Expression | undefined;
      if (ts.isIfStatement(n) && n.thenStatement === child) condition = n.expression;
      else if (ts.isConditionalExpression(n) && n.whenTrue === child) condition = n.condition;
      else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        n.right === child
      )
        condition = n.left;
      if (condition && this.conditionExcludesUndefined(condition, symbol)) return true;
    }
    return false;
  }

  private conditionExcludesUndefined(condition: ts.Expression, symbol: ts.Symbol): boolean {
    const e = peelTransparent(condition);
    if (!ts.isBinaryExpression(e)) return false;
    const k = e.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken)
      return (
        this.conditionExcludesUndefined(e.left, symbol) ||
        this.conditionExcludesUndefined(e.right, symbol)
      );
    if (!RELATIONAL.has(k) && k !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
    const left = peelTransparent(e.left);
    const right = peelTransparent(e.right);
    const names = (x: ts.Expression): boolean => ts.isIdentifier(x) && this.symbolOf(x) === symbol;
    const literal = (x: ts.Expression): boolean => {
      const info = this.plainNumber(x, 0);
      return info !== null && !info.nan;
    };
    return (names(left) && literal(right)) || (names(right) && literal(left));
  }

  /** How the value lowers once the analysis is final: NaN-coded (a numeric
   * read or a read of a NaN-coded slot) or not. */
  private loweredInfo(node: ts.Expression): ValueInfo {
    const e = peelTransparent(node);
    if (ts.isConditionalExpression(e)) {
      const a = this.loweredInfo(e.whenTrue);
      const b = this.loweredInfo(e.whenFalse);
      return { nce: a.nce || b.nce, nan: a.nan || b.nan };
    }
    if (ts.isElementAccessExpression(e)) {
      const elem = this.reads.get(e);
      if (elem !== undefined && this.numericReads.has(e))
        return { nce: true, nan: !isIntegerBytesElem(elem) };
    }
    const slot = this.slotOfValue(e);
    if (slot) return { nce: true, nan: this.genuineNaN.has(slot) };
    return { nce: false, nan: true };
  }

  /** A number expression that is never undefined in Node and always lowers
   * to a plain double, whatever the optional-read analysis decides. */
  private plainNumber(node: ts.Expression, depth: number): ValueInfo | null {
    if (depth > 8) return null;
    const cached = this.pneCache.get(node);
    if (cached !== undefined) return cached;
    const result = this.computePlainNumber(node, depth);
    this.pneCache.set(node, result);
    return result;
  }

  private computePlainNumber(node: ts.Expression, depth: number): ValueInfo | null {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))
      e = e.expression;
    if (ts.isNumericLiteral(e)) return { nce: false, nan: false };
    if (ts.isPrefixUnaryExpression(e)) {
      if (e.operator === ts.SyntaxKind.TildeToken) return { nce: false, nan: false };
      if (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken)
        return { nce: false, nan: !ts.isNumericLiteral(e.operand) };
      return null;
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (BITWISE.has(k)) return { nce: false, nan: false };
      if (ARITHMETIC.has(k)) return { nce: false, nan: true };
      if (
        k === ts.SyntaxKind.PlusToken &&
        this.host.isNumber(e.left) &&
        this.host.isNumber(e.right)
      )
        return { nce: false, nan: true };
      // A number fallback for a nullish (or falsy) left value: never
      // undefined. The left value is used as is, so it may be NaN.
      if (
        (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken) &&
        this.host.isNumber(e) &&
        this.plainNumber(e.right, depth + 1) !== null
      )
        return { nce: false, nan: true };
      return null;
    }
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken) {
      const symbol = this.symbolOf(e.name);
      if (symbol && symbol.flags & ts.SymbolFlags.EnumMember && this.host.isNumber(e))
        return { nce: false, nan: false };
      if (
        e.name.text === "length" &&
        (this.host.isString(e.expression) || this.host.hasLength(e.expression))
      )
        return { nce: false, nan: false };
      return null;
    }
    if (ts.isCallExpression(e) && !e.questionDotToken) {
      const callee = e.expression;
      if (ts.isPropertyAccessExpression(callee) && !callee.questionDotToken) {
        if (this.host.isStdlibGlobal(callee.expression, "Math"))
          return { nce: false, nan: !MATH_INTEGER_RESULTS.has(callee.name.text) };
        if (callee.name.text === "charCodeAt" && this.host.isString(callee.expression))
          return { nce: false, nan: true };
      }
      const fn = this.calleeSymbol(e);
      return fn ? this.plainReturn(fn, depth) : null;
    }
    if (ts.isIdentifier(e)) {
      const symbol = this.symbolOf(e);
      const decl = symbol ? this.host.declarationOf(symbol) : undefined;
      if (
        decl &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        ts.isVariableDeclarationList(decl.parent) &&
        decl.parent.flags & ts.NodeFlags.Const &&
        !isJsSourceFile(decl.getSourceFile())
      )
        return this.plainNumber(decl.initializer, depth + 1);
      return null;
    }
    return null;
  }

  /** A function whose every return value is a plain number. */
  private plainReturn(fn: ts.Symbol, depth: number): ValueInfo | null {
    const known = this.pneReturnCache.get(fn);
    if (known !== undefined) return known;
    this.pneReturnCache.set(fn, null);
    const decl = this.eligibleFunction(fn);
    if (!decl?.body || !this.host.returnIsNumber(fn)) return null;
    let result: ValueInfo | null = { nce: false, nan: false };
    ts.walkPreorder(decl.body, (node) => {
      if (!result || !ts.isReturnStatement(node) || this.containingFunction(node) !== decl) return;
      const info = node.expression ? this.plainNumber(node.expression, depth + 1) : null;
      result = info ? { nce: false, nan: result.nan || info.nan } : null;
    });
    this.pneReturnCache.set(fn, result);
    return result;
  }

  // ---- uses ---------------------------------------------------------------

  /** Whether the value's consumer cannot tell undefined from NaN. */
  private useSafe(value: ts.Expression): boolean {
    const e = transparentParent(value);
    const p = e.parent;
    if (!p) return false;
    if (ts.isConditionalExpression(p)) return p.condition === e || this.useSafe(p);
    if (ts.isExpressionStatement(p) || ts.isVoidExpression(p)) return true;
    if (isLoopOrIf(p)) {
      if (ts.isForStatement(p)) return p.condition === e || p.incrementor === e;
      return true;
    }
    if (ts.isPrefixUnaryExpression(p)) {
      return (
        p.operator === ts.SyntaxKind.MinusToken ||
        p.operator === ts.SyntaxKind.PlusToken ||
        p.operator === ts.SyntaxKind.TildeToken ||
        p.operator === ts.SyntaxKind.ExclamationToken
      );
    }
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      const other = p.left === e ? p.right : p.left;
      if (RELATIONAL.has(k) || ARITHMETIC.has(k) || BITWISE.has(k)) return true;
      if (k === ts.SyntaxKind.PlusToken) return this.host.isNumber(other);
      if (EQUALITY.has(k)) {
        const otherInfo = this.sourceInfo(other);
        if (!otherInfo) return false;
        if (!otherInfo.nce) return true;
        const self = this.sourceInfo(e);
        return self !== null && !self.nan && !otherInfo.nan;
      }
      if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken)
        return this.inConditionContext(p);
      if (k === ts.SyntaxKind.CommaToken) return p.left === e || this.useSafe(p);
      if (p.left === e) {
        // Compound assignment reads of a binding: arithmetic.
        return NUMERIC_COMPOUND.has(k) || k === ts.SyntaxKind.PlusEqualsToken;
      }
      if (k === ts.SyntaxKind.EqualsToken) {
        const slot = this.sinkOf(e);
        if (!slot || !this.eligible.has(slot)) return false;
        // The assignment's own value flows on when it is used.
        const outer = transparentParent(p);
        const consumer = outer.parent;
        if (
          !consumer ||
          ts.isExpressionStatement(consumer) ||
          (ts.isForStatement(consumer) &&
            (consumer.incrementor === outer || consumer.initializer === outer))
        )
          return true;
        return this.useSafe(p);
      }
      return (
        NUMERIC_COMPOUND.has(k) ||
        (k === ts.SyntaxKind.PlusEqualsToken && this.host.isNumber(p.left))
      );
    }
    if (ts.isPostfixUnaryExpression(p)) return true;
    if (ts.isVariableDeclaration(p) || ts.isReturnStatement(p)) {
      const slot = this.sinkOf(e);
      return slot !== null && this.eligible.has(slot);
    }
    if (ts.isCallExpression(p) && p.expression !== e) {
      const callee = p.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        !callee.questionDotToken &&
        !p.questionDotToken &&
        (this.host.isStdlibGlobal(callee.expression, "Math") ||
          (callee.name.text === "fromCharCode" &&
            this.host.isStdlibGlobal(callee.expression, "String")))
      )
        return true;
      const slot = this.sinkOf(e);
      return slot !== null && this.eligible.has(slot);
    }
    // A typed-array element read answers undefined for both an undefined
    // and a NaN index (neither names an integer index).
    if (
      ts.isElementAccessExpression(p) &&
      p.argumentExpression === e &&
      this.isReadCandidate(p) &&
      this.host.bytesElemOf(p.expression) !== null
    )
      return true;
    if (ts.isSwitchStatement(p)) {
      return p.caseBlock.clauses.every(
        (clause) => !ts.isCaseClause(clause) || this.plainNumber(clause.expression, 0) !== null,
      );
    }
    return false;
  }

  /** The value of a logical expression is only tested for truthiness. */
  private inConditionContext(node: ts.Expression): boolean {
    const e = transparentParent(node);
    const p = e.parent;
    if (!p) return false;
    if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p))
      return p.expression === e;
    if (ts.isForStatement(p)) return p.condition === e;
    if (ts.isConditionalExpression(p)) return p.condition === e;
    if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isExpressionStatement(p)) return true;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken)
        return this.inConditionContext(p);
    }
    return false;
  }
}
