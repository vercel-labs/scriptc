/* The declaration-typed boundary's projection pass.
 *
 * An opted-in npm package compiles from its JavaScript, and the program the
 * lowering compiles types it from that JavaScript: where the package's
 * published declarations are richer (zod's `z.infer`), user code sees `any`.
 * This pass asks the DECLARATION world (the same entry checked against the
 * packages' declarations) for the types of those user-code positions. Where
 * the declared type is pure data, it is printed as structural TypeScript into
 * a generated global declaration file, and the user file is rewritten in the
 * lowering world:
 *
 * - type positions that name package types (`z.infer<typeof S>`) name the
 *   projected alias instead;
 * - package-produced expressions (`S.parse(x)`, `r.data`) are wrapped in
 *   `(<expr> as __scriptc_decl_N)`, the boundary cast;
 * - untyped parameters of user callbacks the package calls gain the alias.
 *
 * The lowering world is then rebuilt from the rewritten text, so the
 * checker's own inference carries the projected types through the rest of
 * the user code, and the lowering sees an ordinary checked cast at each
 * crossing (lowered with `adopt`, see narrowing.ts). No edit adds or removes
 * a line break, so positions keep their lines. IR records are structural,
 * so a printed type interns to the same shape as any equal type.
 *
 * Only programs whose user code has such positions are rewritten; every
 * other program is untouched (the zero-cost rule). See
 * scriptc-perf/results/design-decl-boundary/DESIGN.md. */

import * as ts from "./ts7/adapter.js";
import { declarationSelector, originAt } from "./lowering/decl-origin.js";

/** Per user file, the origin (lowering/decl-origin.ts) of each boundary
 * cast in source order: the package declaration the cast's type comes
 * from, so a failing cast names it. Set by planDeclProjection, reset per
 * program load. */
const boundaryOrigins = new Map<string, (string | null)[]>();

export function resetDeclBoundaryOrigins(): void {
  boundaryOrigins.clear();
}

/** The origin of the `index`-th boundary cast of a file, or null. */
export function declBoundaryOrigin(fileName: string, index: number): string | null {
  return boundaryOrigins.get(fileName)?.[index] ?? null;
}

/** The package declaration a projected expression's type comes from, in
 * the declaration world. */
function castOrigin(checker: ts.TypeChecker, node: ts.Node, type: ts.Type): string | null {
  let inner = node as ts.Expression;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAwaitExpression(inner) ||
    ts.isNonNullExpression(inner)
  )
    inner = inner.expression;
  let decl: ts.Node | undefined;
  let suffix = "";
  try {
    if (ts.isCallExpression(inner) || ts.isNewExpression(inner)) {
      decl = checker.getResolvedSignature(inner)?.declaration;
      suffix = "()";
    } else {
      const name = ts.isPropertyAccessExpression(inner)
        ? inner.name
        : ts.isIdentifier(inner)
          ? inner
          : null;
      if (name === null) return null;
      let symbol = checker.getSymbolAtLocation(name);
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      decl = symbol?.declarations[0];
    }
    if (decl === undefined) return null;
    const selector = declarationSelector(decl);
    if (selector === null) return null;
    return originAt(decl, `${selector}${suffix}`, checker.typeToString(type));
  } catch {
    return null;
  }
}

/** Alias names of projected types start with this prefix; the lowering
 * recognizes boundary casts and parameters by it. */
export const DECL_BOUNDARY_PREFIX = "__scriptc_decl_";

/** The generated declaration file's base name. */
export const DECL_BOUNDARY_FILE = "__scriptc_decl_boundary__.d.ts";

export function isDeclBoundaryFile(fileName: string): boolean {
  return fileName.split("\\").join("/").endsWith(`/${DECL_BOUNDARY_FILE}`);
}

export function isDeclBoundaryTypeName(name: string): boolean {
  return name.startsWith(DECL_BOUNDARY_PREFIX);
}

/** True for `T` in `x as T` / `(p: T) =>` when T names a projected alias. */
export function isDeclBoundaryTypeNode(node: ts.TypeNode | undefined): boolean {
  return (
    node !== undefined &&
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    isDeclBoundaryTypeName(node.typeName.text) &&
    node.typeArguments === undefined
  );
}

interface Edit {
  start: number;
  end: number;
  text: string;
  /** Tie-break among edits at one position (lower first). */
  rank?: number;
}

export interface DeclProjection {
  /** Rewritten text per user file. */
  files: Map<string, string>;
  /** The generated declaration file (path and text). */
  declFile: string;
  declText: string;
  /** Human-readable plan (SCRIPTC_DEBUG_DECL_BOUNDARY). */
  plan: string[];
}

export interface DeclProjectionInput {
  jsProgram: ts.Program;
  declProgram: ts.Program;
  /** User source files to consider (TypeScript, outside node_modules). */
  userFiles: readonly string[];
  /** Directory of the generated declaration file. */
  outDir: string;
}

