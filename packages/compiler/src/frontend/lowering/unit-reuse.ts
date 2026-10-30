/* Reuse of lowered units across builds (SCRIPTC_INCR_LOWERING=1).
 *
 * A build with a unit store records every reachable-emit unit
 * (unit-journal.ts) and writes the records to the store, one entry per
 * source file, beside a program entry that describes the build's program.
 * The next build applies a unit's stored record in place of lowering the
 * unit when nothing the unit's lowering read can have changed:
 *
 * - the program digest is unchanged: the IR version, the files outside the
 *   program's own modules (declaration files, the library), the module
 *   order and the statements with global effect;
 * - the unit's source file has the same text, and so does every other file
 *   whose source positions its record holds;
 * - the unit's text spells no name in the build's changed names.
 *
 * The changed names come from the two builds' declaration tables. A
 * declaration is a top-level statement or a member of a top-level class or
 * interface. Its surface is its text without the bodies of functions that
 * declare their return type: what other declarations' types can depend on.
 * Its facts are what the steps before the worklist settled for it: a
 * function's signature, a class's layout and method signatures, a
 * variable's globals. The changed names are:
 *
 * - the names of top-level declarations that were added or removed, or
 *   whose surface or facts changed, and the interfaces whose members did,
 *   closed over the surfaces that spell one of them (a declaration whose
 *   surface spells one joins);
 * - the names of such class and interface members, and of declarations
 *   whose text alone changed;
 * - the names a changed, added or removed declaration writes to outside
 *   itself, since analyses read a binding's or property's writes anywhere;
 * - the names that refer to a module's namespace object, by a namespace
 *   import or an `import()` or `require()` call, when the module's exports
 *   changed;
 * - the names that hold one of these under another name (Alias): a renamed
 *   or default import, a renamed or default export, a renamed `require()`
 *   destructuring, and the aliases of those.
 *
 * TypeScript resolves every dependency of a type through a name some text
 * spells, so a unit whose text spells none of these sees the same types,
 * the same declarations and the same facts. A unit's spelled names include
 * its strings, which can name members.
 *
 * The first build into a cache records nothing: it writes only the
 * declaration tables, and the build after it records its units.
 *
 * Applying a record goes through applyRecord, which still lowers the unit
 * when the record disagrees with what this build holds by the unit's turn.
 * SCRIPTC_INCR_VERIFY=1 lowers every unit whose record would apply and
 * throws an InternalCompilerError naming the unit when the new record
 * differs from the stored one. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InternalCompilerError } from "../../errors.js";
import type { IrFunction } from "../../ir/ir.js";
import { IrReader, IrWriter, decodeFunctionBinary } from "../../ir/codec.js";
import { IR_CODEC_LAYOUT } from "../../ir/codec.generated.js";
import { IR_VERSION } from "../../ir/serialize.js";
import * as ts from "../ts7/adapter.js";
import { isJsSourceFileName } from "../tsc-codes.js";
import {
  decodeRecordFunction,
  encodeUnitFunction,
  type StoredRecord,
  type UnitRecord,
} from "./unit-journal.js";

/** Where a build's unit entries live. The store's owner keys the program
 * entry by everything the lowered module depends on besides the program's
 * sources: the compiler, the entry, the options and the target. */
export interface UnitStore {
  /** The program entry the last build with the same key wrote, or null. */
  readProgram(): Uint8Array | null;
  writeProgram(bytes: Uint8Array): void;
  /** A file entry by the name writeFile gave it, or null. */
  readFile(name: string): Uint8Array | null;
  /** Writes a file entry and returns its name. */
  writeFile(bytes: Uint8Array): string;
}

/** What reuse asks the lowerer. */
export interface UnitReuseHooks {
  /** The facts the steps before the worklist settled for a declaration (a
   * top-level statement or a class's header), as text. */
  facts(declaration: ts.Node): string;
  /** The names a module specifier's module exports, as text, or null when
   * it names no module of the program. */
  exportsOf(specifier: ts.Node): string | null;
  /** Whether every declaration of the binding `identifier` names is inside
   * `container`. */
  isLocal(identifier: ts.Identifier, container: ts.Node): boolean;
}

/** A unit store in `directory`: the program entry for `key` under
 * `program/`, file entries by content digest under `files/`. Failing reads
 * are misses and failing writes leave the store as it was. */
export function directoryUnitStore(directory: string, key: string): UnitStore {
  const read = (path: string): Uint8Array | null => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  };
  const write = (path: string, bytes: Uint8Array): void => {
    try {
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      const stage = `${path}.${process.pid}.tmp`;
      writeFileSync(stage, bytes);
      renameSync(stage, path);
    } catch {
      // A failed write only costs the next build its reuse.
    }
  };
  const programPath = join(directory, "program", key);
  return {
    readProgram: () => read(programPath),
    writeProgram: (bytes) => write(programPath, bytes),
    readFile: (name) => (/^[0-9a-f]{64}$/.test(name) ? read(join(directory, "files", name)) : null),
    writeFile: (bytes) => {
      const name = createHash("sha256").update(bytes).digest("hex");
      const path = join(directory, "files", name);
      if (read(path) === null) write(path, bytes);
      return name;
    },
  };
}

