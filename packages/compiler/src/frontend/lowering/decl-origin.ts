/* Origins of package-declared types at checked conversions.
 *
 * scriptc enforces declared types: a value that contradicts the type an
 * npm package declares (its .d.ts, @types package or JSDoc) throws a
 * TypeError where Node runs on. When the declaration is what is wrong, the
 * fix is a type patch (package.json scriptc.typePatches), so the error
 * names the declaration and the patch that would admit the value:
 *
 *   TypeError: expected number at $, got undefined
 *       termctx@1.2.0 declares Terminal.columns() as number (index.js:14)
 *       if that declaration is wrong, patch it in package.json: "scriptc":
 *       { "typePatches": { "termctx@^1.2.0": { "declarations":
 *       { "Terminal.columns()": "| undefined" } } } }
 *
 * The origin is found for three kinds of slots: a value a package function
 * returns under a written return type, a property of an object literal
 * typed by a package-declared type, and a declaration-boundary cast (a
 * value user code receives from a package; decl-projection.ts records
 * those with originAt). Generic declarations get none: their types come
 * from how the program instantiates them. Checks in
 * code that names no package declaration carry no origin, so programs
 * without npm packages lower exactly as before.
 *
 * The origin string's fields (separated by \x1f) are read by the runtime
 * (scr_type_origin.c) for checked conversions, whose path and actual kind
 * are only known when they fail, and rendered here for union extractions,
 * whose failing arm is known statically. */

import type { IrExpr, IrModule } from "../../ir/ir.js";
import { everyModuleNode } from "../../ir/traverse.js";
import { trackedReadFile } from "../input-tracker.js";
import * as ts from "../ts7/adapter.js";

export const ORIGIN_SEPARATOR = "\x1f";

interface PackageFile {
  pkg: string;
  version: string;
  /** The file relative to the package root. */
  rel: string;
}

/** Installed package versions by package root, read once per program load
 * (resetDeclOriginVersions): a dependency reinstalled at another version
 * between two builds of one process is read again. */
const versions = new Map<string, string>();

export function resetDeclOriginVersions(): void {
  versions.clear();
}

function packageFileOf(fileName: string): PackageFile | null {
  const path = fileName.split("\\").join("/");
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path.slice(at + marker.length).split("/");
  const nameParts = parts[0]!.startsWith("@") ? 2 : 1;
  if (parts.length <= nameParts) return null;
  let pkg = parts.slice(0, nameParts).join("/");
  const root = path.slice(0, at + marker.length) + pkg;
  let versionRoot = root;
  if (pkg.startsWith("@types/")) {
    // A twin describes the runtime package installed beside it.
    const bare = pkg.slice("@types/".length);
    const i = bare.indexOf("__");
    pkg = i > 0 ? `@${bare.slice(0, i)}/${bare.slice(i + 2)}` : bare;
    versionRoot = path.slice(0, at + marker.length) + pkg;
  }
  let version = versions.get(versionRoot);
  if (version === undefined) {
    version = "";
    try {
      const parsed = JSON.parse(trackedReadFile(`${versionRoot}/package.json`) ?? "{}") as {
        version?: unknown;
      };
      if (typeof parsed.version === "string") version = parsed.version;
    } catch {
      version = "";
    }
    versions.set(versionRoot, version);
  }
  return { pkg, version, rel: parts.slice(nameParts).join("/") };
}

/** True for a node in an installed package's file. */
export function inPackageFile(node: ts.Node): boolean {
  return packageFileOf(ts.getSourceFileOfNode(node).fileName) !== null;
}

function lineOf(node: ts.Node): number {
  const sf = ts.getSourceFileOfNode(node);
  return ts.getLineAndCharacterOfPosition(sf, ts.tokenStartOfNode(node)).line + 1;
}

function encode(file: PackageFile, selector: string, where: string, declared: string): string {
  const range = file.version === "" ? "*" : `^${file.version}`;
  return [file.pkg, file.version, range, selector, where, declared.replace(/\s+/g, " ")].join(
    ORIGIN_SEPARATOR,
  );
}

function nameOf(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))
    return name.text;
  return null;
}

