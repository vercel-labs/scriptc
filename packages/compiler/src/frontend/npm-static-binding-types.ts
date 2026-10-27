import * as ts from "./ts7/adapter.js";
import { npmStaticPackageOfPath } from "./npm-static.js";
import { isJsSourceFileName } from "./tsc-codes.js";
import { hasJsTypeAnnotation } from "./lowering/lower-stmts.js";

/** Types for the variables of `--npm-static` JavaScript that the checker
 * leaves `any` (`var currentView = null`, later holding a Uint8Array): the
 * union of every value the program writes to the variable, written into
 * the source as a JSDoc type the lowering then compiles.
 *
 * The checker's types are not evidence here: in unchecked JavaScript any
 * code can write anything into a property or a variable the checker typed
 * from its first assignment. A written value is typed only by what its
 * syntax guarantees (a literal, an operator's result, a standard-library
 * construction, a String/Number/Boolean conversion) or by the variable it
 * comes from, whose own writes the analysis follows the same way. Every
 * write must be visible: the initializer (or undefined without one), `=`,
 * compound assignments and increments. A variable gets a type only when all
 * its writes are typed and name one type, beside null or undefined. A
 * destructuring or loop write leaves it untouched, as does a file that
 * uses `eval` or `with`. The texts are keyed by file, with each annotation
 * inserted on its variable's line.
 *
 * Parameters are not typed yet: a typed argument specializes the callee's
 * instance, and a typed instance can reach forms only the checked-dynamic
 * lowering supports. */
export function npmStaticBindingTypes(program: ts.Program): Map<string, string> {
  const texts = new Map<string, string>();
  for (const sf of program.getSourceFiles()) {
    if (!isJsSourceFileName(sf.fileName) || npmStaticPackageOfPath(sf.fileName) === null) continue;
    const text = annotateFile(program.getTypeChecker(), sf);
    if (text !== null) texts.set(sf.fileName, text);
  }
  return texts;
}

interface Candidate {
  name: ts.Identifier;
  /** Whether the variable takes an annotation: the checker types it `any`
   * and nothing annotates it. Other variables only carry types onward. */
  annotate: boolean;
  types: Set<string> | null;
  /** Variables whose values flow into this one (`x = y`). */
  from: Candidate[];
  /** A use a nullable type has no typed lowering for (blocksNullable). */
  nullableBlocked: boolean;
  /** The checker's type of a variable it already types (`"const"` for a
   * const): the variable takes an annotation only for that same proven
   * primitive, which its lowering otherwise holds checked-dynamic when a
   * write looks untyped (`writtenBytes += result.written`). */
  checkerTyped?: string;
}

type WriteValue = (target: Candidate, expr: ts.Expression) => void;