/** Whether builds reuse lowered units (SCRIPTC_INCR_LOWERING=1). */
export function unitReuseEnabled(): boolean {
  return process.env["SCRIPTC_INCR_LOWERING"] === "1";
}

/** Whether every unit whose record would apply lowers again and is checked
 * against it (SCRIPTC_INCR_VERIFY=1). */
export function unitReuseVerify(): boolean {
  return process.env["SCRIPTC_INCR_VERIFY"] === "1";
}

/** The first line of a program entry and of a file entry. */
const PROGRAM_MAGIC = "scriptc-units-program-2";
const FILE_MAGIC = "scriptc-units-file-3";

/** A unit's record as an entry holds it, with the files other than the
 * unit's own whose source positions the record holds. The function is in
 * the binary encoding (`bytes`, the record's `fn` null) when every object
 * in it reads back with its own key order, which frontend passes and the
 * IR's text depend on, and in the record's JSON otherwise. */
interface StoredUnit {
  readonly record: UnitRecord;
  readonly files: readonly string[];
  readonly bytes: Buffer | null;
}

/** A recorded unit as an entry holds it. `named` are the files the fields
 * named `file` in its binary function hold (RecordedUnit.files). */
function storedUnit(record: UnitRecord, named: readonly string[] | null, own: string): StoredUnit {
  const files = positionFiles(record, named, own);
  const fn = record.fn;
  if (fn === null || typeof fn === "string") return { record, files, bytes: null };
  const bytes = Buffer.from(fn.buffer, fn.byteOffset, fn.byteLength);
  return { record: { ...record, fn: null }, files, bytes };
}

/** The record of a stored unit, with its function. */
function storedRecord(unit: StoredUnit): StoredRecord {
  const bytes = unit.bytes;
  const record = unit.record;
  return {
    record,
    fn: () =>
      bytes !== null
        ? decodeFunctionBinary(bytes)
        : record.fn === null
          ? null
          : decodeRecordFunction(record.fn),
  };
}

/** The files whose source positions `record` holds, other than `own`:
 * those of its JSON function and entries, and `named` for a binary
 * function. */
function positionFiles(record: UnitRecord, named: readonly string[] | null, own: string): string[] {
  const files = new Set<string>();
  if (named !== null) for (const file of named) if (file !== own) files.add(file);
  const scan = (text: string): void => {
    const pattern = /"file":("(?:[^"\\]|\\.)*")/g;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const file = JSON.parse(match[1]!) as string;
      if (file !== own) files.add(file);
    }
  };
  if (typeof record.fn === "string") scan(record.fn);
  for (const entries of Object.values(record.tables)) for (const entry of entries) scan(entry);
  return [...files].sort();
}

/** A SHA-256 digest of `text`, in hex. */
function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One declaration of a module's declaration table. */
interface Declaration {
  /** The declaration's kind and name, with an ordinal for repeated ones:
   * the same declaration across builds. */
  readonly key: string;
  /** The names other text refers to it by. */
  readonly names: readonly string[];
  /** Whether it is a class or interface member: other text reaches it only
   * through a value whose type names the owner. */
  readonly member: boolean;
  /** For an interface member, the interface: another surface of the member
   * is another type of its owner. A class's type as lowering sees it is in
   * its header's facts instead. */
  readonly owner: string | null;
  /** Digests of its text, its surface and its facts. */
  readonly text: string;
  readonly surface: string;
  readonly facts: string;
  /** The names its text assigns. */
  readonly assigns: readonly string[];
}

/** A site that refers to a module's namespace object: the names that hold
 * or contain it, and a digest of the module's exports. */
interface NamespaceSite {
  readonly key: string;
  readonly names: readonly string[];
  readonly exports: string;
}

/** What a build records about one of the program's own modules. */
interface FileTable {
  readonly path: string;
  readonly text: string;
  /** The file entry holding its units' records, or "" when it has none. */
  entry: string;
  readonly declarations: readonly Declaration[];
  readonly namespaces: readonly NamespaceSite[];
}

/** A declaration of this build's program, for the closure over surfaces:
 * the names it declares, its owner's, and its node. A class or interface
 * header is its statement without the members. */
interface DeclarationNode {
  readonly names: readonly string[];
  readonly member: boolean;
  readonly owner: string | null;
  readonly node: ts.Node;
  readonly header: boolean;
  readonly js: boolean;
}