function isPackageDeclarationFile(sf: ts.SourceFile | undefined): boolean {
  if (sf === undefined || !sf.isDeclarationFile) return false;
  const f = sf.fileName.split("\\").join("/");
  // The TypeScript standard library ships inside node_modules too.
  if (/(^|\/)lib(\.[\w.-]+)?\.d\.ts$/.test(f) || f.startsWith("bundled:")) return false;
  return (
    f.includes("/node_modules/") &&
    !f.includes("/node_modules/@types/node/") &&
    !f.includes("/node_modules/typescript/") &&
    !f.includes("/node_modules/@typescript/")
  );
}

function declaredInPackage(symbol: ts.Symbol | undefined): boolean {
  if (symbol === undefined) return false;
  return symbol.declarations.some((d) => isPackageDeclarationFile(ts.getSourceFileOfNode(d)));
}

/** The parts of a call signature's declaration that pass-through detection
 * reads, for the declaration kinds a resolved call signature has. */
function signatureParts(node: ts.Node | undefined): {
  typeParameters: readonly ts.TypeParameterDeclaration[];
  parameters: readonly ts.ParameterDeclaration[];
  type: ts.TypeNode | undefined;
} | null {
  if (node === undefined) return null;
  if (ts.isFunctionTypeNode(node))
    return {
      typeParameters: node.typeParameters?.nodes ?? [],
      parameters: node.parameters.nodes,
      type: node.type,
    };
  if (ts.isFunctionDeclaration(node))
    return {
      typeParameters: node.typeParameters?.nodes ?? [],
      parameters: node.parameters.nodes,
      type: node.type,
    };
  if (ts.isMethodDeclaration(node))
    return {
      typeParameters: node.typeParameters?.nodes ?? [],
      parameters: node.parameters.nodes,
      type: node.type,
    };
  if (ts.isMethodSignatureDeclaration(node))
    return {
      typeParameters: node.typeParameters?.nodes ?? [],
      parameters: node.parameters.nodes,
      type: node.type,
    };
  if (ts.isCallSignatureDeclaration(node))
    return {
      typeParameters: node.typeParameters?.nodes ?? [],
      parameters: node.parameters.nodes,
      type: node.type,
    };
  return null;
}

/** A signature that returns one of its own type parameters which also types
 * a parameter (`<T extends object>(obj: T) => T`) hands back the argument
 * or something standing in for it, a proxy or a marked object, whose
 * identity the package may track (Effect's `Equal.byReference`). Its result
 * type comes from the caller's argument, not from data the package
 * declares, so the boundary leaves it alone: converting it would build a
 * separate native value. */
function passesArgumentThrough(declaration: ts.Node | undefined): boolean {
  const sig = signatureParts(declaration);
  if (sig === null || sig.type === undefined || !ts.isTypeReferenceNode(sig.type)) return false;
  const ret = sig.type;
  if (!ts.isIdentifier(ret.typeName) || ret.typeArguments !== undefined) return false;
  const name = ret.typeName.text;
  if (!sig.typeParameters.some((tp) => tp.name.text === name)) return false;
  return sig.parameters.some(
    (param) =>
      param.type !== undefined &&
      ts.isTypeReferenceNode(param.type) &&
      ts.isIdentifier(param.type.typeName) &&
      param.type.typeName.text === name,
  );
}

function declaredInUserFile(symbol: ts.Symbol | undefined): boolean {
  if (symbol === undefined) return false;
  const decls = symbol.declarations;
  return (
    decls.length > 0 &&
    decls.every((d) => {
      const sf = ts.getSourceFileOfNode(d);
      return !sf.isDeclarationFile && !sf.fileName.split("\\").join("/").includes("/node_modules/");
    })
  );
}

const ANYISH = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
const READONLY_CHECK_FLAG = 8;

/** Prints declaration-world types as structural TypeScript, or answers null
 * when a type is not pure data (DESIGN.md §4.3). */
class TypePrinter {
  readonly aliases = new Map<string, string>();
  readonly declarations: string[] = [];
  private readonly inProgress = new Map<number, { name: string | null }>();

  /** While set, printing registers no recursive alias (projectable()). */
  private dry = false;

  constructor(private readonly checker: ts.TypeChecker) {}

  /** Whether a type projects, without naming it in the generated file. */
  projectable(type: ts.Type): boolean {
    if (type.flags & ANYISH) return false;
    const was = this.dry;
    this.dry = true;
    try {
      const text = this.print(type, 0);
      return text !== null && text !== "unknown";
    } finally {
      this.dry = was;
    }
  }

  /** The alias naming a projectable type, or null. Top-level any/unknown
   * never projects. */
  project(type: ts.Type): string | null {
    if (type.flags & ANYISH) return null;
    const text = this.print(type, 0);
    if (text === null || text === "unknown") return null;
    let name = this.aliases.get(text);
    if (name === undefined) {
      name = `${DECL_BOUNDARY_PREFIX}${this.aliases.size}`;
      this.aliases.set(text, name);
      this.declarations.push(`type ${name} = ${text};`);
    }
    return name;
  }

