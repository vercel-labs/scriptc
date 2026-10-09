/* Divergence scan: compile-time-detectable places where a program that
 * compiles will behave differently natively than under Node. Each finding
 * is an SC6xxx warning — never a build failure (`scriptc coverage
 * --fail-on=divergences` opts into failing on them).
 *
 * The scan is deliberately narrow: a finding needs both the construct that
 * differs AND evidence in the program that the difference is observable
 * (a write or identity comparison through a copied object, an
 * order-observing call on the type whose literal is reordered, ...).
 * Ordinary code produces no findings. Syntactic prefilters run first so the
 * checker is only consulted for candidate sites.
 */
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { isNodeModulesPath } from "../resolve.js";
import {
  dateLiteralDivergenceDiag,
  keyOrderDivergenceDiag,
  localeCompareDivergenceDiag,
  unrelatedClassCastDivergenceDiag,
  widthCopyDivergenceDiag,
  type ScrDiagnostic,
} from "../../diagnostics/diagnostic.js";
import { isCollationCovered } from "./collation-repertoire.js";
import type { Lowerer } from "./lowerer.js";

/** How an identity-sensitive binding is used after a copy could replace it. */
interface IdentityUse {
  kind: "write" | "compare";
  /** Source text of the use, e.g. `r.path` or `p === other`. */
  text: string;
}