/** The body of a function-like node whose body other declarations' types
 * cannot see: it declares its return type, or it is a constructor or set
 * accessor. Undefined for other nodes. */
function opaqueBody(node: ts.Node): ts.Node | undefined {
  if (!ts.isFunctionLikeDeclaration(node) || node.body === undefined) return undefined;
  return node.type !== undefined || ts.isConstructorDeclaration(node) || ts.isSetAccessor(node)
    ? node.body
    : undefined;
}

/** The name node of a declaration or member, if it has one. */
function nameNodeOf(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isPropertySignature(node) ||
    ts.isMethodSignatureDeclaration(node)
  )
    return node.name ?? undefined;
  return undefined;
}

/** The kinds the name walks materialize. */
const NAME_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
]);

/** The kinds of string literals. */
const STRING_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
]);

/** The kinds that assign to their operand. */
const WRITE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.DeleteExpression,
]);

/** The operators of assignments. */
const ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** The identifier names `node`'s text spells, all of them or only those
 * outside the bodies opaqueBody names. */
function spelledNames(node: ts.Node, surfaceOnly: boolean, out: Set<string>): void {
  if (!surfaceOnly) {
    ts.walkPreorder(
      node,
      (child) => {
        out.add((child as ts.Identifier).text);
      },
      NAME_KINDS,
    );
    return;
  }
  ts.walkPreorder(node, (child) => {
    if (ts.isIdentifier(child) || ts.isPrivateIdentifier(child)) {
      out.add(child.text);
      return undefined;
    }
    const parent = child.parent;
    if (parent !== undefined && opaqueBody(parent) === child) return "skip";
    return undefined;
  });
}

/** The names `node`'s text writes to outside it: the bindings, properties
 * and elements that its assignments, `++`, `--` and `delete` target, but
 * not bindings declared inside `node`. A property write names the property;
 * an element write names what the element's object spells. */
function assignedNames(node: ts.Node, hooks: UnitReuseHooks): string[] {
  const out = new Set<string>();
  const spellsOutside = (expression: ts.Node): void => {
    ts.walkPreorder(
      expression,
      (child) => {
        if (ts.isIdentifier(child)) {
          if (!hooks.isLocal(child, node)) out.add(child.text);
        } else if (ts.isPrivateIdentifier(child)) out.add(child.text);
      },
      NAME_KINDS,
    );
  };
  const written = (target: ts.Node): void => {
    if (ts.isParenthesizedExpression(target)) written(target.expression);
    else if (ts.isIdentifier(target)) {
      if (!hooks.isLocal(target, node)) out.add(target.text);
    } else if (ts.isPropertyAccessExpression(target)) out.add(target.name.text);
    else if (ts.isElementAccessExpression(target)) spellsOutside(target.expression);
    else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties.nodes) {
        if (ts.isShorthandPropertyAssignment(property)) written(property.name);
        else if (ts.isPropertyAssignment(property)) written(property.initializer);
        else if (ts.isSpreadAssignment(property)) written(property.expression);
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements.nodes)
        written(ts.isSpreadElement(element) ? element.expression : element);
    } else if (ts.isBinaryExpression(target)) written(target.left);
    else spellsOutside(target);
  };
  ts.walkPreorder(
    node,
    (child) => {
      if (ts.isBinaryExpression(child)) {
        if (ASSIGNMENTS.has(child.operatorToken.kind)) written(child.left);
      } else if (ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) {
        if (
          child.operator === ts.SyntaxKind.PlusPlusToken ||
          child.operator === ts.SyntaxKind.MinusMinusToken
        )
          written(child.operand);
      } else if (ts.isDeleteExpression(child)) written(child.expression);
    },
    WRITE_KINDS,
  );
  return [...out].sort();
}

/** `node`'s text with the bodies opaqueBody names replaced by `{}`. */
function surfaceText(sf: ts.SourceFile, node: ts.Node, js: boolean): string {
  const text = sf.text;
  const start = node.getStart(sf);
  if (js) return text.slice(start, node.end);
  const cuts: [number, number][] = [];
  ts.walkPreorder(node, (child) => {
    const body = child === node ? undefined : opaqueBody(child);
    if (body === undefined) return undefined;
    cuts.push([body.getStart(sf), body.end]);
    return "skip";
  });
  let out = "";
  let at = start;
  for (const [from, to] of cuts) {
    if (from < at) continue;
    out += text.slice(at, from) + "{}";
    at = to;
  }
  return out + text.slice(at, node.end);
}

/** The names a statement declares. A statement without a name (an
 * expression statement, a loop) declares the names it assigns, such as the
 * base of an expando `f.prop = value`; in JavaScript, where such statements
 * also define exports, every name and string it spells. */
function statementNames(statement: ts.Statement, js: boolean, hooks: UnitReuseHooks): string[] {
  const names = declaredNames(statement, js, hooks);
  // A default export also declares the module's `default`, the name a
  // default import holds (Alias), also when it has no name of its own.
  return isDefaultExport(statement) && !names.includes("default") ? [...names, "default"] : names;
}