/** `module.exports` → "export="; `exports.x` / `module.exports.x` → "x". */
function exportTarget(left: ts.Node): string | null {
  if (!ts.isPropertyAccessExpression(left)) return null;
  const obj = left.expression;
  const prop = nameOf(left.name);
  if (prop === null) return null;
  if (ts.isIdentifier(obj) && obj.text === "module" && prop === "exports") return "export=";
  if (ts.isIdentifier(obj) && obj.text === "exports") return prop;
  if (
    ts.isPropertyAccessExpression(obj) &&
    ts.isIdentifier(obj.expression) &&
    obj.expression.text === "module" &&
    nameOf(obj.name) === "exports"
  )
    return prop;
  return null;
}

/** The selector naming a function-like declaration (without `()`), or
 * null when it has no name a selector can reach. */
function functionSelector(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn)) return nameOf(fn.name);
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessor(fn)) {
    const method = nameOf(fn.name);
    const holder = fn.parent;
    if (method === null || holder === undefined) return null;
    if (ts.isClassDeclaration(holder) || ts.isClassExpression(holder)) {
      const cls = nameOf(holder.name);
      return cls === null ? null : `${cls}.${method}`;
    }
    if (ts.isObjectLiteralExpression(holder)) {
      const owner = valueSelector(holder);
      return owner === null ? null : `${owner}.${method}`;
    }
    return null;
  }
  if (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) return valueSelector(fn);
  return null;
}

/** The selector of the declaration an expression is the value of. */
function valueSelector(value: ts.Node): string | null {
  let e = value;
  while (e.parent !== undefined && ts.isParenthesizedExpression(e.parent)) e = e.parent;
  const p = e.parent;
  if (p === undefined) return null;
  if (ts.isVariableDeclaration(p) && p.initializer === e) return nameOf(p.name);
  if (
    ts.isBinaryExpression(p) &&
    p.right === e &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return exportTarget(p.left);
  if (ts.isPropertyAssignment(p) && p.initializer === e && p.parent !== undefined) {
    const name = nameOf(p.name);
    const owner = ts.isObjectLiteralExpression(p.parent) ? valueSelector(p.parent) : null;
    return name === null || owner === null ? null : `${owner}.${name}`;
  }
  return null;
}

/** True when a function-like declaration writes its return type: a type
 * annotation, or a JSDoc @returns tag. */
function writesReturnType(fn: ts.Node): boolean {
  if ((fn as ts.FunctionDeclaration).type !== undefined) return true;
  const sf = ts.getSourceFileOfNode(fn);
  let owner: ts.Node = fn;
  // The JSDoc of `exports.f = function`, `const f = () =>` sits on the
  // statement.
  while (
    owner.parent !== undefined &&
    !ts.isSourceFile(owner.parent) &&
    !ts.isBlock(owner.parent) &&
    !ts.isClassDeclaration(owner.parent) &&
    !ts.isClassExpression(owner.parent) &&
    !ts.isObjectLiteralExpression(owner.parent)
  )
    owner = owner.parent;
  const leading = sf.text.slice(owner.pos, ts.tokenStartOfNode(owner));
  const doc = leading.lastIndexOf("/**");
  return doc >= 0 && /@returns?\s*\{/.test(leading.slice(doc));
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessor(p)
    )
      return p;
    if (ts.isSourceFile(p) || ts.isClassDeclaration(p)) return null;
  }
  return null;
}

function typeText(checker: ts.TypeChecker, type: ts.Type | undefined): string {
  if (type === undefined) return "";
  try {
    return checker.typeToString(type);
  } catch {
    return "";
  }
}

/** The origin of the slot a value expression in a package file flows
 * into, or null when no package declaration types that slot. */
