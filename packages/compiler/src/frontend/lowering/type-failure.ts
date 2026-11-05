/* Localized failure, stage L0 (report-only).
 *
 * A type with no static lowering poisons the slot that holds it (a field,
 * a parameter, a return, a local), and today the poison rejects the whole
 * declaration around the slot: a class, a signature, a declaration
 * statement. Every later use of that declaration then fails on its own
 * line. The localized-failure design turns such slots into checked
 * dynamic slots at the points where the build would otherwise commit the
 * error.
 *
 * This module holds the bookkeeping that stage measures without changing
 * any lowering: where a failing type sits (its slot), whether a dynamic
 * slot would keep the program's meaning (design §3.7), and the keys that
 * tie a cascade diagnostic to the rejected declaration it inherits from.
 * The data rides the committed diagnostics as report-only fields
 * (ScrDiagnostic.typeFailure, .rejects, .cause); tier-analysis.ts turns it
 * into the would-be dynamic slot report of `--explain-dynamic`. */
import type {
  TypeFailure,
  TypeFailureFamily,
  TypeFailureSlot,
} from "../../diagnostics/diagnostic.js";
import * as ts from "../ts7/adapter.js";

/** Families a checked-dynamic slot can hold (design §3.7). The others
 * name values the compiler cannot produce (opaque stdlib and @types/node
 * types, engine-backed ambient types), package value types that scope B
 * routes to Node islands, enum objects with no runtime value, and generic
 * implementations without an erased instance. */
const DEGRADABLE_FAMILIES: ReadonlySet<TypeFailureFamily> = new Set<TypeFailureFamily>([
  "index-signature",
  "overloads",
  "intersection",
  "component",
  "record-member",
  "unsupported",
  "dyn-field-policy",
]);

function nameText(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return ts.getTextOfNode(name);
}

function isParameterProperty(param: ts.ParameterDeclaration): boolean {
  return (
    ts.isConstructorDeclaration(param.parent) &&
    (param.modifiers?.nodes ?? []).some(
      (m) =>
        m.kind === ts.SyntaxKind.PublicKeyword ||
        m.kind === ts.SyntaxKind.PrivateKeyword ||
        m.kind === ts.SyntaxKind.ProtectedKeyword ||
        m.kind === ts.SyntaxKind.ReadonlyKeyword,
    )
  );
}

function variableSlot(decl: ts.VariableDeclaration): TypeFailureSlot {
  const list = decl.parent;
  const holder = list?.parent;
  if (
    holder !== undefined &&
    (ts.isForOfStatement(holder) || ts.isForInStatement(holder) || ts.isForStatement(holder))
  )
    return "loop";
  if (holder !== undefined && ts.isVariableStatement(holder) && ts.isSourceFile(holder.parent))
    return "global";
  return "local";
}

function functionLabel(fn: ts.Node): string {
  if (ts.isConstructorDeclaration(fn)) return "constructor";
  if (ts.isFunctionLikeDeclaration(fn)) {
    const own = nameText(fn.name);
    if (own !== null) return own;
    const parent = fn.parent;
    if (
      parent !== undefined &&
      (ts.isVariableDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent))
    ) {
      const bound = nameText(parent.name);
      if (bound !== null) return bound;
    }
  }
  return "<anonymous>";
}

/** The slot a badType blame node denotes. A declaration's own node, its
 * name and its type annotation name the declaration's slot; anything
 * reached through an expression is an expression slot (the type of a
 * cast, a literal, a temporary). */
