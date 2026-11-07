/* Meaning-preserving rewrites for the metamorphic lane.
 *
 * Each rewrite turns a program into one JavaScript defines to behave the
 * same: a value takes a detour that hands back the same value, or code moves
 * to a place where it runs the same way. A corpus program that matches Node
 * must therefore still build and still match Node after any of them.
 *
 * The rewrites work on syntax alone. A rewrite that does not apply to a
 * program answers null. One that tsc then rejects (an inference that no
 * longer holds, a write through a `Readonly`) or that changes Node's own
 * output (a stack trace that names a file) is not a valid test of scriptc;
 * the lane detects both and skips the variant.
 */
import ts from "typescript";

const K = ts.SyntaxKind;

/** Wrappers a `const`/`let` initializer is routed through, by rewrite. */
const HELPERS = {
  // A generic function that returns its argument.
  id: "function __same<T>(v: T): T { return v; }\n",
  // Through `unknown` and a cast back.
  unknown: "function __same<T>(v: T): T { const u: unknown = v; return u as T; }\n",
  // Through a field of a fresh record.
  field: "function __same<T>(v: T): T { const box = { v }; return box.v; }\n",
  // Through an element of a fresh array.
  array: "function __same<T>(v: T): T { const items: T[] = [v]; return items[0] as T; }\n",
};