function annotateFile(checker: ts.TypeChecker, sf: ts.SourceFile): string | null {
  if (/\beval\s*\(|\bwith\s*\(/.test(sf.text)) return null;
  const byName = new Map<string, Map<ts.Symbol, Candidate>>();
  const register = (name: ts.Identifier, annotate: boolean): Candidate | null => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol || !symbol.declarations?.every((d) => ts.isVariableDeclaration(d))) return null;
    let named = byName.get(name.text);
    if (!named) byName.set(name.text, (named = new Map()));
    let candidate = named.get(symbol);
    if (!candidate) {
      candidate = { name, annotate, types: new Set(), from: [], nullableBlocked: false };
      named.set(symbol, candidate);
    }
    return candidate;
  };
  const isAny = (name: ts.Identifier): boolean =>
    (checker.getTypeAtLocation(name).flags & ts.TypeFlags.Any) !== 0;
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclarationList(node) &&
      !ts.isForInStatement(node.parent) &&
      !ts.isForOfStatement(node.parent)
    ) {
      for (const decl of node.declarations.nodes) {
        if (!ts.isIdentifier(decl.name)) continue;
        const annotated = hasJsTypeAnnotation(decl);
        const candidate = register(decl.name, !annotated);
        if (candidate && !isAny(decl.name))
          candidate.checkerTyped =
            node.flags & ts.NodeFlags.Const
              ? "const"
              : checker.typeToString(checker.getTypeAtLocation(decl.name));
        if (candidate && annotated) candidate.types = null;
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  if (byName.size === 0) return null;
  const candidateOf = (expr: ts.Expression): Candidate | undefined => {
    if (!ts.isIdentifier(expr)) return undefined;
    const named = byName.get(expr.text);
    const symbol = named && checker.getSymbolAtLocation(expr);
    return symbol && named.get(symbol);
  };
  const calls: { target: Candidate; call: ts.Expression; receiver: Candidate }[] = [];
  // Function declarations' results: what every return yields, and
  // undefined when the body can end without returning.
  const results = new Map<ts.Symbol, Candidate>();
  const collectFunctions = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      !node.asteriskToken &&
      !node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol && symbol.declarations?.length === 1)
        results.set(symbol, {
          name: node.name,
          annotate: false,
          types: new Set(),
          from: [],
          nullableBlocked: false,
        });
    }
    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(sf);
  const write: WriteValue = (target, expr) => {
    if (!target.types) return;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const symbol = checker.getSymbolAtLocation(expr.expression);
      const result = symbol && results.get(symbol);
      if (result) {
        target.from.push(result);
        return;
      }
    }
    // A binding this inference already typed carries its proven type.
    const source =
      ts.isIdentifier(expr) && inferredBinding(checker, expr) ? undefined : candidateOf(expr);
    // A standard method called on another variable (`encoder.encodeInto(s,
    // v)`): its result is typed once that variable's own writes are.
    const root = source ? null : memberChainRoot(checker, expr);
    if (root && !inferredBinding(checker, root)) {
      const receiver = candidateOf(root);
      if (receiver) {
        calls.push({ target, call: expr, receiver });
        return;
      }
    }
    if (source) {
      if (source !== target) target.from.push(source);
      return;
    }
    // A value chosen between operands holds one of theirs.
    if (ts.isConditionalExpression(expr)) {
      write(target, expr.whenTrue);
      write(target, expr.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        write(target, expr.left);
        write(target, expr.right);
        return;
      }
      if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) {
        write(target, expr.right);
        return;
      }
    }
    const written = syntacticTypes(checker, expr);
    if (written === null) target.types = null;
    else for (const t of written) target.types.add(t);
  };
  for (const [symbol, result] of results) {
    const fn = symbol.declarations![0] as ts.FunctionDeclaration;
    const returns = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        if (node.expression) write(result, node.expression);
        else result.types?.add("undefined");
      }
      ts.forEachChild(node, returns);
    };
    ts.forEachChild(fn.body!, returns);
    const last = fn.body!.statements.nodes.at(-1);
    if (!last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last)))
      result.types?.add("undefined");
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      // A function whose name is rebound has no single result.
      const fnSymbol = results.size > 0 ? checker.getSymbolAtLocation(node) : undefined;
      const result = fnSymbol && results.get(fnSymbol);
      if (
        result &&
        (isWriteTarget(node) || (ts.isBinaryExpression(node.parent) && node.parent.left === node))
      )
        result.types = null;
      const candidate = candidateOf(node);
      if (candidate?.types) {
        if (blocksNullable(node)) candidate.nullableBlocked = true;
        noteBindingUse(checker, candidate, node, write);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Values flowing between variables: a source's types reach its targets,
  // and an untyped source leaves them untyped.
  const all = [...byName.values()]
    .flatMap((named) => [...named.values()])
    .concat([...results.values()]);
  const propagate = (): void => {
    for (let changed = true; changed;) {
      changed = false;
      for (const target of all) {
        for (const source of target.from) {
          if (!target.types) break;
          if (!source.types) {
            target.types = null;
            changed = true;
            break;
          }
          for (const t of source.types) {
            if (target.types.has(t)) continue;
            target.types.add(t);
            changed = true;
          }
        }
      }
    }
  };
  propagate();
  // Method results on variables whose types are now proven, which can
  // type further variables: a call resolves once its receiver waits on no
  // unresolved call.
  let pending = calls;
  while (pending.length > 0) {
    const waiting = new Set(pending.map((entry) => entry.target));
    const ready = pending.filter((entry) => !waiting.has(entry.receiver));
    if (ready.length === 0) {
      for (const entry of pending) entry.target.types = null;
      break;
    }
    for (const entry of ready) {
      if (!entry.target.types) continue;
      const result = entry.receiver.types ? checkerTypes(checker, entry.call) : null;
      if (result === null) entry.target.types = null;
      else for (const t of result) entry.target.types.add(t);
    }
    propagate();
    pending = pending.filter((entry) => !ready.includes(entry));
  }
  const inserts: { offset: number; text: string }[] = [];
  for (const { name, annotate, types, nullableBlocked, checkerTyped } of all) {
    if (!annotate || !types) continue;
    // A variable the checker types already takes only the same primitive
    // or typed-array type, which changes no type (a literal type stays as
    // declared) but keeps storage a JavaScript call result would make
    // checked-dynamic (`var chunk = stringToPrecomputedChunk("<p")`).
    if (
      checkerTyped !== undefined &&
      !(
        types.size === 1 &&
        [...types][0] === checkerTyped &&
        (PRIMITIVE.test(checkerTyped) || TYPED_ARRAY.test(checkerTyped))
      )
    )
      continue;
    const present = [...types].filter((t) => t !== "null" && t !== "undefined");
    if (present.length !== 1) continue;
    if (nullableBlocked && present.length < types.size) continue;
    const union = [...present, ...[...types].filter((t) => !present.includes(t)).sort()].join(
      " | ",
    );
    inserts.push({ offset: ts.tokenStartOfNode(name), text: `/** @type {${union}} @inferred */ ` });
  }
  if (inserts.length === 0) return null;
  let text = sf.text;
  for (const insert of inserts.sort((a, b) => b.offset - a.offset))
    text = text.slice(0, insert.offset) + insert.text + text.slice(insert.offset);
  return text;
}