/** Whether `statement` is its module's default export: `export default`
 * or `export =`. */
function isDefaultExport(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return true;
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;
}

/** The names `statement` declares (statementNames), apart from `default`. */
function declaredNames(statement: ts.Statement, js: boolean, hooks: UnitReuseHooks): string[] {
  if (ts.isVariableStatement(statement)) {
    const names: string[] = [];
    for (const declaration of statement.declarationList.declarations.nodes) {
      const name = declaration.name;
      if (ts.isIdentifier(name)) names.push(name.text);
      else
        ts.walkPreorder(
          name,
          (child) => {
            names.push((child as ts.Identifier).text);
          },
          NAME_KINDS,
        );
    }
    return names;
  }
  if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
    const names = new Set<string>();
    spelledNames(statement, false, names);
    return [...names].sort();
  }
  const name = nameNodeOf(statement);
  if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return [name.text];
  if (!js) return assignedNames(statement, hooks);
  const names = new Set<string>();
  spelledNames(statement, false, names);
  ts.walkPreorder(statement, (child) => {
    if (ts.isStringLiteral(child)) names.add(child.text);
    return undefined;
  });
  return [...names].sort();
}

/** Whether a statement of a module changes names outside the module:
 * `declare global`, a module augmentation, or `export * from`. */
function hasGlobalEffect(statement: ts.Statement): boolean {
  if (ts.isModuleDeclaration(statement)) {
    const name = statement.name;
    return !ts.isIdentifier(name) || name.text === "global";
  }
  return ts.isExportDeclaration(statement) && statement.exportClause === undefined;
}

/** The names a class or interface member declares: its name, or the
 * identifiers a computed name spells. */
function memberNames(member: ts.Node): string[] {
  const name = nameNodeOf(member);
  if (name === undefined) return ts.isConstructorDeclaration(member) ? ["constructor"] : [];
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))
    return [name.text];
  const names = new Set<string>();
  spelledNames(name, false, names);
  if (names.size === 0) names.add(name.getText());
  return [...names].sort();
}

/** The sites in `node` that refer to a module's namespace object: a
 * namespace import or re-export, `import x = require()`, and `import()` and
 * `require()` calls with a string, which `names` stand for. */
function namespaceSites(
  sf: ts.SourceFile,
  statement: ts.Statement,
  names: readonly string[],
  hooks: UnitReuseHooks,
  out: NamespaceSite[],
): void {
  const add = (specifier: ts.Node, holders: readonly string[]): void => {
    const exports = hooks.exportsOf(specifier);
    if (exports === null) return;
    out.push({
      key: `${specifier.getText(sf)}\n${holders.join(",")}`,
      names: holders,
      exports: digestOf(exports),
    });
  };
  if (ts.isImportDeclaration(statement)) {
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings))
      add(statement.moduleSpecifier, [bindings.name.text]);
    return;
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    const reference = statement.moduleReference;
    if (ts.isExternalModuleReference(reference)) add(reference.expression, [statement.name.text]);
    return;
  }
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (
      clause !== undefined &&
      ts.isNamespaceExport(clause) &&
      statement.moduleSpecifier !== undefined
    )
      add(statement.moduleSpecifier, [clause.name.getText(sf)]);
    return;
  }
  const text = sf.text.slice(statement.pos, statement.end);
  if (!text.includes("import(") && !text.includes("require(")) return;
  ts.walkPreorder(statement, (child) => {
    if (!ts.isCallExpression(child)) return undefined;
    const callee = child.expression;
    const first = child.arguments.nodes[0];
    if (first === undefined || !ts.isStringLiteralLike(first)) return undefined;
    if (
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === "require")
    )
      add(first, names);
    return undefined;
  });
}

/** A name a binding of a module's text holds under another name: `from`
 * is the imported or exported name, `to` the local or exported one
 * (`import { from as to }`, `import to from`, whose `from` is `default`,
 * `export { from as to }`, `export default from`). Text that spells `to`
 * reaches the declaration of `from`. */
type Alias = readonly [from: string, to: string];

/** The aliases `statement` makes (Alias). `names` are the names it
 * declares. */