export function scanDivergences(
  lowerer: Lowerer,
  files: readonly ts.SourceFile[],
): ScrDiagnostic[] {
  const own = files.filter(
    (sf) =>
      !sf.isDeclarationFile && !sf.fileName.endsWith(".json") && !isNodeModulesPath(sf.fileName),
  );
  const out: ScrDiagnostic[] = [];
  const checker = lowerer.checker;

  // ── pass 1: syntactic collection ────────────────────────────────────
  const fnsByName = new Map<string, ts.FunctionLikeDeclaration[]>();
  const calls: ts.CallExpression[] = [];
  const typedDecls: ts.VariableDeclaration[] = [];
  const literals: ts.ObjectLiteralExpression[] = [];
  const observers: ts.Expression[] = [];
  const casts: (ts.AsExpression | ts.TypeAssertion)[] = [];
  const dates: { call: ts.CallExpression | ts.NewExpression; arg: ts.Expression }[] = [];
  const localeCompares: ts.CallExpression[] = [];
  /** binding name → member names assigned through it (`q.a = 2`). */
  const assignedMembers = new Map<string, Set<string>>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body !== undefined &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.parameters.length > 0
    ) {
      const list = fnsByName.get(node.name.text) ?? [];
      list.push(node);
      fnsByName.set(node.name.text, list);
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const member = callee.name.text;
        if (member === "localeCompare" && node.arguments.length === 1) localeCompares.push(node);
        const recv = callee.expression;
        if (ts.isIdentifier(recv)) {
          if (
            (recv.text === "JSON" && member === "stringify") ||
            (recv.text === "Object" &&
              (member === "keys" || member === "values" || member === "entries"))
          ) {
            if (node.arguments[0] !== undefined) observers.push(node.arguments[0]);
          } else if (
            recv.text === "console" &&
            (member === "log" ||
              member === "info" ||
              member === "warn" ||
              member === "error" ||
              member === "debug" ||
              member === "dir")
          ) {
            for (const a of node.arguments) if (!isLiteralLike(a)) observers.push(a);
          } else if (recv.text === "Date" && member === "parse") {
            if (node.arguments[0] !== undefined) dates.push({ call: node, arg: node.arguments[0] });
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Date" &&
        node.arguments?.length === 1
      ) {
        dates.push({ call: node, arg: node.arguments[0]! });
      }
    } else if (ts.isForInStatement(node)) {
      observers.push(node.expression);
    } else if (ts.isVariableDeclaration(node)) {
      if (
        node.type !== undefined &&
        node.initializer !== undefined &&
        isExistingObjectExpression(node.initializer) &&
        ts.isIdentifier(node.name)
      )
        typedDecls.push(node);
    } else if (ts.isObjectLiteralExpression(node)) {
      if (node.properties.length >= 1 && node.properties.every(isPlainProperty))
        literals.push(node);
    } else if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) {
      casts.push(node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression)
    ) {
      const names = assignedMembers.get(node.left.expression.text) ?? new Set<string>();
      names.add(node.left.name.text);
      assignedMembers.set(node.left.expression.text, names);
    }
  };
  // Iterative: absurdly deep nesting must reach the lowering's own fence.
  for (const sf of own) ts.walkPreorder(sf, visit);

  // ── width copies: writes or identity comparisons through a copy ─────
  const usesByFn = new Map<ts.FunctionLikeDeclaration, (IdentityUse | null)[]>();
  const identityUsesOf = (fn: ts.FunctionLikeDeclaration): (IdentityUse | null)[] => {
    let uses = usesByFn.get(fn);
    if (uses === undefined) {
      uses = fn.parameters.map((p) =>
        ts.isIdentifier(p.name) && fn.body !== undefined ? identityUse(fn.body, p.name.text) : null,
      );
      usesByFn.set(fn, uses);
    }
    return uses;
  };
  for (const call of calls) {
    const name = calleeName(call);
    if (name === null) continue;
    const candidates = fnsByName.get(name);
    if (candidates === undefined) continue;
    if (!candidates.some((fn) => identityUsesOf(fn).some((u) => u !== null))) continue;
    const signature = safely(() => checker.getResolvedSignature(call));
    if (signature === undefined) continue;
    const decl = safely(() => checker.signatureDeclaration(signature));
    if (decl === undefined || !candidates.includes(decl as ts.FunctionLikeDeclaration)) continue;
    const fn = decl as ts.FunctionLikeDeclaration;
    const uses = identityUsesOf(fn);
    call.arguments.forEach((arg, i) => {
      const use = uses[i];
      const param = fn.parameters[i];
      if (use === null || use === undefined || param === undefined || param.type === undefined)
        return;
      if (!isExistingObjectExpression(arg)) return;
      const copy = safely(() => widthCopyBetween(lowerer, arg, param.type!));
      if (copy === undefined || copy === null) return;
      out.push(
        widthCopyDivergenceDiag(copy.source, copy.target, use.kind, use.text, "call", locOf(arg)),
      );
    });
  }
  for (const decl of typedDecls) {
    const name = (decl.name as ts.Identifier).text;
    const scope = enclosingScope(decl);
    if (scope === undefined) continue;
    const use = identityUse(scope, name, decl.end);
    if (use === null) continue;
    const copy = safely(() => widthCopyBetween(lowerer, decl.initializer!, decl.type!));
    if (copy === undefined || copy === null) continue;
    out.push(
      widthCopyDivergenceDiag(
        copy.source,
        copy.target,
        use.kind,
        use.text,
        "declaration",
        locOf(decl.initializer!),
      ),
    );
  }

  // ── key order: a reordered literal that reaches an order observer ───
  // Local flow only: the observer's argument is the literal itself, or a
  // const/let binding initialized with it in the same file. A type that
  // some other value of it is observed elsewhere is not evidence.
  if (observers.length > 0) {
    const reported = new Set<ts.Node>();
    for (const expr of observers) {
      let inner: ts.Expression = expr;
      while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner))
        inner = inner.expression;
      let lit: ts.ObjectLiteralExpression | null = null;
      let binding: string | null = null;
      if (ts.isObjectLiteralExpression(inner)) lit = inner;
      else if (ts.isIdentifier(inner)) {
        const symbol = safely(() => checker.getSymbolAtLocation(inner));
        const decl = symbol === undefined ? undefined : checker.valueDeclarationOf(symbol);
        if (
          decl !== undefined &&
          ts.isVariableDeclaration(decl) &&
          decl.initializer !== undefined &&
          ts.isObjectLiteralExpression(decl.initializer) &&
          decl.getSourceFile() === inner.getSourceFile()
        ) {
          lit = decl.initializer;
          binding = inner.text;
        }
      }
      if (lit === null || reported.has(lit) || !literals.includes(lit)) continue;
      const contextual = safely(() => checker.getContextualType(lit!));
      if (contextual === undefined) continue;
      if (namedObjectDeclaration(checker, contextual) === null) continue;
      const declared = safely(() => checker.getPropertiesOfType(contextual).map((p) => p.name));
      if (declared === undefined) continue;
      const written = lit.properties.map((p) => propertyNameText(p)!);
      const assigned =
        binding === null ? new Set<string>() : (assignedMembers.get(binding) ?? new Set<string>());
      const finding = keyOrderFinding(lowerer, contextual, declared, written, assigned);
      if (finding === null) continue;
      reported.add(lit);
      out.push(
        keyOrderDivergenceDiag(
          checker.typeToString(contextual),
          finding.node,
          finding.native,
          finding.detail,
          locOf(lit),
        ),
      );
    }
  }

  // ── one-argument localeCompare over text outside the collation table ─
  for (const call of localeCompares) {
    const access = call.expression as ts.PropertyAccessExpression;
    for (const operand of [access.expression, call.arguments[0]!]) {
      const text = stringLiteralText(operand);
      if (text !== null && !isCollationCovered(text)) {
        out.push(localeCompareDivergenceDiag(text, locOf(operand)));
        break;
      }
    }
  }

  // ── downcasts a call provably feeds a sibling class ────────────────
  // `function read(n: Base) { (n as A).x }` called with a `B` (B extends
  // Base, unrelated to A): Node reads the member structurally, natively
  // the checked class cast throws a TypeError.
  const downcasts = new Map<
    ts.Node,
    { index: number; target: ts.ClassLikeDeclaration; cast: ts.Node; member: string }[]
  >();
  for (const cast of casts) {
    let inner: ts.Expression = cast.expression;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (!ts.isIdentifier(inner)) continue;
    let fn: ts.Node | undefined = cast.parent;
    while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
    if (fn === undefined || !ts.isFunctionLike(fn)) continue;
    const index = fn.parameters.findIndex(
      (p) => ts.isIdentifier(p.name) && p.name.text === inner.text,
    );
    if (index < 0) continue;
    const target = safely(() => classDeclarationOfTypeNode(lowerer, cast.type));
    if (target === undefined || target === null) continue;
    // A function that tests the parameter with instanceof guards its casts.
    if (fn.body !== undefined && testsInstanceof(fn.body, inner.text)) continue;
    // The member read through the cast: `(p as A).member`.
    let use: ts.Node = cast;
    while (use.parent !== undefined && ts.isParenthesizedExpression(use.parent)) use = use.parent;
    const access = use.parent;
    if (access === undefined || !ts.isPropertyAccessExpression(access) || access.expression !== use)
      continue;
    const list = downcasts.get(fn) ?? [];
    list.push({ index, target, cast, member: access.name.text });
    downcasts.set(fn, list);
  }
  if (downcasts.size > 0) {
    for (const call of calls) {
      const name = calleeName(call);
      if (name === null || !fnsByName.has(name)) continue;
      const signature = safely(() => checker.getResolvedSignature(call));
      const decl =
        signature === undefined ? undefined : safely(() => checker.signatureDeclaration(signature));
      const sites = decl === undefined ? undefined : downcasts.get(decl);
      if (sites === undefined) continue;
      for (const site of sites) {
        const arg = call.arguments[site.index];
        if (arg === undefined) continue;
        const argType = safely(() => checker.getTypeAtLocation(arg));
        const source = argType === undefined ? null : classDeclarationOfType(checker, argType);
        if (source === null || source === site.target) continue;
        if (
          classExtends(lowerer, source, site.target) ||
          classExtends(lowerer, site.target, source)
        )
          continue;
        // Node's structural read succeeds only when the instance has the
        // member; a missing method fails under Node too.
        if (argType === undefined || checker.getPropertyOfType(argType, site.member) === undefined)
          continue;
        out.push(
          unrelatedClassCastDivergenceDiag(className(source), className(site.target), locOf(arg)),
        );
      }
    }
  }

  // ── Date strings the native parser does not accept ────────────────
  for (const { call, arg } of dates) {
    const callee = ts.isNewExpression(call)
      ? call.expression
      : ts.isPropertyAccessExpression(call.expression)
        ? call.expression.expression
        : undefined;
    if (callee === undefined || !lowerer.isStdlibGlobal(callee, "Date")) continue;
    for (const literal of dateStringLiterals(checker, arg)) {
      const text = stringLiteralText(literal)!;
      if (nativeDateParses(text) || !/\d/.test(text)) continue;
      out.push(dateLiteralDivergenceDiag(text, locOf(literal)));
    }
  }

  return out;
}