  private print(type: ts.Type, depth: number): string | null {
    if (depth > 24) return null;
    const f = type.flags;
    if (f & ANYISH) return "unknown";
    if (f & ts.TypeFlags.String) return "string";
    if (f & ts.TypeFlags.Number) return "number";
    if (f & ts.TypeFlags.Boolean) return "boolean";
    if (f & ts.TypeFlags.Null) return "null";
    if (f & ts.TypeFlags.Undefined) return "undefined";
    if (f & ts.TypeFlags.EnumLiteral || f & ts.TypeFlags.Enum) return null;
    // A boolean literal type carries its value (`intrinsicName` is not
    // set for it by every checker facade).
    if (f & ts.TypeFlags.BooleanLiteral)
      return (type as ts.BooleanLiteralType).value === true || type.intrinsicName === "true"
        ? "true"
        : "false";
    if (f & ts.TypeFlags.StringLiteral) return JSON.stringify(String(type.value));
    if (f & ts.TypeFlags.NumberLiteral) {
      const v = Number(type.value);
      return Number.isFinite(v) ? String(v) : null;
    }
    if (type.isUnionType()) {
      const parts: string[] = [];
      for (const arm of type.getTypes()) {
        const p = this.print(arm, depth + 1);
        if (p === null || p === "unknown") return null;
        if (!parts.includes(p)) parts.push(p);
      }
      // `true | false` reads better as boolean, and maps the same.
      const t = parts.indexOf("true");
      const fl = parts.indexOf("false");
      if (t >= 0 && fl >= 0) {
        parts.splice(Math.max(t, fl), 1);
        parts.splice(Math.min(t, fl), 1, "boolean");
      }
      return parts.map((p) => (/=>/.test(p) ? `(${p})` : p)).join(" | ");
    }
    if (type.isIntersectionType()) {
      // Brands: drop members that only carry unique-symbol keys.
      const kept = type.getTypes().filter((m) => !this.isBrandOnly(m));
      if (kept.length === 1) return this.print(kept[0]!, depth + 1);
      if (kept.length === 0) return null;
      if (!kept.every((m) => (m.flags & ts.TypeFlags.Object) !== 0)) return null;
      return this.printObject(type, depth);
    }
    if (f & ts.TypeFlags.Object) return this.printObject(type, depth);
    return null;
  }

  private isBrandOnly(type: ts.Type): boolean {
    if (!(type.flags & ts.TypeFlags.Object) || type.isIntersectionType()) return false;
    const props = this.checker.getPropertiesOfType(type);
    return props.length > 0 && props.every((p) => String(p.escapedName).startsWith("__@"));
  }

  /** Whether an interface type and every type it extends are declared in
   * user files. */
  private userInterface(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (!declaredInUserFile(type.getSymbol())) return false;
    const target = type.isTypeReference() ? type.getTarget() : type;
    if (target === undefined || !target.isClassOrInterface() || seen.has(target)) return true;
    seen.add(target);
    return this.checker.getBaseTypes(target).every((base) => this.userInterface(base, seen));
  }

  private printObject(type: ts.Type, depth: number): string | null {
    const checker = this.checker;
    if (checker.isArrayType(type)) {
      const [elem] = checker.getTypeArguments(type);
      if (elem === undefined) return null;
      const e = this.print(elem, depth + 1);
      if (e === null) return null;
      const ro = type.getSymbol()?.escapedName === "ReadonlyArray" ? "readonly " : "";
      return `${ro}(${e})[]`;
    }
    if (checker.isTupleType(type)) {
      const target = type.getTarget() ?? type;
      const flags = target.elementFlags ?? [];
      if (flags.some((fl) => fl !== ts.ElementFlags.Required)) return null;
      const elems = checker.getTypeArguments(type).slice(0, flags.length);
      const out: string[] = [];
      for (const e of elems) {
        const p = this.print(e, depth + 1);
        if (p === null) return null;
        out.push(p);
      }
      return `${target.readonly === true ? "readonly " : ""}[${out.join(", ")}]`;
    }
    const symbol = type.getSymbol();
    if (symbol !== undefined) {
      if (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.Method))
        return null;
      // Interfaces: only user-declared ones describe plain data reliably
      // (package and lib interfaces often describe class instances), and
      // only when every interface they extend is user-declared too: a user
      // interface extending a package one (effect's Request.Request)
      // inherits members the package's own constructors create.
      if (symbol.flags & ts.SymbolFlags.Interface && !this.userInterface(type)) return null;
    }
    if (
      checker.getCallSignatures(type).length > 0 ||
      checker.getConstructSignatures(type).length > 0
    )
      return null;
    const memo = this.inProgress.get(type.id);
    if (memo !== undefined) {
      memo.name ??= `${DECL_BOUNDARY_PREFIX}r${type.id}`;
      return memo.name;
    }
    const frame: { name: string | null } = { name: null };
    this.inProgress.set(type.id, frame);
    try {
      const members: string[] = [];
      let readonlyCount = 0;
      const props = checker.getPropertiesOfType(type);
      for (const prop of props) {
        const key = String(prop.escapedName);
        if (key.startsWith("__@")) continue; // symbol-keyed (brands)
        if (
          prop.flags &
          (ts.SymbolFlags.Method | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)
        )
          return null;
        const propType = checker.getTypeOfSymbol(prop);
        const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        let p = this.print(propType, depth + 1);
        if (p === null) return null;
        const readonly = (prop.checkFlags & READONLY_CHECK_FLAG) !== 0 || hasReadonlyModifier(prop);
        if (readonly) readonlyCount++;
        const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
        if (optional && !/\bundefined\b/.test(p)) p = `${p} | undefined`;
        members.push(`${readonly ? "readonly " : ""}${name}${optional ? "?" : ""}: ${p}`);
      }
      for (const info of checker.getIndexInfosOfType(type)) {
        if (!(info.keyType.flags & ts.TypeFlags.String)) return null;
        const v = this.print(info.type, depth + 1);
        if (v === null) return null;
        members.push(`[key: string]: ${v}`);
      }
      if (members.length === 0) return null; // `{}` admits any non-nullish value
      // All-readonly object types may describe frozen values (.readonly()).
      if (props.length > 0 && readonlyCount === props.length) return null;
      const text = `{ ${members.join("; ")} }`;
      if (frame.name !== null) {
        if (!this.dry) this.declarations.push(`type ${frame.name} = ${text};`);
        return frame.name;
      }
      return text;
    } finally {
      this.inProgress.delete(type.id);
    }
  }
}