export function slotOrigin(checker: ts.TypeChecker, node: ts.Node): string | null {
  let value = node;
  while (value.parent !== undefined && ts.isParenthesizedExpression(value.parent))
    value = value.parent;
  const parent = value.parent;
  if (parent === undefined) return null;
  // A property of an object literal typed by a declared type.
  if (
    (ts.isPropertyAssignment(parent) && parent.initializer === value) ||
    ts.isShorthandPropertyAssignment(value) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === value)
  ) {
    const property = ts.isShorthandPropertyAssignment(value) ? value : parent;
    const literal = property.parent;
    const name = nameOf((property as ts.PropertyAssignment).name);
    if (literal === undefined || !ts.isObjectLiteralExpression(literal) || name === null)
      return null;
    const contextual = checker.getContextualType(literal);
    if (contextual === undefined) return null;
    const typeSymbol = contextual.getAliasSymbol() ?? contextual.getSymbol();
    const typeName = typeSymbol === undefined ? "" : ts.symbolName(typeSymbol);
    if (!/^[A-Za-z_$][\w$]*$/.test(typeName)) return null;
    const symbol = checker.getPropertyOfType(contextual, name);
    const decl = symbol?.declarations[0];
    if (symbol === undefined || decl === undefined || genericDeclaration(decl)) return null;
    const file = packageFileOf(ts.getSourceFileOfNode(decl).fileName);
    if (file === null) return null;
    return encode(
      file,
      `${typeName}.${name}`,
      `${file.rel}:${lineOf(decl)}`,
      typeText(checker, checker.getTypeOfSymbol(symbol)),
    );
  }
  // A value a package function returns under its written return type.
  let fn: ts.Node | null = null;
  if (ts.isReturnStatement(parent) && parent.expression === value) fn = enclosingFunction(parent);
  else if (ts.isArrowFunction(parent) && parent.body === value) fn = parent;
  if (fn === null || !writesReturnType(fn)) return null;
  const file = packageFileOf(ts.getSourceFileOfNode(fn).fileName);
  const selector = functionSelector(fn);
  if (file === null || selector === null) return null;
  let declared = "";
  try {
    const signature = checker.getSignatureFromDeclaration(fn as ts.SignatureDeclaration);
    declared =
      signature === undefined ? "" : typeText(checker, checker.getReturnTypeOfSignature(signature));
  } catch {
    declared = "";
  }
  return encode(file, `${selector}()`, `${file.rel}:${lineOf(fn)}`, declared);
}

/** A package-declared record type a value is converted to (the
 * contextual type of a value in package code, such as an object literal
 * returned under `@returns {HelpContext}`), or null. */
export interface RecordOrigin {
  type: ts.Type;
  name: string;
  /** The declaration's identity (package, version, file, line and name):
   * records of the same shape and name declared by two packages differ. */
  key: string;
}

export function recordOrigin(checker: ts.TypeChecker, node: ts.Node): RecordOrigin | null {
  const contextual = checker.getContextualType(node);
  if (contextual === undefined) return null;
  const symbol = contextual.getAliasSymbol() ?? contextual.getSymbol();
  const name = symbol === undefined ? "" : ts.symbolName(symbol);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const decl = symbol?.declarations[0];
  if (decl === undefined || genericDeclaration(decl)) return null;
  const file = packageFileOf(ts.getSourceFileOfNode(decl).fileName);
  if (file === null) return null;
  const key = [file.pkg, file.version, file.rel, lineOf(decl), name].join(ORIGIN_SEPARATOR);
  return { type: contextual, name, key };
}

/** The origin of one field of a package-declared record type. */
export function fieldOrigin(
  checker: ts.TypeChecker,
  record: RecordOrigin,
  field: string,
): string | null {
  const symbol = checker.getPropertyOfType(record.type, field);
  const decl = symbol?.declarations[0];
  if (symbol === undefined || decl === undefined || genericDeclaration(decl)) return null;
  const file = packageFileOf(ts.getSourceFileOfNode(decl).fileName);
  if (file === null) return null;
  return encode(
    file,
    `${record.name}.${field}`,
    `${file.rel}:${lineOf(decl)}`,
    typeText(checker, checker.getTypeOfSymbol(symbol)),
  );
}

/** The origin of a declaration in a package file named by `selector`. */
export function originAt(decl: ts.Node, selector: string, declared: string): string | null {
  const file = packageFileOf(ts.getSourceFileOfNode(decl).fileName);
  if (file === null) return null;
  return encode(file, selector, `${file.rel}:${lineOf(decl)}`, declared);
}

/** True when a declaration or the class, interface or type alias holding
 * it has type parameters: its declared type then comes from how the
 * program instantiates it (a lying `z.custom<T>()`), not from the package. */
function genericDeclaration(decl: ts.Node): boolean {
  for (let n: ts.Node | undefined = decl; n !== undefined && !ts.isSourceFile(n); n = n.parent) {
    const params = (n as ts.FunctionDeclaration).typeParameters;
    if (params !== undefined && params.nodes.length > 0) return true;
  }
  return false;
}