function aliasesOf(statement: ts.Statement, names: readonly string[], out: Alias[]): void {
  const add = (from: string, to: string): void => {
    if (from !== to) out.push([from, to]);
  };
  const specifiers = (elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): void => {
    for (const element of elements)
      add((element.propertyName ?? element.name).text, element.name.text);
  };
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.name !== undefined) add("default", clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) specifiers(bindings.elements.nodes);
    return;
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    const reference = statement.moduleReference;
    if (ts.isIdentifier(reference)) add(reference.text, statement.name.text);
    else if (ts.isQualifiedName(reference)) add(reference.right.text, statement.name.text);
    return;
  }
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) specifiers(clause.elements.nodes);
    return;
  }
  if (isDefaultExport(statement)) {
    for (const name of names) add(name, "default");
    return;
  }
  // `const { from: to } = require("...")`.
  if (ts.isVariableStatement(statement))
    for (const declaration of statement.declarationList.declarations.nodes) {
      const initializer = declaration.initializer;
      if (
        !ts.isObjectBindingPattern(declaration.name) ||
        initializer === undefined ||
        !ts.isCallExpression(initializer) ||
        !ts.isIdentifier(initializer.expression) ||
        initializer.expression.text !== "require"
      )
        continue;
      for (const element of declaration.name.elements.nodes)
        if (
          element.propertyName !== undefined &&
          ts.isIdentifier(element.propertyName) &&
          ts.isIdentifier(element.name)
        )
          add(element.propertyName.text, element.name.text);
    }
}

/** A module's declaration table, its declarations' nodes, and the text of
 * its statements with global effect. A file that is not a module has global
 * effect as a whole. */
function fileTable(
  sf: ts.SourceFile,
  hooks: UnitReuseHooks,
  previous: FileTable | undefined,
): { table: FileTable; nodes: DeclarationNode[]; aliases: Alias[]; global: string } {
  // A declaration with the text it had in the previous build writes what it
  // wrote then.
  const before = new Map((previous?.declarations ?? []).map((d) => [d.key, d]));
  const assigns = (key: string, text: string, node: ts.Node): readonly string[] => {
    const then = before.get(key);
    return then !== undefined && then.text === text ? then.assigns : assignedNames(node, hooks);
  };
  const js = isJsSourceFileName(sf.fileName);
  const declarations: Declaration[] = [];
  const namespaces: NamespaceSite[] = [];
  const nodes: DeclarationNode[] = [];
  const aliases: Alias[] = [];
  const keys = new Set<string>();
  let global = "";
  const unique = (key: string): string => {
    let out = key;
    for (let ordinal = 1; keys.has(out); ordinal++) out = `${key}#${ordinal}`;
    keys.add(out);
    return out;
  };
  const module = ts.isExternalModule(sf) || js;
  for (const statement of sf.statements.nodes) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      namespaceSites(sf, statement, [], hooks, namespaces);
      aliasesOf(statement, [], aliases);
      continue;
    }
    if (!module || hasGlobalEffect(statement)) {
      global += sf.text.slice(statement.getStart(sf), statement.end) + "\n";
      continue;
    }
    const names = statementNames(statement, js, hooks);
    namespaceSites(sf, statement, names, hooks, namespaces);
    aliasesOf(statement, names, aliases);
    const kind = String(statement.kind);
    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      // Each member is a declaration of its own; the rest of the class or
      // interface (its name, type parameters, heritage and modifiers) is the
      // header, named by the class, and holds the class's facts.
      const owner = names[0] ?? "";
      const seeds = ts.isInterfaceDeclaration(statement) ? owner : null;
      for (const member of statement.members.nodes) {
        const declared = memberNames(member);
        const key = unique(`${kind}:${owner}.${declared.join(",")}`);
        const text = digestOf(sf.text.slice(member.getStart(sf), member.end));
        declarations.push({
          key,
          names: declared,
          member: true,
          owner: seeds,
          text,
          surface: digestOf(surfaceText(sf, member, js)),
          facts: "",
          assigns: assigns(key, text, member),
        });
        nodes.push({
          names: declared,
          member: true,
          owner: seeds,
          node: member,
          header: false,
          js,
        });
      }
      const members = statement.members;
      const header =
        sf.text.slice(statement.getStart(sf), members.pos) +
        sf.text.slice(members.end, statement.end);
      const digest = digestOf(header);
      declarations.push({
        key: unique(`${kind}:${owner}`),
        names,
        member: false,
        owner: null,
        text: digest,
        surface: digest,
        facts: digestOf(hooks.facts(statement)),
        assigns: [],
      });
      nodes.push({ names, member: false, owner: null, node: statement, header: true, js });
      continue;
    }
    const digest = digestOf(sf.text.slice(statement.getStart(sf), statement.end));
    const key = unique(`${kind}:${names.join(",")}`);
    declarations.push({
      key,
      names,
      member: false,
      owner: null,
      text: digest,
      surface: js ? digest : digestOf(surfaceText(sf, statement, js)),
      facts: digestOf(hooks.facts(statement)),
      assigns: assigns(key, digest, statement),
    });
    nodes.push({ names, member: false, owner: null, node: statement, header: false, js });
  }
  return {
    table: {
      path: sf.fileName,
      text: digestOf(sf.text),
      entry: "",
      declarations,
      namespaces,
    },
    nodes,
    aliases,
    global,
  };
}