function hasReadonlyModifier(prop: ts.Symbol): boolean {
  return prop.declarations.some(
    (d) =>
      (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) &&
      (d.modifiers?.nodes ?? []).some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword),
  );
}

/** Children of a node in source order (forEachChild order). */
function childrenOf(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  ts.forEachChild(
    node,
    (c) => {
      out.push(c);
      return undefined;
    },
    (list) => {
      for (const c of list.nodes) out.push(c);
      return undefined;
    },
  );
  return out;
}

function isWriteTarget(node: ts.Node): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (parent === undefined) return false;
  if (ts.isBinaryExpression(parent) && parent.left === child) {
    const k = parent.operatorToken.kind;
    return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    const op = parent.operator;
    return op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken;
  }
  if (ts.isDeleteExpression(parent)) return true;
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent))
    return parent.initializer === child;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isSpreadElement(parent)
  ) {
    // Destructuring assignment targets: conservative, skip.
    let up: ts.Node | undefined = parent;
    while (
      up !== undefined &&
      (ts.isArrayLiteralExpression(up) ||
        ts.isObjectLiteralExpression(up) ||
        ts.isPropertyAssignment(up) ||
        ts.isSpreadElement(up))
    )
      up = up.parent;
    if (
      up !== undefined &&
      ts.isBinaryExpression(up) &&
      up.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      return true;
  }
  return false;
}

function inOptionalChain(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isCallExpression(parent)) &&
    parent.expression === node &&
    (parent.questionDotToken !== undefined || (parent.flags & ts.NodeFlags.OptionalChain) !== 0)
  )
    return true;
  return (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isCallExpression(node)) &&
    (node.flags & ts.NodeFlags.OptionalChain) !== 0
  );
}

function isCallee(node: ts.Node): boolean {
  const p = node.parent;
  return (
    p !== undefined &&
    (ts.isCallExpression(p) || ts.isNewExpression(p) || ts.isTaggedTemplateExpression(p)) &&
    (ts.isTaggedTemplateExpression(p) ? p.tag === node : p.expression === node)
  );
}

function inTypeContext(node: ts.Node): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isTypeQueryNode(p)) return true;
    if (ts.isExpressionWithTypeArguments(p) && p.parent && ts.isHeritageClause(p.parent))
      return true;
    if (ts.isStatement(p)) return false;
  }
  return false;
}

function unwrapTransparent(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e))
    e = e.expression;
  return e;
}

/** Plans the projection for one program pair. Answers null when nothing
 * in the user files projects (the program stays as it is). */