/** The string literals a Date argument can be: the literal itself, or
 * each element of a const array of literals a for-of binding iterates. */
function dateStringLiterals(checker: ts.TypeChecker, arg: ts.Expression): ts.Expression[] {
  if (stringLiteralText(arg) !== null) return [arg];
  if (!ts.isIdentifier(arg)) return [];
  const symbol = safely(() => checker.getSymbolAtLocation(arg));
  const decl = symbol === undefined ? undefined : checker.valueDeclarationOf(symbol);
  const list = decl?.parent;
  const loop = list?.parent;
  if (
    decl === undefined ||
    !ts.isVariableDeclaration(decl) ||
    list === undefined ||
    loop === undefined ||
    !ts.isForOfStatement(loop) ||
    loop.initializer !== list
  )
    return [];
  let iterated: ts.Expression = loop.expression;
  if (ts.isIdentifier(iterated)) {
    const source = safely(() => checker.getSymbolAtLocation(iterated));
    const init = source === undefined ? undefined : checker.valueDeclarationOf(source);
    if (init === undefined || !ts.isVariableDeclaration(init) || init.initializer === undefined)
      return [];
    if (init.parent === undefined || (init.parent.flags & ts.NodeFlags.Const) === 0) return [];
    iterated = init.initializer;
  }
  if (!ts.isArrayLiteralExpression(iterated)) return [];
  return iterated.elements.filter((e) => stringLiteralText(e) !== null);
}