/** The names a declaration's surface spells: a JavaScript declaration's
 * whole text, a header without its members. */
function surfaceNames(declaration: DeclarationNode): Set<string> {
  const names = new Set<string>();
  if (!declaration.header) {
    spelledNames(declaration.node, !declaration.js, names);
    return names;
  }
  const members = new Set<ts.Node>(
    (declaration.node as ts.ClassDeclaration | ts.InterfaceDeclaration).members.nodes,
  );
  ts.walkPreorder(declaration.node, (child) => {
    if (members.has(child)) return "skip";
    if (ts.isIdentifier(child) || ts.isPrivateIdentifier(child)) names.add(child.text);
    return undefined;
  });
  return names;
}

/** What a build knows about the units it lowers, and what it writes. */
export class UnitReuse {
  /** Whether this build records its units. A build that finds no program
   * entry, the first one into a cache, records none: it lowers as a build
   * without reuse does and writes only the declaration tables, so that
   * recording costs the next build instead. */
  readonly records: boolean;
  /** The previous build's tables by path, when its program digest matches. */
  private readonly previous: Map<string, FileTable> | null;
  /** The names whose declarations changed since the previous build. */
  private readonly changed: Set<string>;
  /** The decoded file entries by path. */
  private readonly decoded = new Map<string, Map<string, StoredUnit> | null>();
  /** The records this build made or applied, by file path, in unit order. */
  private readonly written = new Map<string, Map<string, StoredUnit>>();
  /** Files whose units this build lowered. */
  private readonly rewritten = new Set<string>();
  /** Counts, and the time opening (tables and changed names) and finishing
   * (writing entries) took, in milliseconds. */
  readonly stats = {
    candidates: 0,
    hits: 0,
    misses: 0,
    changedNames: 0,
    openMs: 0,
    readMs: 0,
    finishMs: 0,
    /** Functions this build stored in the binary encoding, and as JSON, and
     * the time making their units' entries took. */
    binary: 0,
    json: 0,
    storeMs: 0,
  };

  private constructor(
    private readonly store: UnitStore,
    private readonly program: string,
    private readonly tables: Map<string, FileTable>,
    previous: { program: string; tables: Map<string, FileTable> } | null,
    nodes: readonly DeclarationNode[],
    aliases: readonly Alias[],
  ) {
    this.previous = previous !== null && previous.program === program ? previous.tables : null;
    this.records = previous !== null;
    this.changed =
      this.previous === null ? new Set() : changedNames(this.previous, tables, nodes, aliases);
    this.stats.changedNames = this.changed.size;
  }

  /** Opens reuse for a build of `files`, the program's own modules in
   * module order, within `program`. */
  static open(
    store: UnitStore,
    program: ts.Program,
    files: readonly ts.SourceFile[],
    hooks: UnitReuseHooks,
  ): UnitReuse {
    const started = performance.now();
    const own = new Set(files);
    const tables = new Map<string, FileTable>();
    const nodes: DeclarationNode[] = [];
    const aliases: Alias[] = [];
    const previous = readProgram(store);
    const digest = createHash("sha256").update(
      `${PROGRAM_MAGIC}\n${IR_VERSION}\n${IR_CODEC_LAYOUT}\n`,
    );
    for (const sf of files) {
      const file = fileTable(sf, hooks, previous?.tables.get(sf.fileName));
      tables.set(sf.fileName, file.table);
      for (const node of file.nodes) nodes.push(node);
      for (const alias of file.aliases) aliases.push(alias);
      digest.update(`${sf.fileName}\n${digestOf(file.global)}\n`);
    }
    const others = program
      .getSourceFiles()
      .filter((sf) => !own.has(sf))
      .map((sf) => `${sf.fileName}\n${digestOf(sf.text)}\n`)
      .sort();
    for (const other of others) digest.update(other);
    const reuse = new UnitReuse(store, digest.digest("hex"), tables, previous, nodes, aliases);
    reuse.stats.openMs = performance.now() - started;
    return reuse;
  }

  /** The stored record of unit `name`, whose text is `source` in `file`
   * inside the declarations `owners`, when the unit can apply it. */
  candidate(
    name: string,
    file: string,
    source: ts.Node | null,
    owners: readonly ts.Node[],
  ): StoredRecord | null {
    if (this.previous === null || source === null) return null;
    const before = this.previous.get(file);
    const now = this.tables.get(file);
    if (
      before === undefined ||
      now === undefined ||
      before.text !== now.text ||
      before.entry === ""
    )
      return null;
    let units = this.decoded.get(file);
    if (units === undefined) {
      const started = performance.now();
      units = readFileEntry(this.store, before.entry);
      this.decoded.set(file, units);
      this.stats.readMs += performance.now() - started;
    }
    const stored = units?.get(name);
    if (stored === undefined) return null;
    this.stats.candidates++;
    for (const other of stored.files) {
      const then = this.previous.get(other);
      if (then === undefined || then.text !== this.tables.get(other)?.text) return null;
    }
    if (this.changed.size > 0) {
      const names = new Set<string>();
      spelledNames(source, false, names);
      // A string can name a member too (`value["name"]`, `keyof` types).
      ts.walkPreorder(
        source,
        (child) => {
          names.add((child as ts.StringLiteral).text);
        },
        STRING_KINDS,
      );
      for (const owner of owners) {
        const ownerName = nameNodeOf(owner);
        if (ownerName !== undefined && ts.isIdentifier(ownerName)) names.add(ownerName.text);
      }
      for (const spelled of names) if (this.changed.has(spelled)) return null;
    }
    return storedRecord(stored);
  }