/** What an occurrence of a variable writes to it: nothing for a read, and
 * an untyped value for a write this analysis cannot follow. */
function noteBindingUse(
  checker: ts.TypeChecker,
  candidate: Candidate,
  id: ts.Identifier,
  write: WriteValue,
): void {
  const types = candidate.types!;
  const parent = id.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === id) {
    if (parent.initializer) write(candidate, parent.initializer);
    else types.add("undefined");
    return;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    const op = parent.operator;
    // ++ and -- answer a number, or a bigint for a bigint binding, which
    // its other writes then name.
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken)
      types.add("number");
    return;
  }
  if (ts.isBinaryExpression(parent) && parent.left === id) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      write(candidate, parent.right);
      return;
    }
    if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment) {
      // `x op= v` holds what `x op v` answers.
      const result = compoundResult(checker, op, parent.right);
      if (result === null) candidate.types = null;
      else types.add(result);
    }
    return;
  }
  if (isWriteTarget(id)) candidate.types = null;
}

/** The type `x op= right` stores: a string for `+=` with a string, and
 * otherwise a number when the operator always answers one or right is a
 * number (a bigint x throws). `x += 1` answers a string only for a string
 * or object x, and such a binding names a second type, so it stays
 * untyped either way. */
function compoundResult(
  checker: ts.TypeChecker,
  op: ts.SyntaxKind,
  right: ts.Expression,
): string | null {
  const known = syntacticTypes(checker, right);
  const operand = literalKind(right) ?? (known?.length === 1 ? known[0]! : null);
  if (op === ts.SyntaxKind.PlusEqualsToken)
    return operand === "string" || operand === "number" ? operand : null;
  if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken) return "number";
  if (
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.QuestionQuestionEqualsToken
  )
    return null;
  return operand === "number" ? "number" : null;
}

/** Whether a nullable type could not lower this occurrence: anything but
 * a member read or method call through it, a comparison, a truth test,
 * `typeof`, or passing the value on (an argument, a returned or assigned
 * value). */
function blocksNullable(id: ts.Identifier): boolean {
  if (ts.isVariableDeclaration(id.parent) && id.parent.name === id) return false;
  let node: ts.Node = id;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    const use = parent.parent;
    if (ts.isCallExpression(use) && use.expression === parent) return false;
    return (
      (ts.isBinaryExpression(use) &&
        use.left === parent &&
        use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        use.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use)) &&
        (use.operator === ts.SyntaxKind.PlusPlusToken ||
          use.operator === ts.SyntaxKind.MinusMinusToken)) ||
      ts.isDeleteExpression(use)
    );
  }
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      parent.left === node &&
      op >= ts.SyntaxKind.FirstAssignment &&
      op <= ts.SyntaxKind.LastAssignment
    )
      return false;
    return !(
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.CommaToken ||
      (op === ts.SyntaxKind.EqualsToken && parent.right === node && ts.isIdentifier(parent.left))
    );
  }
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator !== ts.SyntaxKind.ExclamationToken;
  return !(
    ts.isTypeOfExpression(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isExpressionStatement(parent) ||
    (ts.isCallExpression(parent) && parent.expression !== node) ||
    (ts.isVariableDeclaration(parent) && (parent.name === node || ts.isIdentifier(parent.name))) ||
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      parent.expression === node) ||
    (ts.isConditionalExpression(parent) && parent.condition === node)
  );
}