/** A checker query that fails here only loses a warning. */
function safely<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function isLiteralLike(node: ts.Expression): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

function stringLiteralText(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** An expression that denotes an object that already exists (and so has
 * other references a copy would not update), not a fresh value. */
function isExistingObjectExpression(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword
  );
}

function isPlainProperty(p: ts.ObjectLiteralElementLike): boolean {
  return (
    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
    propertyNameText(p) !== null
  );
}

function propertyNameText(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return null;
  const name = p.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** The first write through, or identity comparison of, the binding `name`
 * inside `root` (after `from`, when given). Name-based: a nested function
 * that rebinds the name is skipped. */
function identityUse(root: ts.Node, name: string, from = -1): IdentityUse | null {
  let found: IdentityUse | null = null;
  const isRef = (node: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
      node = node.expression;
    return ts.isIdentifier(node) && node.text === name;
  };
  const rootOf = (node: ts.Expression): ts.Expression => {
    let cur = node;
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
      cur = cur.expression;
    return cur;
  };
  const textOf = (node: ts.Node): string => {
    const text = node.getText();
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  };
  const visit = (node: ts.Node): "skip" | "stop" | undefined => {
    if (found !== null) return "stop";
    if (node.pos < from) return node.end > from ? undefined : "skip";
    if (
      node !== root &&
      ts.isFunctionLike(node) &&
      node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)
    )
      return "skip";
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsToken) &&
        (isRef(node.left) || isRef(node.right)) &&
        !isNullish(node.left) &&
        !isNullish(node.right)
      ) {
        found = { kind: "compare", text: textOf(node) };
        return "stop";
      }
      if (
        op >= ts.SyntaxKind.FirstAssignment &&
        op <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        isRef(rootOf(node.left))
      ) {
        found = { kind: "write", text: textOf(node.left) };
        return "stop";
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand)) &&
      isRef(rootOf(node.operand))
    ) {
      found = { kind: "write", text: textOf(node.operand) };
      return "stop";
    }
    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      isRef(rootOf(node.expression))
    ) {
      found = { kind: "write", text: textOf(node.expression) };
      return "stop";
    }
    return undefined;
  };
  ts.walkPreorder(root, visit);
  return found;
}

function testsInstanceof(root: ts.Node, name: string): boolean {
  let found = false;
  ts.walkPreorder(root, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

function isNullish(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}

function enclosingScope(node: ts.Node): ts.Node | undefined {
  let cur = node.parent;
  while (cur !== undefined && !ts.isBlock(cur) && !ts.isSourceFile(cur)) cur = cur.parent;
  return cur;
}

/** A plain-record width copy between the value at `source` and the
 * declared `targetNode` type: both are object types that are not class
 * instances, arrays, functions or built-in containers, and the target's
 * properties are a strict subset of the source's — the shape scriptc
 * compiles as a field copy. */
function widthCopyBetween(
  lowerer: Lowerer,
  source: ts.Expression,
  targetNode: ts.TypeNode,
): { source: string; target: string } | null {
  const checker = lowerer.checker;
  const s = checker.getTypeAtLocation(source);
  const t = checker.getTypeFromTypeNode(targetNode);
  if (!isPlainRecordType(checker, s) || !isPlainRecordType(checker, t)) return null;
  // Accessor members write through to captured state, so a copy of them
  // still observes the same writes: no divergence to report.
  const accessor = ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor;
  if (checker.getPropertiesOfType(s).some((p) => (p.flags & accessor) !== 0)) return null;
  const sourceProps = new Set(checker.getPropertiesOfType(s).map((p) => p.name));
  const targetProps = checker.getPropertiesOfType(t).map((p) => p.name);
  if (targetProps.length === 0 || targetProps.length >= sourceProps.size) return null;
  if (!targetProps.every((p) => sourceProps.has(p))) return null;
  return { source: checker.typeToString(s), target: checker.typeToString(t) };
}

function isPlainRecordType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return false;
  if (checker.getCallSignatures(type).length > 0) return false;
  if (checker.getConstructSignatures(type).length > 0) return false;
  if (checker.getIndexInfosOfType(type).length > 0) return false;
  const symbol = type.getSymbol();
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0) return false;
  // Library-declared object types (Map, Date, Promise, ...) are not records.
  const decls = symbol === undefined ? [] : checker.declarationsOf(symbol);
  if (decls.some((d) => d.getSourceFile().isDeclarationFile)) return false;
  return true;
}