export function planDeclProjection(input: DeclProjectionInput): DeclProjection | null {
  const jsChecker = input.jsProgram.getTypeChecker();
  const declChecker = input.declProgram.getTypeChecker();
  const printer = new TypePrinter(declChecker);
  const plan: string[] = [];
  const edits = new Map<string, Edit[]>();

  const typeAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
    try {
      return checker.getTypeAtLocation(node);
    } catch {
      return null;
    }
  };
  const isAnyish = (t: ts.Type | null): boolean => t !== null && (t.flags & ANYISH) !== 0;
  const resolveAlias = (s: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (s === undefined || !(s.flags & ts.SymbolFlags.Alias)) return s;
    try {
      return declChecker.getAliasedSymbol(s);
    } catch {
      return s;
    }
  };
  const declSymbol = (n: ts.Node): ts.Symbol | undefined => {
    try {
      return resolveAlias(declChecker.getSymbolAtLocation(n));
    } catch {
      return undefined;
    }
  };
  const stringIndex = (checker: ts.TypeChecker, type: ts.Type): boolean => {
    try {
      return checker
        .getIndexInfosOfType(type)
        .some((info) => (info.keyType.flags & ts.TypeFlags.String) !== 0);
    } catch {
      return false;
    }
  };
  /** Whether the JavaScript world types a package value as an object
   * literal that lacks a member its declaration promises: a property (an
   * expando `out.max = ...` on a non-empty literal, which the JavaScript
   * checker does not add to the literal's type) or a string index
   * signature (`Record<string, string>` over a literal). Lowering the value
   * at the narrower literal type would drop the member or fix the key set,
   * so it crosses at its declared type instead. */
  const missesDeclaredMembers = (jsType: ts.Type, declType: ts.Type): boolean => {
    if (!(jsType.flags & ts.TypeFlags.Object) || !(declType.flags & ts.TypeFlags.Object))
      return false;
    const literal = jsType.getSymbol();
    if (literal === undefined || (literal.flags & ts.SymbolFlags.ObjectLiteral) === 0) return false;
    try {
      if (declChecker.isArrayType(declType) || declChecker.isTupleType(declType)) return false;
      if (stringIndex(declChecker, declType) && !stringIndex(jsChecker, jsType)) return true;
      return declChecker
        .getPropertiesOfType(declType)
        .some(
          (prop) =>
            !String(prop.escapedName).startsWith("__@") &&
            jsChecker.getPropertyOfType(jsType, String(prop.escapedName)) === undefined,
        );
    } catch {
      return false;
    }
  };
  const namesPackageSymbol = (node: ts.Node): boolean => {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(n) && declaredInPackage(declSymbol(n))) {
        found = true;
        return;
      }
      for (const c of childrenOf(n)) visit(c);
    };
    visit(node);
    return found;
  };

  for (const file of input.userFiles) {
    const jsSf = input.jsProgram.getSourceFile(file);
    const declSf = input.declProgram.getSourceFile(file);
    if (jsSf === undefined || declSf === undefined || jsSf.text !== declSf.text) continue;
    const fileEdits: Edit[] = [];
    const fileOrigins: (string | null)[] = [];
    /** Candidate expressions (by js node) with their declared type, named
     * only for the casts that survive suppression. */
    const exprCandidates = new Map<ts.Node, ts.Type | "any">();
    const exprOrder: ts.Node[] = [];
    /** Reads whose projectable receiver the JavaScript world types `any`:
     * kept only when nothing types the receiver. */
    const deferred = new Set<ts.Node>();
    /** Package calls whose declared type does not project. */
    const unprojected = new Set<ts.Node>();
    /** The declaration-world twin of every walked node. */
    const twins = new Map<ts.Node, ts.Node>();

    const considerType = (jsNode: ts.Node, declNode: ts.Node): boolean => {
      if (
        !ts.isTypeReferenceNode(jsNode) &&
        !ts.isIndexedAccessTypeNode(jsNode) &&
        !ts.isExpressionWithTypeArguments(jsNode)
      )
        return false;
      if (ts.isExpressionWithTypeArguments(jsNode)) {
        if (!jsNode.parent || !ts.isHeritageClause(jsNode.parent)) return false;
        if (!jsNode.parent.parent || !ts.isInterfaceDeclaration(jsNode.parent.parent)) return false;
      }
      let jsType: ts.Type | null;
      let declType: ts.Type | null;
      try {
        jsType = ts.isExpressionWithTypeArguments(jsNode)
          ? jsChecker.getTypeAtLocation(jsNode)
          : jsChecker.getTypeFromTypeNode(jsNode as ts.TypeNode);
        declType = ts.isExpressionWithTypeArguments(declNode)
          ? declChecker.getTypeAtLocation(declNode)
          : declChecker.getTypeFromTypeNode(declNode as ts.TypeNode);
      } catch {
        return false;
      }
      if (!isAnyish(jsType) || declType === null) return false;
      if (!namesPackageSymbol(declNode)) return false;
      const alias = printer.project(declType);
      if (alias === null) return false;
      const start = ts.tokenStartOfNode(jsNode);
      fileEdits.push({ start, end: jsNode.end, text: alias });
      plan.push(`${file}:${start}: type ${jsSf.text.slice(start, jsNode.end)} -> ${alias}`);
      return true;
    };

    const considerExpr = (jsNode: ts.Node, declNode: ts.Node): void => {
      if (!ts.isExpression(jsNode)) return;
      const isCall =
        ts.isCallExpression(jsNode) ||
        ts.isNewExpression(jsNode) ||
        ts.isTaggedTemplateExpression(jsNode);
      const isAccess =
        ts.isPropertyAccessExpression(jsNode) || ts.isElementAccessExpression(jsNode);
      const isAwait = ts.isAwaitExpression(jsNode);
      if (!isCall && !isAccess && !isAwait && !ts.isIdentifier(jsNode)) return;
      if (inTypeContext(jsNode) || isCallee(jsNode) || isWriteTarget(jsNode)) return;
      if (inOptionalChain(jsNode)) return;
      const parent = jsNode.parent;
      if (parent !== undefined && ts.isExpressionStatement(parent)) return;
      if (
        parent !== undefined &&
        (ts.isImportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isNamespaceImport(parent) ||
          ts.isExportSpecifier(parent))
      )
        return;
      if (ts.isIdentifier(jsNode)) {
        if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === jsNode)
          return;
      }
      const jsType = typeAt(jsChecker, jsNode);
      if (jsType === null) return;
      // A typed JavaScript value crosses only where its object type lacks a
      // member the declaration promises (missesDeclaredMembers).
      const typedJs = !isAnyish(jsType);
      if (typedJs) {
        const declType = typeAt(declChecker, declNode);
        if (declType === null || !missesDeclaredMembers(jsType, declType)) return;
      }
      // Package-produced?
      const d = declNode as ts.Expression;
      let produced = false;
      if (ts.isCallExpression(d) || ts.isNewExpression(d)) {
        const callee = d.expression;
        const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
        let decl: ts.Node | undefined;
        try {
          decl = declChecker.getResolvedSignature(d)?.declaration;
        } catch {
          decl = undefined;
        }
        produced =
          (declaredInPackage(declSymbol(target)) ||
            (decl !== undefined && isPackageDeclarationFile(ts.getSourceFileOfNode(decl)))) &&
          !passesArgumentThrough(decl);
      } else if (ts.isTaggedTemplateExpression(d)) {
        produced = declaredInPackage(declSymbol(d.tag));
      } else if (ts.isPropertyAccessExpression(d) || ts.isElementAccessExpression(d)) {
        const recvDecl = typeAt(declChecker, d.expression);
        const recvJs = typeAt(jsChecker, (jsNode as ts.PropertyAccessExpression).expression);
        const recvProjectable = recvDecl !== null && printer.projectable(recvDecl);
        produced = !recvProjectable || (recvJs !== null && !isAnyish(recvJs));
        // A projectable receiver the JavaScript world types `any` is
        // usually typed by another candidate. One that is a package value
        // nothing projects stays `any`, such as a safeParse result narrowed
        // to its success arm (the whole result is not data: its error arm
        // is a class): the read crosses here instead, if the suppression
        // below confirms the receiver stays untyped.
        if (!produced) {
          produced = true;
          deferred.add(jsNode);
        }
      } else if (ts.isAwaitExpression(d)) {
        const inner = unwrapTransparent(d.expression);
        produced =
          (ts.isCallExpression(inner) || ts.isPropertyAccessExpression(inner)) &&
          (declaredInPackage(
            declSymbol(
              ts.isCallExpression(inner)
                ? ts.isPropertyAccessExpression(inner.expression)
                  ? inner.expression.name
                  : inner.expression
                : inner.name,
            ),
          ) ||
            isAnyish(typeAt(jsChecker, inner)));
      } else if (ts.isIdentifier(d)) {
        const raw = (() => {
          try {
            return declChecker.getSymbolAtLocation(d);
          } catch {
            return undefined;
          }
        })();
        produced =
          raw !== undefined &&
          (raw.flags & ts.SymbolFlags.Alias) !== 0 &&
          declaredInPackage(resolveAlias(raw));
      }
      if (!produced) return;
      if (isCall && !deferred.has(jsNode)) {
        // Recorded before the contextual-type test below: a package value
        // whose type does not project stays `any` wherever it flows.
        const t = typeAt(declChecker, d);
        if (t === null || !printer.projectable(t)) unprojected.add(jsNode);
      }
      // A consumer that takes anything needs no conversion.
      try {
        const ctx = declChecker.getContextualType(d);
        if (ctx !== undefined && ctx.flags & ANYISH) return;
      } catch {
        // no contextual type
      }
      const declType = typeAt(declChecker, d);
      if (declType === null) return;
      if (!printer.projectable(declType)) {
        // An index signature over values that do not project (package
        // interfaces): the literal's fixed key set would still answer for
        // keys it lacks, so the value stays untyped and every read is the
        // JavaScript read.
        if (typedJs && stringIndex(declChecker, declType)) {
          exprCandidates.set(jsNode, "any");
          exprOrder.push(jsNode);
        }
        return;
      }
      exprCandidates.set(jsNode, declType);
      exprOrder.push(jsNode);
    };

    const annotated = new Set<ts.Node>();
    const considerParam = (jsNode: ts.Node, declNode: ts.Node): void => {
      if (!ts.isParameter(jsNode) || jsNode.type !== undefined || !ts.isIdentifier(jsNode.name))
        return;
      const fn = jsNode.parent;
      if (fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return;
      if (jsNode.dotDotDotToken !== undefined) return;
      const jsType = typeAt(jsChecker, jsNode.name);
      if (!isAnyish(jsType)) return;
      const declType = typeAt(declChecker, (declNode as ts.ParameterDeclaration).name);
      if (declType === null) return;
      // Only parameters the package's declarations type (a callback the
      // package calls), not ones the user typed elsewhere.
      try {
        const ctxFn = declChecker.getContextualType(declNode.parent as ts.Expression);
        if (ctxFn === undefined) return;
        const sigs = declChecker.getCallSignatures(ctxFn);
        if (
          !sigs.some(
            (s) =>
              s.declaration !== undefined &&
              isPackageDeclarationFile(ts.getSourceFileOfNode(s.declaration)),
          )
        )
          return;
      } catch {
        return;
      }
      const alias = printer.project(declType);
      if (alias === null) return;
      annotated.add(jsNode);
      const name = jsNode.name;
      const nameStart = ts.tokenStartOfNode(name);
      const text = jsSf.text;
      // `x => ...` or `async x => ...`: nothing but the modifiers comes
      // before the parameter, which then needs parentheses for its type.
      const head = ts.isArrowFunction(fn)
        ? ((ts.getModifiers(fn) ?? []).at(-1)?.end ?? ts.tokenStartOfNode(fn))
        : nameStart;
      const bareArrow =
        ts.isArrowFunction(fn) &&
        fn.parameters.nodes.length === 1 &&
        text.slice(head, nameStart).trim() === "";
      const afterName = jsNode.questionToken !== undefined ? jsNode.questionToken.end : name.end;
      if (bareArrow) {
        fileEdits.push({ start: nameStart, end: nameStart, text: "(" });
        fileEdits.push({ start: afterName, end: afterName, text: `: ${alias})` });
      } else {
        fileEdits.push({ start: afterName, end: afterName, text: `: ${alias}` });
      }
      plan.push(`${file}:${nameStart}: parameter ${name.text}: ${alias}`);
    };

    const walk = (jsNode: ts.Node, declNode: ts.Node): void => {
      if (jsNode.kind !== declNode.kind) return;
      twins.set(jsNode, declNode);
      if (ts.isTypeNode(jsNode) || ts.isExpressionWithTypeArguments(jsNode)) {
        if (considerType(jsNode, declNode)) return;
      } else {
        considerParam(jsNode, declNode);
        considerExpr(jsNode, declNode);
      }
      const a = childrenOf(jsNode);
      const b = childrenOf(declNode);
      if (a.length !== b.length) return;
      for (let i = 0; i < a.length; i++) walk(a[i]!, b[i]!);
    };
    walk(jsSf, declSf);

    // Suppress candidates whose receiver chain another candidate types.
    const symbolTyped = new Map<ts.Symbol, boolean>();
    const willBeTyped = (e: ts.Node, depth = 0): boolean => {
      if (depth > 32) return false;
      if (exprCandidates.has(e)) return true;
      if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e))
        return willBeTyped(e.expression, depth + 1);
      if (ts.isAsExpression(e)) return false;
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
        return willBeTyped(e.expression, depth + 1);
      if (ts.isIdentifier(e)) {
        let sym: ts.Symbol | undefined;
        try {
          sym = jsChecker.getSymbolAtLocation(e);
        } catch {
          return false;
        }
        if (sym === undefined) return false;
        const known = symbolTyped.get(sym);
        if (known !== undefined) return known;
        symbolTyped.set(sym, false);
        let result = false;
        const decls = sym.declarations;
        if (decls.length === 1) {
          const decl = decls[0]!;
          if (
            ts.isVariableDeclaration(decl) &&
            decl.initializer !== undefined &&
            decl.type === undefined
          )
            result = willBeTyped(decl.initializer, depth + 1);
          else if (ts.isParameter(decl) && annotated.has(decl)) result = true;
          else if (ts.isBindingElement(decl)) result = false;
          else if (
            (ts.isVariableDeclaration(decl) || ts.isParameter(decl)) &&
            decl.type !== undefined
          )
            result = annotationWillBeTyped(decl.type);
        }
        symbolTyped.set(sym, result);
        return result;
      }
      return false;
    };
    /** An annotation in this file whose declaration-world type projects:
     * after the rewrite it names the projected structure (a package type
     * is replaced by its alias, a user alias of one has its right-hand
     * side replaced). */
    const annotationWillBeTyped = (type: ts.TypeNode): boolean => {
      const twin = twins.get(type);
      if (twin === undefined) return false;
      let declType: ts.Type | null;
      try {
        declType = declChecker.getTypeFromTypeNode(twin as ts.TypeNode);
      } catch {
        return false;
      }
      return declType !== null && printer.projectable(declType);
    };
    const receiverOf = (e: ts.Node): ts.Node | null => {
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return e.expression;
      if (ts.isIdentifier(e)) return null;
      return null;
    };
    const kept: ts.Node[] = [];
    /** A receiver that stays `any` after the rewrite: a package call whose
     * type does not project, or a user const bound to one. */
    const staysUntyped = (e: ts.Node): boolean => {
      const u = unwrapTransparent(e as ts.Expression);
      if (unprojected.has(u)) return true;
      if (!ts.isIdentifier(u)) return false;
      let sym: ts.Symbol | undefined;
      try {
        sym = jsChecker.getSymbolAtLocation(u);
      } catch {
        return false;
      }
      const decls = sym?.declarations ?? [];
      if (decls.length !== 1) return false;
      const decl = decls[0]!;
      return (
        ts.isVariableDeclaration(decl) &&
        decl.type === undefined &&
        decl.initializer !== undefined &&
        decl.parent !== undefined &&
        ts.isVariableDeclarationList(decl.parent) &&
        (decl.parent.flags & ts.NodeFlags.Const) !== 0 &&
        unprojected.has(unwrapTransparent(decl.initializer))
      );
    };
    for (const e of exprOrder) {
      const recv = receiverOf(e);
      if (recv !== null && willBeTyped(recv)) continue;
      if (deferred.has(e) && (recv === null || !staysUntyped(recv))) continue;
      // An identifier candidate that is a user binding never gets here
      // (only package imports are candidates).
      kept.push(e);
    }
    // Nested candidates: keep only the innermost (an outer one is typed by
    // the inner wrap).
    const keptSet = new Set(kept);
    const containsKept = (outer: ts.Node): boolean => {
      let found = false;
      const visit = (n: ts.Node): void => {
        if (found) return;
        for (const c of childrenOf(n)) {
          if (keptSet.has(c)) {
            found = true;
            return;
          }
          visit(c);
        }
      };
      visit(outer);
      return found;
    };
    for (const e of kept) {
      if (
        !ts.isAwaitExpression(e) &&
        containsKept(e) &&
        (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
      ) {
        // `a.b.c` with `a.b` wrapped: the outer access reads typed data.
        const recv = receiverOf(e);
        if (
          recv !== null &&
          (keptSet.has(unwrapTransparent(recv as ts.Expression)) || willBeTyped(recv))
        )
          continue;
      }
      const candidate = exprCandidates.get(e)!;
      const alias = candidate === "any" ? "any" : printer.project(candidate);
      if (alias === null) continue;
      // Only casts to a projected alias are boundary casts the lowering
      // counts (an `as any` cast is not one), so only they take a slot.
      if (candidate !== "any") {
        const twin = twins.get(e);
        fileOrigins.push(twin === undefined ? null : castOrigin(declChecker, twin, candidate));
      }
      const start = ts.tokenStartOfNode(e);
      const stmt = e.parent;
      let prefix = "(";
      // A statement that would start with `(` after a line without a
      // semicolon continues the previous expression: guard it.
      let up: ts.Node | undefined = e;
      while (up?.parent !== undefined && !ts.isStatement(up.parent)) up = up.parent;
      // Only a statement in a statement list can follow such a line; an
      // unbraced body (`for (...) S.parse(x).run()`) follows its header,
      // and a `;` there would become the body.
      const list = up?.parent?.parent;
      if (
        up?.parent !== undefined &&
        ts.isExpressionStatement(up.parent) &&
        ts.tokenStartOfNode(up.parent) === start &&
        list !== undefined &&
        (ts.isBlock(list) ||
          ts.isSourceFile(list) ||
          ts.isModuleBlock(list) ||
          ts.isCaseClause(list) ||
          ts.isDefaultClause(list))
      )
        prefix = ";(";
      void stmt;
      fileEdits.push({ start, end: start, text: prefix });
      // Closing parts at one position close inner wraps first.
      fileEdits.push({ start: e.end, end: e.end, text: ` as ${alias})`, rank: -start });
      plan.push(
        `${file}:${start}: cast ${jsSf.text.slice(start, Math.min(e.end, start + 60)).replace(/\s+/g, " ")} as ${alias}`,
      );
    }

    if (fileEdits.length === 0) continue;
    edits.set(file, fileEdits);
    if (fileOrigins.some((o) => o !== null)) boundaryOrigins.set(file, fileOrigins);
  }

  if (edits.size === 0) return null;
  const files = new Map<string, string>();
  for (const [file, list] of edits) {
    const sf = input.jsProgram.getSourceFile(file)!;
    files.set(file, applyEdits(sf.text, list));
  }
  const declFile = `${input.outDir.split("\\").join("/")}/${DECL_BOUNDARY_FILE}`;
  const declText =
    "// Generated by scriptc: types projected from npm package declarations.\n" +
    printer.declarations.join("\n") +
    "\n";
  return { files, declFile, declText, plan };
}

/** Applies insertions and replacements; overlapping replacements keep the
 * first. Insertions at one position keep their order. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = edits
    .map((e, i) => ({ ...e, i }))
    .sort(
      (a, b) => a.start - b.start || a.end - b.end || (a.rank ?? 0) - (b.rank ?? 0) || a.i - b.i,
    );
  let out = "";
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) continue; // overlaps an earlier replacement
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}