/** Whether the occurrence is assigned by a destructuring pattern or a
 * for-in/of head. */
function isWriteTarget(id: ts.Identifier): boolean {
  let node: ts.Node = id;
  for (;;) {
    const parent = node.parent;
    if (!parent) return false;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      node = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent))
      return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    if (ts.isForInStatement(parent) || ts.isForOfStatement(parent))
      return parent.initializer === node;
    return false;
  }
}

/** The type a value's syntax guarantees, whatever the program wrote
 * elsewhere: literals, operator results, standard-library constructions,
 * and String/Number/Boolean conversions. Null for anything else. */
function syntacticTypes(checker: ts.TypeChecker, expr: ts.Expression): string[] | null {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  const literal = literalKind(expr);
  if (literal) return [literal];
  if (ts.isIdentifier(expr) && expr.text === "undefined" && isStdlibValue(checker, expr))
    return ["undefined"];
  if (ts.isVoidExpression(expr)) return ["undefined"];
  if (ts.isTypeOfExpression(expr)) return ["string"];
  if (ts.isDeleteExpression(expr)) return ["boolean"];
  if (ts.isPrefixUnaryExpression(expr)) {
    if (expr.operator === ts.SyntaxKind.ExclamationToken) return ["boolean"];
    if (expr.operator === ts.SyntaxKind.PlusToken) return ["number"];
    return null;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.InstanceOfKeyword ||
      op === ts.SyntaxKind.InKeyword
    )
      return ["boolean"];
    const left = syntacticTypes(checker, expr.left);
    const right = syntacticTypes(checker, expr.right);
    const only = (types: string[] | null, t: string): boolean =>
      types?.length === 1 && types[0] === t;
    if (op === ts.SyntaxKind.PlusToken) {
      if (only(left, "string") || only(right, "string")) return ["string"];
      return only(left, "number") && only(right, "number") ? ["number"] : null;
    }
    if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) return ["number"];
    if (
      op === ts.SyntaxKind.MinusToken ||
      op === ts.SyntaxKind.AsteriskToken ||
      op === ts.SyntaxKind.SlashToken ||
      op === ts.SyntaxKind.PercentToken ||
      op === ts.SyntaxKind.AsteriskAsteriskToken ||
      op === ts.SyntaxKind.AmpersandToken ||
      op === ts.SyntaxKind.BarToken ||
      op === ts.SyntaxKind.CaretToken ||
      op === ts.SyntaxKind.LessThanLessThanToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanToken
    )
      // A number operand makes the result a number: mixing in a bigint
      // throws.
      return only(left, "number") || only(right, "number") ? ["number"] : null;
    return null;
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    isStdlibValue(checker, expr.expression)
  ) {
    const conversion = { String: "string", Number: "number", Boolean: "boolean" }[
      expr.expression.text
    ];
    return conversion ? [conversion] : null;
  }
  // A binding this inference typed in an earlier round, and a standard
  // method's result on one (`currentView.subarray(n)`): their types are the
  // ones the inference proved.
  if (proven(checker, expr)) return checkerTypes(checker, expr);
  if (
    ts.isNewExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    isStdlibValue(checker, expr.expression.name)
  )
    return checkerTypes(checker, expr);
  if (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    isStdlibValue(checker, expr.expression)
  ) {
    const type = checker.getTypeAtLocation(expr);
    const text = checker.typeToString(type);
    return /^[A-Z][A-Za-z0-9]*(<[A-Za-z]+>)?$/.test(text) && isStdlibType(type) ? [text] : null;
  }
  return null;
}