/** The interface/type-alias/literal declaration that names an object type,
 * or null for anything else (classes keep their own layout rules). */
function namedObjectDeclaration(checker: ts.TypeChecker, type: ts.Type): ts.Node | null {
  if ((type.flags & ts.TypeFlags.Object) === 0) return null;
  const alias = type.getAliasSymbol();
  const symbol = alias ?? type.getSymbol();
  if (symbol === undefined) return null;
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return null;
  const decl = checker.declarationsOf(symbol)[0];
  if (decl === undefined || decl.getSourceFile().isDeclarationFile) return null;
  return decl;
}

function keyOrderFinding(
  lowerer: Lowerer,
  contextual: ts.Type,
  declared: readonly string[],
  written: readonly string[],
  assignedNames: ReadonlySet<string>,
): { native: string; node: string; detail: "reordered" | "added-later" } | null {
  const present = declared.filter((name) => written.includes(name));
  const writtenKnown = written.filter((name) => declared.includes(name));
  if (present.join("\0") !== writtenKnown.join("\0") && writtenKnown.length >= 2) {
    return { native: present.join(", "), node: writtenKnown.join(", "), detail: "reordered" };
  }
  // An optional property the literal leaves out but the program assigns
  // later: Node appends it after the literal's keys; natively it keeps its
  // declared slot ahead of them.
  const checker = lowerer.checker;
  for (let i = 0; i < declared.length; i++) {
    const name = declared[i]!;
    if (written.includes(name) || !assignedNames.has(name)) continue;
    if (!declared.slice(i + 1).some((later) => written.includes(later))) continue;
    const prop = checker.getPropertyOfType(contextual, name);
    if (prop === undefined || (prop.flags & ts.SymbolFlags.Optional) === 0) continue;
    const nodeOrder = [...writtenKnown, name];
    const nativeOrder = declared.filter((d) => nodeOrder.includes(d));
    return { native: nativeOrder.join(", "), node: nodeOrder.join(", "), detail: "added-later" };
  }
  return null;
}

function classDeclarationOfTypeNode(
  lowerer: Lowerer,
  node: ts.TypeNode,
): ts.ClassLikeDeclaration | null {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(node.typeName);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Class) === 0) return null;
  const decl = lowerer.checker
    .declarationsOf(symbol)
    .find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
  if (decl === undefined || decl.getSourceFile().isDeclarationFile) return null;
  return decl as ts.ClassLikeDeclaration;
}

function classDeclarationOfType(
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.ClassLikeDeclaration | null {
  const symbol = type.getSymbol();
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Class) === 0) return null;
  const decl = checker
    .declarationsOf(symbol)
    .find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
  if (decl === undefined || decl.getSourceFile().isDeclarationFile) return null;
  return decl as ts.ClassLikeDeclaration;
}

/** Whether `sub` names `base` in its (transitive) extends chain. */
function classExtends(
  lowerer: Lowerer,
  sub: ts.ClassLikeDeclaration,
  base: ts.ClassLikeDeclaration,
): boolean {
  let cur: ts.ClassLikeDeclaration | null = sub;
  for (let guard = 0; cur !== null && guard < 64; guard++) {
    if (cur === base) return true;
    const heritage = cur.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    const expr = heritage?.types[0]?.expression;
    if (expr === undefined) return false;
    const symbol = lowerer.checker.getSymbolAtLocation(expr);
    if (symbol === undefined) return false;
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? lowerer.checker.getAliasedSymbol(symbol)
        : symbol;
    const decl = lowerer.checker
      .declarationsOf(resolved)
      .find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
    cur = decl === undefined ? null : (decl as ts.ClassLikeDeclaration);
  }
  return false;
}

function className(decl: ts.ClassLikeDeclaration): string {
  return decl.name?.text ?? "(anonymous class)";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The date-string grammar the native runtime accepts (scr_lib.c
 * scr_date_parse_get_time): ECMAScript's date-time format with an explicit
 * offset (date-only forms are UTC) and the certificate-time shape
 * "Mon DD HH:MM:SS YYYY GMT". Everything else parses to NaN natively. */
export function nativeDateParses(text: string): boolean {
  const iso =
    /^(?:[+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.test(text) ||
    /^(?:[+-]\d{6}|\d{4})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      text,
    );
  if (iso) return true;
  const cert = /^([A-Za-z]{3}) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4} GMT$/.exec(text);
  return cert !== null && MONTHS.includes(cert[1]!.toLowerCase());
}