export function typeFailureSlot(node: ts.Node): { slot: TypeFailureSlot; name: string } {
  let current: ts.Node = node;
  for (let depth = 0; depth < 64; depth++) {
    if (ts.isParameter(current)) {
      const name = nameText(current.name) ?? "<parameter>";
      return { slot: isParameterProperty(current) ? "field" : "param", name };
    }
    if (ts.isPropertyDeclaration(current))
      return { slot: "field", name: nameText(current.name) ?? "<field>" };
    if (ts.isVariableDeclaration(current))
      return { slot: variableSlot(current), name: nameText(current.name) ?? "<binding>" };
    if (ts.isBindingElement(current)) {
      let owner: ts.Node | undefined = current.parent;
      while (owner !== undefined && !ts.isVariableDeclaration(owner) && !ts.isParameter(owner))
        owner = owner.parent;
      const slot: TypeFailureSlot =
        owner === undefined
          ? "local"
          : ts.isParameter(owner)
            ? "param"
            : variableSlot(owner as ts.VariableDeclaration);
      return { slot, name: nameText(current.name) ?? "<binding>" };
    }
    if (ts.isPropertySignature(current) || ts.isMethodSignatureDeclaration(current))
      return { slot: "member", name: nameText(current.name) ?? "<member>" };
    if (ts.isFunctionLikeDeclaration(current))
      return { slot: "return", name: functionLabel(current) };
    if (ts.isCatchClause(current)) return { slot: "local", name: "<catch binding>" };
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined || ts.isSourceFile(parent)) break;
    // Climb from a declaration's name or type annotation, or from inside a
    // type node; any other position is an expression's own type.
    const declared =
      (ts.isParameter(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isBindingElement(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodSignatureDeclaration(parent) ||
        ts.isFunctionLikeDeclaration(parent)) &&
      ((parent as { name?: ts.Node }).name === current ||
        (parent as { type?: ts.Node }).type === current);
    if (!declared && !ts.isTypeNode(current) && !ts.isTypeNode(parent)) break;
    current = parent;
  }
  // A type node names its expression (`raw as Plugin`, not `Plugin`).
  let named: ts.Node = node;
  while (ts.isTypeNode(named) && named.parent !== undefined && !ts.isSourceFile(named.parent))
    named = named.parent;
  const text = ts.getTextOfNode(named).replace(/\s+/g, " ");
  return { slot: "expression", name: text.length > 60 ? `${text.slice(0, 57)}...` : text };
}

/** Program code outside node_modules, in TypeScript: the code holes apply
 * to (design §3.3, §3.8). JavaScript keeps its dynamic fallback and its
 * runtime fences; npm packages keep island routing. */
function programTypeScript(node: ts.Node): boolean {
  const sf = ts.getSourceFileOfNode(node);
  const file = sf.fileName;
  if (file.includes("/node_modules/")) return false;
  if (sf.isDeclarationFile) return false;
  return !/\.(?:[cm]?js|jsx)$/.test(file);
}

export function typeFailureOf(
  node: ts.Node,
  declaredType: string,
  family: TypeFailureFamily,
): TypeFailure {
  const { slot, name } = typeFailureSlot(node);
  return {
    slot,
    name,
    declaredType,
    family,
    degradable: DEGRADABLE_FAMILIES.has(family) && programTypeScript(node),
  };
}

function locKey(node: ts.Node): string {
  const sf = ts.getSourceFileOfNode(node);
  return `${sf.fileName}:${ts.tokenStartOfNode(node)}`;
}

/** The failure-group key of a deferred declaration (a class shape or a
 * function signature whose collection poisoned). */
export function declarationGroupKey(symbol: ts.Symbol): string {
  const decl = symbol.declarations[0];
  const name = ts.symbolName(symbol);
  if (decl === undefined) return `declaration ${name}`;
  const kind =
    ts.isClassDeclaration(decl) || ts.isClassExpression(decl)
      ? "class"
      : ts.isFunctionLikeDeclaration(decl)
        ? "function"
        : "declaration";
  return `${kind} ${name} @${locKey(decl)}`;
}

/** The failure-group key of a poisoned declaration statement whose
 * bindings are blocked. */
export function statementGroupKey(stmt: ts.Statement): string {
  return `statement @${locKey(stmt)}`;
}