function parse(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function contains(node, predicate) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (predicate(child)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** What an arrow function would rebind or cannot contain. */
function boundToItsFunction(node) {
  return (
    node.kind === K.AwaitExpression ||
    node.kind === K.YieldExpression ||
    node.kind === K.ThisKeyword ||
    node.kind === K.SuperKeyword ||
    (node.kind === K.Identifier && node.text === "arguments")
  );
}

/** A function or class expression takes its `name` from the binding it
 * initializes, so wrapping one would change what the program can print. */
function namedByItsBinding(initializer) {
  let inner = initializer;
  while (
    inner.kind === K.ParenthesizedExpression ||
    inner.kind === K.AsExpression ||
    inner.kind === K.SatisfiesExpression ||
    inner.kind === K.NonNullExpression
  ) {
    inner = inner.expression;
  }
  return (
    inner.kind === K.ArrowFunction ||
    inner.kind === K.FunctionExpression ||
    inner.kind === K.ClassExpression
  );
}

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/** `const`/`let`/`var` declarations with an initializer, in statements (not
 * loop heads), that are not `using` and not ambient. */
function initializedDeclarations(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (
      node.kind === K.VariableDeclaration &&
      node.initializer !== undefined &&
      node.parent.kind === K.VariableDeclarationList &&
      node.parent.parent.kind === K.VariableStatement
    ) {
      const blockScope = node.parent.flags & ts.NodeFlags.BlockScoped;
      const usingDeclaration =
        blockScope === ts.NodeFlags.Using || blockScope === ts.NodeFlags.AwaitUsing;
      if (!usingDeclaration && !hasModifier(node.parent.parent, K.DeclareKeyword)) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Where a helper goes: after the directive head and the leading imports. */
function helperPosition(sourceFile, source) {
  let position = 0;
  for (const statement of sourceFile.statements) {
    if (statement.kind !== K.ImportDeclaration) break;
    position = statement.end;
  }
  if (position > 0) return position;
  const lines = source.split("\n");
  for (let i = 0; i < 2 && i < lines.length && lines[i].startsWith("// @"); i++) {
    position += lines[i].length + 1;
  }
  return position;
}

/** Applies insertions right to left; at one position a closing text goes
 * before an opening one, so nested wrappers stay nested. */
function insertAll(source, insertions) {
  const ordered = [...insertions].sort((a, b) => b.at - a.at || a.closes - b.closes);
  let text = source;
  for (const { at, text: inserted } of ordered)
    text = text.slice(0, at) + inserted + text.slice(at);
  return text;
}

function wrapInitializers(source, fileName, open, close, accepts) {
  const sourceFile = parse(source, fileName);
  const insertions = [];
  let sites = 0;
  for (const declaration of initializedDeclarations(sourceFile)) {
    const initializer = declaration.initializer;
    if (namedByItsBinding(initializer) || !accepts(declaration)) continue;
    sites++;
    insertions.push({ at: initializer.getStart(sourceFile), closes: 0, text: open(declaration) });
    insertions.push({ at: initializer.end, closes: 1, text: close(declaration, sourceFile) });
  }
  return sites === 0 ? null : { sourceFile, sites, text: insertAll(source, insertions) };
}

function throughHelper(helper) {
  return (source, fileName) => {
    const wrapped = wrapInitializers(
      source,
      fileName,
      () => "__same(",
      () => ")",
      () => true,
    );
    if (wrapped === null) return null;
    // Every wrapped site follows the leading imports, so the position
    // computed for the original text still names the same place.
    const at = helperPosition(wrapped.sourceFile, source);
    const text = `${wrapped.text.slice(0, at)}\n${HELPERS[helper]}${wrapped.text.slice(at)}`;
    return { files: { "main.ts": text }, sites: wrapped.sites };
  };
}

/** `const x = e` becomes `const x = (() => (e))()`. */
function throughArrow(source, fileName) {
  const wrapped = wrapInitializers(
    source,
    fileName,
    () => "(() => (",
    () => "))()",
    (declaration) => !contains(declaration.initializer, boundToItsFunction),
  );
  return wrapped === null ? null : { files: { "main.ts": wrapped.text }, sites: wrapped.sites };
}

/** `const x: T = e` becomes `const x: T = (e as unknown as T)`: the value
 * goes through `unknown` and a checked cast to its own declared type. */
function throughCast(source, fileName) {
  const wrapped = wrapInitializers(
    source,
    fileName,
    () => "((",
    (declaration, sourceFile) => `) as unknown as ${declaration.type.getText(sourceFile)})`,
    (declaration) => declaration.type !== undefined,
  );
  return wrapped === null ? null : { files: { "main.ts": wrapped.text }, sites: wrapped.sites };
}

/** `const x: T = e` becomes `const x: Readonly<T> = e`: the annotation widens
 * to a type with the same properties that every T is assignable to. Only
 * object types the program declares itself are widened; `Readonly` of a
 * primitive is the primitive, and of a builtin class it is a type nobody
 * writes. */
function widenAnnotation(source, fileName) {
  const sourceFile = parse(source, fileName);
  const objectTypes = new Set();
  for (const statement of sourceFile.statements) {
    if (
      statement.kind === K.InterfaceDeclaration ||
      (statement.kind === K.TypeAliasDeclaration && statement.type.kind === K.TypeLiteral)
    ) {
      if (statement.typeParameters === undefined) objectTypes.add(statement.name.text);
    }
  }
  const insertions = [];
  let sites = 0;
  for (const declaration of initializedDeclarations(sourceFile)) {
    const type = declaration.type;
    if (type === undefined || declaration.name.kind !== K.Identifier) continue;
    const declaredObjectType =
      type.kind === K.TypeLiteral ||
      (type.kind === K.TypeReference &&
        type.typeArguments === undefined &&
        type.typeName.kind === K.Identifier &&
        objectTypes.has(type.typeName.text));
    if (!declaredObjectType) continue;
    sites++;
    insertions.push({ at: type.getStart(sourceFile), closes: 0, text: "Readonly<" });
    insertions.push({ at: type.end, closes: 1, text: ">" });
  }
  return sites === 0 ? null : { files: { "main.ts": insertAll(source, insertions) }, sites };
}

/** The whole program moves into a function that is called once, so its
 * module-level bindings become locals. */
function intoFunction(source, fileName) {
  const sourceFile = parse(source, fileName);
  const pinnedToModule = sourceFile.statements.some(
    (statement) =>
      statement.kind === K.ExportDeclaration ||
      statement.kind === K.ExportAssignment ||
      statement.kind === K.ModuleDeclaration ||
      statement.kind === K.ImportEqualsDeclaration ||
      hasModifier(statement, K.ExportKeyword) ||
      hasModifier(statement, K.DeclareKeyword),
  );
  if (pinnedToModule) return null;
  let topLevelOnly = false;
  const visit = (node) => {
    if (topLevelOnly) return;
    if (
      ts.isFunctionLike(node) ||
      node.kind === K.ClassDeclaration ||
      node.kind === K.ClassExpression
    )
      return;
    const awaitUsing =
      node.kind === K.VariableDeclarationList &&
      (node.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.AwaitUsing;
    if (
      node.kind === K.AwaitExpression ||
      node.kind === K.ThisKeyword ||
      (node.kind === K.ForOfStatement && node.awaitModifier !== undefined) ||
      awaitUsing
    ) {
      topLevelOnly = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (topLevelOnly) return null;
  const at = helperPosition(sourceFile, source);
  // An import below other statements cannot move into a function.
  const lateImport = sourceFile.statements.some(
    (statement) => statement.kind === K.ImportDeclaration && statement.end > at,
  );
  if (lateImport || source.slice(at).trim() === "") return null;
  const text = `${source.slice(0, at)}\nfunction __program(): void {\n${source.slice(at)}\n}\n__program();\n`;
  return { files: { "main.ts": text }, sites: 1 };
}

function declaredNames(name, into) {
  if (name.kind === K.Identifier) into.add(name.text);
  else
    for (const element of name.elements)
      if (element.name !== undefined) declaredNames(element.name, into);
}

/** Top-level functions that use no other top-level binding move to a second
 * module, and the program imports them back. */
function acrossModules(source, fileName) {
  const sourceFile = parse(source, fileName);
  const topLevel = new Set();
  const functionCounts = new Map();
  for (const statement of sourceFile.statements) {
    if (statement.kind === K.VariableStatement) {
      for (const declaration of statement.declarationList.declarations)
        declaredNames(declaration.name, topLevel);
    } else if (statement.kind === K.ImportDeclaration) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) topLevel.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings?.kind === K.NamespaceImport) topLevel.add(bindings.name.text);
      else if (bindings !== undefined) for (const e of bindings.elements) topLevel.add(e.name.text);
    } else if (statement.name !== undefined && statement.name.kind === K.Identifier) {
      topLevel.add(statement.name.text);
      if (statement.kind === K.FunctionDeclaration) {
        functionCounts.set(statement.name.text, (functionCounts.get(statement.name.text) ?? 0) + 1);
      }
    }
  }
  const tiedToItsModule = (node) =>
    node.kind === K.MetaProperty ||
    (node.kind === K.Identifier &&
      ["__filename", "__dirname", "require", "module", "exports"].includes(node.text));
  const moved = [];
  for (const statement of sourceFile.statements) {
    if (statement.kind !== K.FunctionDeclaration || statement.body === undefined) continue;
    if (statement.name === undefined || functionCounts.get(statement.name.text) !== 1) continue;
    if (hasModifier(statement, K.ExportKeyword) || hasModifier(statement, K.DeclareKeyword))
      continue;
    const own = statement.name.text;
    const usesTopLevel = contains(
      statement,
      (node) => node.kind === K.Identifier && node.text !== own && topLevel.has(node.text),
    );
    if (usesTopLevel || contains(statement, tiedToItsModule)) continue;
    moved.push(statement);
  }
  if (moved.length === 0) return null;
  let main = source;
  for (const statement of [...moved].reverse()) {
    main = main.slice(0, statement.getStart(sourceFile)) + main.slice(statement.end);
  }
  const at = helperPosition(sourceFile, source);
  const names = moved.map((statement) => statement.name.text).join(", ");
  main = `${main.slice(0, at)}\nimport { ${names} } from "./moved.ts";\n${main.slice(at)}`;
  const other = moved.map((statement) => `export ${statement.getText(sourceFile)}\n`).join("\n");
  return { files: { "main.ts": main, "moved.ts": other }, sites: moved.length };
}

/** Every rewrite: (source, fileName) => null | { files, sites }. `files`
 * maps a file name to its text, and `main.ts` is the entry. */
export const rewrites = {
  id: throughHelper("id"),
  unknown: throughHelper("unknown"),
  field: throughHelper("field"),
  array: throughHelper("array"),
  arrow: throughArrow,
  cast: throughCast,
  readonly: widenAnnotation,
  function: intoFunction,
  module: acrossModules,
};

/** Syntax errors in a rewritten file, for the lane's own tests. */
export function syntaxErrors(text, fileName = "main.ts") {
  return parse(text, fileName).parseDiagnostics.map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  );
}