/** The selector of a declaration in a declaration file: a function, a
 * member of a class, interface or named object type, or null (also for
 * generic declarations, whose types the program supplies). */
export function declarationSelector(decl: ts.Node): string | null {
  if (genericDeclaration(decl)) return null;
  const own = nameOf((decl as ts.FunctionDeclaration).name);
  if (own === null) return null;
  if (ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl)) return own;
  let holder = decl.parent;
  if (holder !== undefined && ts.isTypeLiteralNode(holder)) holder = holder.parent;
  if (
    holder !== undefined &&
    (ts.isClassDeclaration(holder) ||
      ts.isInterfaceDeclaration(holder) ||
      ts.isTypeAliasDeclaration(holder))
  ) {
    const owner = nameOf(holder.name);
    return owner === null ? null : `${owner}.${own}`;
  }
  return null;
}

/** One argument of the suggested `scriptc types patch` command, quoted so
 * the shell passes it as written (scr_type_origin.c quotes the same way):
 * bare when it has only characters no shell treats specially; otherwise,
 * for a POSIX shell, in single quotes with each `'` as `'\''`, and for
 * Windows (cmd and PowerShell), in double quotes when it has none of the
 * characters either shell expands, escapes or ends a string with there. Null when no quoting
 * is inert there: the note then names the command without arguments.
 * Package names, selectors and types come from package declarations. */
export function shellArgument(value: string, windows: boolean): string | null {
  if (/^[A-Za-z0-9_@+=:,./-]+$/.test(value)) return value;
  if (!windows)
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    // PowerShell also takes the typographic quotes U+2018-U+201F as quotes.
    if (code < 0x20 || code === 0x7f || (code >= 0x2018 && code <= 0x201f)) return null;
    if ('"%!^$`'.includes(ch)) return null;
  }
  return `"${value}"`;
}

/** The suggested patch for a declaration: `scriptc types patch` with the
 * package, the selector and the type, each quoted for the target's shell. */
export function patchSuggestion(
  pkg: string,
  selector: string,
  type: string,
  windows: boolean,
): string {
  const args = [pkg, selector, type].map((a) => shellArgument(a, windows));
  return args.every((a) => a !== null)
    ? `if that declaration is wrong, patch it: scriptc types patch ${args.join(" ")}`
    : "if that declaration is wrong, patch it with scriptc types patch";
}

/** The note a union extraction's TypeError carries for a failing `arm`
 * (the same text the runtime renders for checked conversions). `windows`:
 * the program targets Windows, whose shells quote differently. */
export function renderOriginNote(origin: string, arm: string, windows = false): string {
  const [pkg = "", version = "", , selector = "", where = "", declared = ""] =
    origin.split(ORIGIN_SEPARATOR);
  return (
    `\n    ${pkg}${version === "" ? "" : `@${version}`} declares ${selector}` +
    `${declared === "" ? "" : ` as ${declared}`} (${where})` +
    `\n    ${patchSuggestion(pkg, selector, `| ${arm}`, windows)}`
  );
}

/** Keeps only the origins the module's checks still reference (a coercion
 * whose check was later replaced leaves its origin behind), renumbered in
 * first-use order; drops the table when none is left, so the runtime unit
 * is not linked for nothing. */
export function compactDeclOrigins(mod: IrModule): void {
  const table = mod.declOrigins ?? [];
  const remap = new Map<number, number>();
  const used: string[] = [];
  // A node the IR shares at several places is renumbered once.
  const checks = new Set<IrExpr & { kind: "dynCheck" }>();
  everyModuleNode(mod, {
    expr: (e) => {
      if (e.kind === "dynCheck" && e.origin !== undefined) {
        // An exact capsule check never throws: nothing to name.
        if (e.exact === true) {
          delete e.origin;
          return true;
        }
        checks.add(e);
        if (!remap.has(e.origin)) {
          remap.set(e.origin, used.length);
          used.push(table[e.origin]!);
        }
      }
      return true;
    },
    stmt: () => true,
    type: () => true,
  });
  for (const check of checks) check.origin = remap.get(check.origin!)!;
  if (used.length === 0) delete mod.declOrigins;
  else mod.declOrigins = used;
}