/** The primitive a literal is. */
function literalKind(expr: ts.Expression): string | null {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isNumericLiteral(expr)) return "number";
  if (ts.isBigIntLiteral(expr)) return "bigint";
  if (
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isTemplateExpression(expr)
  )
    return "string";
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword)
    return "boolean";
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  )
    return "number";
  return null;
}

const PRIMITIVE = /^(number|string|boolean|bigint|null|undefined)$/;
const TYPED_ARRAY =
  /^(?:Uint8|Int8|Uint8Clamped|Uint16|Int16|Uint32|Int32|Float32|Float64|BigInt64|BigUint64)Array(?:<[A-Za-z]+>)?$/;

/** The variable a chain of standard members starts from (`encoder` in
 * `encoder.encodeInto(s, v).written`), or null. */
function memberChainRoot(checker: ts.TypeChecker, expr: ts.Expression): ts.Identifier | null {
  let node = expr;
  let steps = 0;
  for (;;) {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isCallExpression(node)) {
      node = node.expression;
      continue;
    }
    if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) break;
    if (!isStdlibValue(checker, node.name)) return null;
    node = node.expression;
    steps++;
  }
  return steps > 0 && ts.isIdentifier(node) ? node : null;
}

/** Whether a value's checker type is proven: a variable this inference
 * typed, a standard method's result on a proven value, or a standard
 * member of one (`encoder.encodeInto(s, v).written`). */
function proven(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isIdentifier(expr)) return inferredBinding(checker, expr);
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      !callee.questionDotToken &&
      isStdlibValue(checker, callee.name) &&
      proven(checker, callee.expression)
    );
  }
  return (
    ts.isPropertyAccessExpression(expr) &&
    !expr.questionDotToken &&
    isStdlibValue(checker, expr.name) &&
    proven(checker, expr.expression)
  );
}

/** Whether a name is a variable whose JSDoc type this inference wrote. */
function inferredBinding(checker: ts.TypeChecker, id: ts.Identifier): boolean {
  const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (!decl || !ts.isVariableDeclaration(decl)) return false;
  const sf = ts.getSourceFileOfNode(decl);
  return /@inferred \*\/\s*$/.test(
    sf.text.slice(Math.max(0, ts.tokenStartOfNode(decl) - 200), ts.tokenStartOfNode(decl)),
  );
}

/** The checker's types of a value whose type is proven, when each part is
 * a primitive or a standard-library class; null otherwise. */
function checkerTypes(checker: ts.TypeChecker, expr: ts.Expression): string[] | null {
  const type = checker.getTypeAtLocation(expr);
  const parts = type.flags & ts.TypeFlags.Union ? ts.constituentTypes(type) : [type];
  const out: string[] = [];
  for (const part of parts) {
    if (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
    const widened = checker.getBaseTypeOfLiteralType(part);
    const text = checker.typeToString(widened);
    if (PRIMITIVE.test(text)) out.push(text);
    else if (
      (/^[A-Z][A-Za-z0-9]*(<[A-Za-z]+>)?$/.test(text) ||
        // A standard result object of primitive fields (encodeInto's).
        /^\{ (?:[A-Za-z_$][\w$]*: (?:number|string|boolean); )+\}$/.test(text)) &&
      isStdlibType(widened)
    )
      out.push(text);
    else return null;
  }
  return out;
}

/** Whether a name resolves to a standard-library declaration, not a local
 * shadowing it. */
function isStdlibValue(checker: ts.TypeChecker, id: ts.Node): boolean {
  const declarations = checker.getSymbolAtLocation(id)?.declarations ?? [];
  return declarations.length > 0 && declarations.every((d) => isLibFile(ts.getSourceFileOfNode(d)));
}

function isStdlibType(type: ts.Type): boolean {
  const declarations = type.getSymbol()?.declarations ?? [];
  return declarations.length > 0 && declarations.every((d) => isLibFile(ts.getSourceFileOfNode(d)));
}

/** The standard library's declarations, Node's included (scriptc's own
 * ambient Node declarations among them). */
function isLibFile(file: ts.SourceFile): boolean {
  return (
    file.isDeclarationFile &&
    (/[\\/]lib\.[^\\/]*\.d\.ts$/.test(file.fileName) ||
      /[\\/]@types[\\/]node[\\/]/.test(file.fileName) ||
      /[\\/]compiler[\\/]ambient[\\/]scriptc[^\\/]*\.d\.ts$/.test(file.fileName))
  );
}