  /** Notes the record a unit of `file` lowered to, with the files its
   * binary function names (RecordedUnit.files), or the stored record it
   * applied (`applied`). A unit without a record is noted with null. */
  note(
    name: string,
    file: string,
    record: UnitRecord | null,
    applied: boolean,
    files: readonly string[] | null,
  ): void {
    let units = this.written.get(file);
    if (units === undefined) {
      units = new Map();
      this.written.set(file, units);
    }
    if (record !== null) {
      let unit = applied ? this.decoded.get(file)?.get(name) : undefined;
      if (unit === undefined) {
        const started = performance.now();
        unit = storedUnit(record, files, file);
        this.stats.storeMs += performance.now() - started;
        if (unit.bytes !== null) this.stats.binary++;
        else if (unit.record.fn !== null) this.stats.json++;
      }
      units.set(name, unit);
    }
    if (applied) this.stats.hits++;
    else {
      this.stats.misses++;
      this.rewritten.add(file);
    }
  }

  /** Writes the file entries of files whose units changed and the program
   * entry. A file none of whose units this build lowered or applied keeps
   * no entry. */
  finish(): void {
    const started = performance.now();
    for (const [path, table] of this.tables) {
      const units = this.written.get(path);
      if (units === undefined || units.size === 0) continue;
      const before = this.previous?.get(path);
      const unchanged =
        before !== undefined &&
        before.text === table.text &&
        before.entry !== "" &&
        !this.rewritten.has(path) &&
        this.decoded.get(path)?.size === units.size;
      table.entry = unchanged ? before.entry : this.store.writeFile(encodeFileEntry(units));
    }
    this.store.writeProgram(encodeProgramEntry(this.program, this.tables));
    this.stats.finishMs = performance.now() - started;
  }
}

/** The changed names of a build (see the comment at the top) from the
 * previous build's tables and this build's. */
function changedNames(
  before: Map<string, FileTable>,
  now: Map<string, FileTable>,
  nodes: readonly DeclarationNode[],
  aliases: readonly Alias[],
): Set<string> {
  const surfaces = new Set<string>();
  const direct = new Set<string>();
  // Text reaches a member through a value whose type names its owner, so a
  // member with another type stops the units that spell it, and an
  // interface's member gives the interface another type. A class's own type
  // changes with its header's facts.
  const typeChanged = (declaration: {
    readonly names: readonly string[];
    readonly member: boolean;
    readonly owner: string | null;
  }): void => {
    for (const name of declaration.names) (declaration.member ? direct : surfaces).add(name);
    if (declaration.owner !== null) surfaces.add(declaration.owner);
  };
  const compare = (from: FileTable | undefined, to: FileTable | undefined): void => {
    const old = new Map((from?.declarations ?? []).map((d) => [d.key, d]));
    const seen = new Set<string>();
    for (const declaration of to?.declarations ?? []) {
      seen.add(declaration.key);
      const previous = old.get(declaration.key);
      if (
        previous === undefined ||
        previous.surface !== declaration.surface ||
        previous.facts !== declaration.facts
      )
        typeChanged(declaration);
      else if (previous.text !== declaration.text)
        for (const name of declaration.names) direct.add(name);
      else continue;
      for (const name of declaration.assigns) direct.add(name);
      for (const name of previous?.assigns ?? []) direct.add(name);
    }
    for (const declaration of from?.declarations ?? [])
      if (!seen.has(declaration.key)) {
        typeChanged(declaration);
        for (const name of declaration.assigns) direct.add(name);
      }
    const sites = new Map((from?.namespaces ?? []).map((site) => [site.key, site.exports]));
    for (const site of to?.namespaces ?? [])
      if (sites.get(site.key) !== site.exports) for (const name of site.names) surfaces.add(name);
  };
  for (const [path, table] of now) compare(before.get(path), table);
  for (const [path, table] of before) if (!now.has(path)) compare(table, undefined);
  // A name that holds a changed name under another name changes the same
  // way (Alias).
  const follow = (): boolean => {
    let grew = false;
    for (const [from, to] of aliases) {
      if (surfaces.has(from) && !surfaces.has(to)) {
        surfaces.add(to);
        grew = true;
      }
      if (direct.has(from) && !direct.has(to)) {
        direct.add(to);
        grew = true;
      }
    }
    return grew;
  };
  let pending: { declaration: DeclarationNode; spells: Set<string> }[] | null = null;
  for (let grew = true; grew;) {
    grew = follow();
    if (surfaces.size === 0) continue;
    // A declaration whose surface spells a changed name can have another
    // type now (typeChanged); repeat until no surface or alias adds a name.
    pending ??= nodes.map((declaration) => ({
      declaration,
      spells: surfaceNames(declaration),
    }));
    for (let index = 0; index < pending.length; index++) {
      const entry = pending[index]!;
      let hit = false;
      for (const name of entry.spells)
        if (surfaces.has(name)) {
          hit = true;
          break;
        }
      if (!hit) continue;
      typeChanged(entry.declaration);
      // Each declaration joins once.
      pending[index] = pending[pending.length - 1]!;
      pending.pop();
      index--;
      grew = true;
    }
  }
  for (const name of direct) surfaces.add(name);
  return surfaces;
}

function encodeProgramEntry(program: string, tables: Map<string, FileTable>): Uint8Array {
  const lines = [PROGRAM_MAGIC, program];
  for (const table of tables.values()) lines.push(JSON.stringify(table));
  return Buffer.from(lines.join("\n"), "utf8");
}

function readProgram(store: UnitStore): { program: string; tables: Map<string, FileTable> } | null {
  const bytes = store.readProgram();
  if (bytes === null) return null;
  try {
    const lines = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString("utf8")
      .split("\n");
    if (lines[0] !== PROGRAM_MAGIC || lines.length < 2) return null;
    const tables = new Map<string, FileTable>();
    for (const line of lines.slice(2)) {
      const table = JSON.parse(line) as FileTable;
      tables.set(table.path, table);
    }
    return { program: lines[1]!, tables };
  } catch {
    // An unreadable entry is a miss.
    return null;
  }
}

/** A file entry: per stored unit, the unit without its function's bytes as
 * JSON, then the bytes when it has them. */
function encodeFileEntry(units: Map<string, StoredUnit>): Uint8Array {
  const w = new IrWriter();
  w.str(FILE_MAGIC);
  w.length(units.size);
  for (const unit of units.values()) {
    w.str(JSON.stringify({ record: unit.record, files: unit.files }));
    if (unit.bytes === null) w.byte(0);
    else {
      w.byte(1);
      w.blob(unit.bytes);
    }
  }
  return w.finish();
}

function readFileEntry(store: UnitStore, name: string): Map<string, StoredUnit> | null {
  const bytes = store.readFile(name);
  if (bytes === null) return null;
  try {
    const r = new IrReader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (r.str() !== FILE_MAGIC) return null;
    const units = new Map<string, StoredUnit>();
    for (let count = r.length(); count > 0; count--) {
      const unit = JSON.parse(r.str()) as { record: UnitRecord; files: string[] };
      const fn = r.byte() === 0 ? null : r.blob();
      units.set(unit.record.name, { record: unit.record, files: unit.files, bytes: fn });
    }
    return r.done() ? units : null;
  } catch {
    return null;
  }
}

/** Throws when a unit lowered to another record than its stored one
 * (SCRIPTC_INCR_VERIFY=1), naming the unit and the first part that
 * differs. `pending` is the stored record's entries the tables did not hold
 * at the unit's turn. */
export function verifyStoredUnit(
  name: string,
  storedRecord: StoredRecord,
  pending: Readonly<Record<string, readonly string[]>>,
  lowered: UnitRecord | null,
  reasons: readonly string[],
): void {
  const stored = storedRecord.record;
  const fail = (what: string): never => {
    throw new InternalCompilerError(
      `SCRIPTC_INCR_VERIFY: unit ${name} lowered to another ${what} than its stored record`,
    );
  };
  if (lowered === null) return fail(`result (no record: ${reasons.join(", ")})`);
  if (lowered.poisoned !== stored.poisoned) fail("poison");
  // As JSON text, which keeps key order, whichever encoding each record has.
  const text = (fn: IrFunction | null): string | null =>
    fn === null ? null : (encodeUnitFunction(fn) ?? "");
  const loweredFn = lowered.fn === null ? null : decodeRecordFunction(lowered.fn);
  if (text(loweredFn) !== text(storedRecord.fn())) fail("function");
  if (JSON.stringify(lowered.events) !== JSON.stringify(stored.events)) fail("event list");
  // A stored entry the tables hold already is one an earlier unit of this
  // build added: applying the record leaves it as it is.
  if (JSON.stringify(lowered.tables) !== JSON.stringify(pending)) fail("table entries");
}
