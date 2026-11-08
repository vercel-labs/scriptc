/* Island-closed module-level constants (instant-start step 4).
 *
 *   import { Type } from "schema-pkg";                  // an island package
 *   const item = Type.Object({ id: Type.String() });
 *   export const list = Type.Array(item);
 *
 * Lowered call by call, each initializer crosses into the island once per
 * call, with its literal arguments exported by reference, and the first of
 * them starts Node while the program's modules still initialize. An
 * initializer that is built only from literals, island imports, other such
 * constants and member reads, calls and `new` on those holds no native
 * value, so the island can evaluate it itself: the build writes each such
 * initializer into an island module of its own (node-islands/
 * generated.ts),
 *
 *   import { Type } from "../../node_modules/schema-pkg/index.mjs";
 *   export const item = Type.Object({ id: Type.String() });
 *
 *   import { Type } from "../../node_modules/schema-pkg/index.mjs";
 *   import { item } from "./main.<digest>.0.mjs";
 *   export const list = Type.Array(item);
 *
 * loads it where the constant is declared, and the constant's initializer
 * becomes a read of the module's export, met with the conversion the
 * original expression's value met (fromIsland). The load is the deferred
 * load of a static island import (`nodeIsland.defer`, node-islands/
 * snapshot.ts): the build-time probe decides whether the module evaluates
 * there or on first use, with its interface snapshot standing in until
 * then. The native constant itself is unchanged: the same global, type,
 * exports and initialization flag.
 *
 * One module per constant, so that each initializer evaluates between the
 * native statements around it exactly as before: a native statement
 * between two closed constants still runs between them, and when a later
 * initializer makes the island call back into the program (a listener the
 * program registered), that code finds the earlier constants assigned.
 *
 * Same program: under Node these expressions run in the same order against
 * the same island objects. Only the literal arguments differ from the
 * call-by-call lowering (JavaScript values instead of native records behind
 * a representative), and no native code holds them.
 *
 * Closed expression statements. A module-level statement that is one call
 * or `new` on island values with closed operands,
 *
 *   registry.register("bash", bash);
 *
 * has its whole effect inside the island: no native code receives its
 * value, and none of its operands is native. It becomes a generated module
 * of its own with no export (the statement is the module's body), loaded
 * where the statement stands, and the statement lowers to nothing else.
 * Deferred, it evaluates when Node starts, in the order of the loads
 * registered, before the operation that needed Node: island objects are the
 * only things it can change, and native code reads those through Node or
 * through an interface snapshot the probe took after the statement
 * evaluated (a statement that changes what an earlier module's snapshot
 * answers keeps both where the program has them, probe-recorder.ts).
 *
 * A loop over a table is the same statement written once:
 *
 *   const languages = { bash, python };
 *   for (const [name, language] of Object.entries(languages)) {
 *     registry.register(name, language);
 *   }
 *
 * A module-level `for…of` whose bindings are `const`, whose iterable is
 * closed and whose body is closed calls is a closed statement. Its table is
 * a constant the island evaluates too when it is a literal of closed parts
 * and every mention of it in the program is in a statement the island
 * evaluates: then no native code can read it or change it, the generated
 * module of the table is its only definition, and the native statement
 * lowers to that module's load and nothing else. A table any native code
 * names stays a native constant, and the loop over it stays as it was. */
import { isAbsolute } from "node:path";
import * as ts from "../ts7/adapter.js";
import { isCjsJsFile, isJsSourceFile, locOf } from "../program.js";
import { DYN, STRING, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { GeneratedImport, GeneratedModule } from "../../node-islands/generated.js";
import { isForeignType } from "../../node-islands/boundary.js";
import type { Lowerer } from "./lowerer.js";
import {
  fromIsland,
  islandBindingOf,
  islandGet,
  islandHandleBinding,
  islandModuleGlobal,
  islandRooted,
} from "./lower-node-island.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";

/** A top-level statement the island can evaluate: a `const`, an expression
 * statement or a `for…of`. */
type ClosedSource = ts.VariableStatement | ts.ExpressionStatement | ts.ForOfStatement;

function isClosedSource(statement: ts.Statement): statement is ClosedSource {
  return (
    ts.isVariableStatement(statement) ||
    ts.isExpressionStatement(statement) ||
    ts.isForOfStatement(statement)
  );
}

/** A module-level constant whose initializer the island evaluates, or a
 * module-level statement it evaluates (`name` null: the generated module
 * exports nothing). */
export interface ClosedConstant {
  name: string | null;
  statement: ClosedSource;
  /** A constant only the island's statements name (privateTable): no
   * native binding reads its export. */
  table: boolean;
  /** The initializer without its type wrappers: the node whose lowering
   * reads the generated module's export. A statement's expression; a
   * loop's iterable. */
  initializer: ts.Expression;
  /** The initializer, or the statement, as JavaScript. */
  text: string;
  /** Island exports the text names, by local name. */
  imports: Map<string, GeneratedImport>;
  /** Other closed constants the text names, by local name. */
  operands: Map<string, ClosedConstant>;
  /** Its position among its file's closed constants, and the key of its
   * generated module (NodeIslandModuleCollector.addGenerated: the name its
   * loads carry until lowering ends), once its file numbered them. */
  index: number;
  key: string;
}

/** The closed constants and statements of one source file, in source
 * order. */
export interface ClosedFile {
  constants: ClosedConstant[];
  /** By initializer node (ClosedConstant.initializer). */
  initializers: Map<ts.Expression, ClosedConstant>;
}

/** Whether module-level constants of `file` can move: an ES module of the
 * program written in TypeScript. A JavaScript module may be lowered from
 * rewritten syntax, whose text is not the program's, and a CommonJS
 * module's bindings are not import bindings. */
function movable(lowerer: Lowerer, file: ts.SourceFile): boolean {
  if (file.isDeclarationFile || isJsSourceFile(file)) return false;
  if (file.fileName.endsWith(".cts") || isCjsJsFile(file, lowerer.program)) return false;
  return true;
}

/** The top-level `const` statement that declares `declaration`, or null. */
function constStatementOf(declaration: ts.Node): ts.VariableStatement | null {
  if (!ts.isVariableDeclaration(declaration)) return null;
  const list = declaration.parent;
  if (list === undefined || !ts.isVariableDeclarationList(list)) return null;
  // `const` only: not `let`, `var`, `using` or `await using`.
  if ((list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return null;
  const statement = list.parent;
  if (statement === undefined || !ts.isVariableStatement(statement)) return null;
  if (statement.parent === undefined || !ts.isSourceFile(statement.parent)) return null;
  if ((statement.flags & ts.NodeFlags.Ambient) !== 0) return null;
  return statement;
}

/** Whether a value of `type` is the same value on both sides of the
 * boundary: an island handle (an island-declared type), or an immutable
 * primitive. */
function sharedType(lowerer: Lowerer, type: ts.Type): boolean {
  if (isForeignType(lowerer.nodeIslands!, type, lowerer.checker)) return true;
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;
  const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
  return parts.every((part) => (part.flags & primitive) !== 0);
}

/** Whether the constant's native value is the island's own value: the
 * binding holds an island handle, or an immutable primitive, by the type
 * the initializer's value crosses at and by the binding's own. Then the
 * island evaluating the initializer makes the same value the call-by-call
 * lowering made, another closed initializer may name the constant, and
 * nothing is converted: a value the boundary would build a native object
 * from (a record of the program's own type) is native data, which the
 * island's literals are not. */
function sharedWithIsland(
  lowerer: Lowerer,
  declaration: ts.VariableDeclaration,
  initializer: ts.Expression,
): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  if (islandHandleBinding(lowerer, declaration.name)) return true;
  return (
    sharedType(lowerer, lowerer.typeOf(declaration.name)) &&
    sharedType(lowerer, lowerer.typeOf(initializer))
  );
}

/** The globals a closed expression may name: the same values in every
 * realm. */
const CLOSED_GLOBALS: ReadonlySet<string> = new Set(["undefined", "NaN", "Infinity"]);

interface Scan {
  lowerer: Lowerer;
  statement: ts.Statement;
  imports: Map<string, GeneratedImport>;
  operands: Map<string, ClosedConstant>;
  /** The bindings the statement declares itself (a loop's): names of the
   * generated module's own. */
  locals: Set<ts.Symbol>;
  /** Calls and constructions seen. */
  calls: number;
  /** Why the expression is not closed: the first reason the scan met. */
  refusal: string | null;
}

function newScan(lowerer: Lowerer, statement: ts.Statement): Scan {
  return {
    lowerer,
    statement,
    imports: new Map(),
    operands: new Map(),
    locals: new Set(),
    calls: 0,
    refusal: null,
  };
}

/** The decisions in progress for one lowerer (Lowerer.closedIslandDeciding). */
export interface ClosedDeciding {
  /** The statements being decided: one that names itself through a cycle
   * of constants is not closed. */
  active: Set<ts.Statement>;
  /** The tables taken as the island's own while the statements that name
   * them are decided (privateTable), or null. */
  assumed: Map<ts.Statement, ClosedConstant> | null;
}

function deciding(lowerer: Lowerer): ClosedDeciding {
  return lowerer.closedIslandDeciding;
}

/** Records that `node` keeps the expression from being closed. */
function refuse(scan: Scan, node: ts.Node, what: string): null {
  if (scan.refusal === null) {
    const text = ts.getTextOfNode(node).split("\n")[0]!;
    scan.refusal = `${what} (\`${text.length > 48 ? `${text.slice(0, 48)}…` : text}\`)`;
  }
  return null;
}

/** The trace lines already written (traceClosed). */
const traced = new Set<string>();

/** SCRIPTC_NODE_ISLANDS_TRACE=closed at build time: one line per
 * module-level constant whose initializer is an island operation, and per
 * module-level statement that is one, saying whether the island evaluates
 * it and, if not, what keeps it native. */
function traceClosed(
  lowerer: Lowerer,
  declaration: ts.VariableDeclaration | ts.ExpressionStatement | ts.ForOfStatement,
  why: string | null,
): void {
  const trace = process.env["SCRIPTC_NODE_ISLANDS_TRACE"];
  if (trace === undefined || !trace.includes("closed")) return;
  // A decision taken while a table is only assumed the island's own is
  // taken again once the table is decided: that one is the answer.
  if (deciding(lowerer).assumed !== null) return;
  const file = ts.getSourceFileOfNode(declaration);
  const start = ts.tokenStartOfNode(declaration);
  const line = ts.getLineAndCharacterOfPosition(file, start).line + 1;
  const name = !ts.isVariableDeclaration(declaration)
    ? "(statement)"
    : ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : "(pattern)";
  const text = `[node-islands] ${why === null ? "closed" : "not closed"} ${file.fileName}:${line} ${name}${why === null ? "" : `: ${why}`}\n`;
  // Every lowering pass decides again; the trace says it once.
  if (traced.has(text)) return;
  traced.add(text);
  process.stderr.write(text);
}

/** The closed constant `symbol` binds, as an operand of `scan`'s
 * statement, or null. */
function operandOf(scan: Scan, node: ts.Node, bound: ts.Symbol | undefined): ClosedConstant | null {
  const lowerer = scan.lowerer;
  const native = "a native binding";
  let symbol = bound;
  if (symbol === undefined) return refuse(scan, node, native);
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations[0];
  if (declaration === undefined || !ts.isVariableDeclaration(declaration))
    return refuse(scan, node, native);
  const statement = constStatementOf(declaration);
  if (statement === null) return refuse(scan, node, native);
  const constant = closedStatement(lowerer, statement);
  if (constant === null) return refuse(scan, node, "a constant the island does not evaluate");
  // The operand is initialized whenever this statement runs: an earlier
  // statement of the same module, or a binding of another module that no
  // access can reach before its declaration (it carries no initialization
  // flag, cycle-initialization.ts). Node throws a ReferenceError at a read
  // that comes too early; the island would evaluate the operand's module
  // instead.
  const early = "a constant that may not be initialized yet";
  if (statement.parent === scan.statement.parent) {
    if (statement.end > scan.statement.pos) return refuse(scan, node, early);
  } else {
    const global = lowerer.globalsBySymbol.get(symbol);
    if (global === undefined || global.initFlag !== undefined) return refuse(scan, node, early);
    if (lowerer.cycleInitFlags.has(global.id)) return refuse(scan, node, early);
  }
  return constant;
}

/** The JavaScript of the identifier `node` in a closed expression, or
 * null when it names anything but a closed global, an island module's
 * export or a closed constant. */
function closedName(scan: Scan, node: ts.Identifier): string | null {
  const lowerer = scan.lowerer;
  const name = node.text;
  if (CLOSED_GLOBALS.has(name)) {
    const declarations = lowerer.checker.getSymbolAtLocation(node)?.declarations ?? [];
    const standard =
      declarations.length > 0 &&
      declarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile);
    return standard ? name : refuse(scan, node, "a binding that shadows a global");
  }
  if (scan.locals.size > 0) {
    const symbol = lowerer.checker.getSymbolAtLocation(node);
    if (symbol !== undefined && scan.locals.has(symbol)) return name;
  }
  const binding = islandBindingOf(lowerer, node);
  if (binding !== null) return islandImport(scan, node, binding);
  const operand = operandOf(scan, node, lowerer.checker.getSymbolAtLocation(node));
  if (operand === null) return null;
  scan.operands.set(name, operand);
  return name;
}

/** The name `node` gives an island module's export in a closed expression:
 * the generated module imports it under that name. Null for a binding an
 * import declaration cannot name. */
function islandImport(
  scan: Scan,
  node: ts.Identifier,
  binding: NonNullable<ReturnType<typeof islandBindingOf>>,
): string | null {
  const name = node.text;
  const path = binding.module.path;
  if (!isAbsolute(path)) return refuse(scan, node, "a builtin module's binding");
  let clause: string;
  if (binding.kind === "named")
    clause = binding.name === name ? `{ ${name} }` : `{ ${binding.name} as ${name} }`;
  else if (binding.kind === "default") clause = name;
  else if (binding.kind === "namespace" && binding.module.esm) clause = `* as ${name}`;
  else return refuse(scan, node, "a CommonJS namespace or require binding");
  scan.imports.set(name, { clause, target: path });
  return name;
}

/** The name node of the import of `file` that binds `name`, or null. */
function importNameOf(file: ts.SourceFile, name: string): ts.Identifier | null {
  for (const statement of file.statements.nodes) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined && clause.name.text === name) return clause.name;
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (bindings.name.text === name) return bindings.name;
      continue;
    }
    for (const element of bindings.elements.nodes)
      if (!element.isTypeOnly && element.name.text === name) return element.name;
  }
  return null;
}

/** The members of `Object` a closed expression may call: each answers from
 * its argument alone, and in the island it is the function Node's own
 * program would call. */
const CLOSED_OBJECT_STATICS: ReadonlySet<string> = new Set(["entries", "keys", "values"]);

/** The JavaScript of `Object.entries(x)`, `Object.keys(x)` or
 * `Object.values(x)` over a closed `x`; undefined when `node` is not such
 * a call (null: it is one, and `x` is not closed). */
function closedObjectStatic(scan: Scan, node: ts.CallExpression): string | null | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined)
    return undefined;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "Object") return undefined;
  if (!ts.isIdentifier(callee.name) || !CLOSED_OBJECT_STATICS.has(callee.name.text))
    return undefined;
  const declarations =
    scan.lowerer.checker.getSymbolAtLocation(callee.expression)?.declarations ?? [];
  const standard =
    declarations.length > 0 &&
    declarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile);
  if (!standard) return undefined;
  const args = node.arguments.nodes;
  if (args.length !== 1 || ts.isSpreadElement(args[0]!)) return undefined;
  const value = closedText(scan, args[0]!);
  return value === null ? null : `Object.${callee.name.text}(${value})`;
}

/** The JavaScript of a call's or an array literal's elements, or null. */
function closedElements(scan: Scan, elements: readonly ts.Expression[]): string[] | null {
  const out: string[] = [];
  for (const element of elements) {
    if (ts.isOmittedExpression(element)) {
      out.push("");
      continue;
    }
    const spread = ts.isSpreadElement(element);
    const text = closedText(scan, spread ? element.expression : element);
    if (text === null) return null;
    out.push(spread ? `...${text}` : text);
  }
  return out;
}

/** The JavaScript of a closed expression, or null when `node` is not one.
 * Type syntax (`as`, `satisfies`, `<T>e`, `!`, type arguments) is dropped;
 * parentheses stay, so dropping a wrapper never changes how the rest
 * parses. */
function closedText(scan: Scan, node: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(node)) {
    const inner = closedText(scan, node.expression);
    return inner === null ? null : `(${inner})`;
  }
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isNonNullExpression(node)
  )
    return closedText(scan, node.expression);
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isRegularExpressionLiteral(node)
  )
    return ts.getTextOfNode(node);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isPrefixUnaryExpression(node)) {
    const sign =
      node.operator === ts.SyntaxKind.MinusToken
        ? "-"
        : node.operator === ts.SyntaxKind.PlusToken
          ? "+"
          : null;
    if (sign === null) return refuse(scan, node, "an operator");
    if (!ts.isNumericLiteral(node.operand) && !ts.isBigIntLiteral(node.operand))
      return refuse(scan, node, "an operator");
    return `${sign}${ts.getTextOfNode(node.operand)}`;
  }
  if (ts.isIdentifier(node)) return closedName(scan, node);
  if (ts.isPropertyAccessExpression(node)) {
    if (node.questionDotToken !== undefined || !ts.isIdentifier(node.name))
      return refuse(scan, node, "an optional chain or private name");
    const object = closedText(scan, node.expression);
    if (object === null) return null;
    // `1 .toFixed` needs its space or parentheses.
    return ts.isNumericLiteral(node.expression)
      ? `(${object}).${node.name.text}`
      : `${object}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node)) {
    if (node.questionDotToken !== undefined) return refuse(scan, node, "an optional chain");
    const object = closedText(scan, node.expression);
    const key = closedText(scan, node.argumentExpression);
    return object === null || key === null ? null : `${object}[${key}]`;
  }
  if (ts.isCallExpression(node)) {
    if (node.questionDotToken !== undefined) return refuse(scan, node, "an optional chain");
    const listed = closedObjectStatic(scan, node);
    if (listed !== undefined) return listed;
    const callee = closedText(scan, node.expression);
    const args = closedElements(scan, node.arguments.nodes);
    if (callee === null || args === null) return null;
    scan.calls++;
    return `${callee}(${args.join(", ")})`;
  }
  if (ts.isNewExpression(node)) {
    const callee = closedText(scan, node.expression);
    const args = closedElements(scan, node.arguments?.nodes ?? []);
    if (callee === null || args === null) return null;
    scan.calls++;
    return `new ${callee}(${args.join(", ")})`;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const elements = closedElements(scan, node.elements.nodes);
    if (elements === null) return null;
    // A hole at the end keeps its comma: `[a, ,]` has two elements.
    const last = node.elements.nodes.at(-1);
    const hole = last !== undefined && ts.isOmittedExpression(last) ? "," : "";
    return `[${elements.join(", ")}${hole}]`;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const members: string[] = [];
    for (const member of node.properties.nodes) {
      if (ts.isSpreadAssignment(member)) {
        const value = closedText(scan, member.expression);
        if (value === null) return null;
        members.push(`...${value}`);
        continue;
      }
      // `{ item }`: the member's value is the binding of that name, which
      // the generated module imports under the same name: an island
      // module's export, or a closed constant.
      if (ts.isShorthandPropertyAssignment(member)) {
        if (member.objectAssignmentInitializer !== undefined || !ts.isIdentifier(member.name))
          return refuse(scan, member, "an object member");
        // The checker answers the member for the name itself, so the
        // import the name reads is looked up where the file declares it: a
        // closed expression sits at the top level, where nothing shadows an
        // import.
        const imported = importNameOf(ts.getSourceFileOfNode(member), member.name.text);
        const binding = imported === null ? null : islandBindingOf(scan.lowerer, imported);
        if (binding !== null) {
          if (islandImport(scan, member.name, binding) === null) return null;
          members.push(member.name.text);
          continue;
        }
        const value = scan.lowerer.checker.getShorthandAssignmentValueSymbol(member);
        const operand = operandOf(scan, member, value);
        if (operand === null) return null;
        scan.operands.set(member.name.text, operand);
        members.push(member.name.text);
        continue;
      }
      // Methods and accessors are not closed: a function body is program
      // code.
      if (!ts.isPropertyAssignment(member))
        return refuse(scan, member, "a method or accessor of an object literal");
      let key: string | null;
      if (ts.isIdentifier(member.name)) key = member.name.text;
      else if (ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name))
        key = ts.getTextOfNode(member.name);
      else if (ts.isComputedPropertyName(member.name)) {
        const computed = closedText(scan, member.name.expression);
        key = computed === null ? null : `[${computed}]`;
      } else key = refuse(scan, member.name, "an object member's name");
      const value = closedText(scan, member.initializer);
      if (key === null || value === null) return null;
      members.push(`${key}: ${value}`);
    }
    return members.length === 0 ? "{}" : `{ ${members.join(", ")} }`;
  }
  return refuse(scan, node, "an expression the island cannot take as written");
}

/** Whether a module of the program patches a builtin module, which keeps
 * `source` where it is written (traced). A closed constant or statement is
 * a module the build writes, which Node loads when the program reaches it.
 * A module of the program that patches a builtin module
 * (`fs.readFileSync`, say) has run by then, and Node's loader reads the
 * generated file through the patch: the program would evaluate what the
 * patch returns, where Node evaluated an expression in place. Such a
 * program keeps its initializers, statements and loops where they are
 * written; a table is the island's only through a statement that is
 * (privateTable), so it stays native with them. */
function readThroughPatch(
  lowerer: Lowerer,
  source: ts.VariableDeclaration | ts.ExpressionStatement | ts.ForOfStatement,
): boolean {
  for (const module of lowerer.nodeIslands!.modules.values())
    if (module.patchesBuiltin === true) {
      traceClosed(
        lowerer,
        source,
        `${module.file} patches a builtin module, and Node would read the generated module through the patch`,
      );
      return true;
    }
  return false;
}

/** The closed constant `declaration` of `statement` declares, or null. */
function closedDeclaration(
  lowerer: Lowerer,
  statement: ts.VariableStatement,
  declaration: ts.VariableDeclaration,
): ClosedConstant | null {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return null;
  const initializer = withoutParenthesesTypeWrappers(declaration.initializer);
  if (ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer))
    return privateTable(lowerer, statement, declaration, initializer);
  // The initializer is an island operation today (islandRooted), so its
  // value meets its static type through fromIsland either way.
  if (
    !ts.isCallExpression(initializer) &&
    !ts.isNewExpression(initializer) &&
    !ts.isPropertyAccessExpression(initializer) &&
    !ts.isElementAccessExpression(initializer)
  )
    return null;
  if (!islandRooted(lowerer, initializer)) return null;
  if (readThroughPatch(lowerer, declaration)) return null;
  if (!sharedWithIsland(lowerer, declaration, initializer)) {
    const type = lowerer.checker.typeToString(lowerer.typeOf(declaration.name));
    traceClosed(lowerer, declaration, `its value becomes native data of type '${type}'`);
    return null;
  }
  const scan = newScan(lowerer, statement);
  const text = closedText(scan, initializer);
  if (text === null) {
    traceClosed(lowerer, declaration, `its initializer holds ${scan.refusal ?? "a native value"}`);
    return null;
  }
  // Without a call there is nothing to move: member reads of an import are
  // answered by the island module's own snapshot.
  if (scan.calls === 0) return null;
  if (statement.declarationList.declarations.nodes.length > 1) {
    traceClosed(lowerer, declaration, "a statement that declares more than one constant");
    return null;
  }
  traceClosed(lowerer, declaration, null);
  return {
    name: declaration.name.text,
    statement,
    table: false,
    initializer,
    text,
    imports: scan.imports,
    operands: scan.operands,
    index: -1,
    key: "",
  };
}

/** The closed statement a top-level expression statement is, or null: one
 * call or `new` on island values whose callee and arguments are closed.
 * Its value goes nowhere, so nothing is asked of its type; a call that
 * awaits, negates or otherwise computes with the value natively is an
 * operator and stays where it is. */
function closedExpressionStatement(
  lowerer: Lowerer,
  statement: ts.ExpressionStatement,
): ClosedConstant | null {
  const expression = withoutParenthesesTypeWrappers(statement.expression);
  if (!ts.isCallExpression(expression) && !ts.isNewExpression(expression)) return null;
  if (!islandRooted(lowerer, expression)) return null;
  if (readThroughPatch(lowerer, statement)) return null;
  const scan = newScan(lowerer, statement);
  const text = closedText(scan, expression);
  if (text === null) {
    traceClosed(lowerer, statement, `it holds ${scan.refusal ?? "a native value"}`);
    return null;
  }
  traceClosed(lowerer, statement, null);
  return {
    name: null,
    statement,
    table: false,
    initializer: expression,
    text,
    imports: scan.imports,
    operands: scan.operands,
    index: -1,
    key: "",
  };
}

/** Whether `statement` declares one `const` whose initializer is an object
 * or array literal: a table (privateTable), decided when a statement the
 * island evaluates names it. */
function tableShaped(statement: ts.Statement): statement is ts.VariableStatement {
  if (!ts.isVariableStatement(statement)) return false;
  const declarations = statement.declarationList.declarations.nodes;
  const initializer = declarations.length === 1 ? declarations[0]!.initializer : undefined;
  if (initializer === undefined) return false;
  const value = withoutParenthesesTypeWrappers(initializer);
  return ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value);
}

/** The identifiers of `file` spelled `name`: where the name could be meant
 * (Lowerer.closedIslandMentions keeps each file's identifiers by text). */
function mentionsOf(lowerer: Lowerer, file: ts.SourceFile, name: string): ts.Identifier[] {
  const mentions = lowerer.closedIslandMentions;
  let byName = mentions.get(file);
  if (byName === undefined) {
    const found = new Map<string, ts.Identifier[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const list = found.get(node.text);
        if (list === undefined) found.set(node.text, [node]);
        else list.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    mentions.set(file, (byName = found));
  }
  return byName.get(name) ?? [];
}

/** The top-level statement of its file that holds `node`, or null. */
function topLevelStatementOf(node: ts.Node): ts.Statement | null {
  let current: ts.Node = node;
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) current = current.parent;
  return current.parent === undefined ? null : (current as ts.Statement);
}

/** A table only the island's statements name: a top-level `const`, not
 * exported, whose initializer is an object or array literal of closed
 * parts, and whose name appears nowhere in its file but in statements the
 * island evaluates. No native code can then read the table or change it,
 * so the island's object is the only one there has to be: the constant is
 * a generated module's export like any other closed constant, and the
 * native statement lowers to that module's load alone.
 *
 * The statements that name the table are closed only if the table is the
 * island's, and the table is only if they are: each of them is decided
 * with the table taken as the island's (and with the tables already taken
 * so while this one is decided), and none of those decisions is kept. The
 * answer holds when every one of them is closed that way: then nothing
 * outside those statements names any of the tables.
 *
 * Every identifier of the file that is spelled like the table counts as a
 * mention, whatever it binds (a property of that name, a type query, an
 * export clause): a mention outside a closed statement keeps the table
 * native. */
function privateTable(
  lowerer: Lowerer,
  statement: ts.VariableStatement,
  declaration: ts.VariableDeclaration,
  initializer: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): ClosedConstant | null {
  if (!ts.isIdentifier(declaration.name)) return null;
  if (statement.declarationList.declarations.nodes.length !== 1) return null;
  const exported = (statement.modifiers?.nodes ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
  if (exported) return null;
  const file = statement.parent;
  if (file === undefined || !ts.isSourceFile(file)) return null;
  const scan = newScan(lowerer, statement);
  const text = closedText(scan, initializer);
  if (text === null) return null;
  const name = declaration.name.text;
  const table: ClosedConstant = {
    name,
    statement,
    table: true,
    initializer,
    text,
    imports: scan.imports,
    operands: scan.operands,
    index: -1,
    key: "",
  };
  const symbol = lowerer.checker.getSymbolAtLocation(declaration.name);
  const state = deciding(lowerer);
  const outer = { active: state.active, assumed: state.assumed };
  state.active = new Set();
  state.assumed = new Map(outer.assumed ?? []);
  state.assumed.set(statement, table);
  let users = 0;
  let outside: ts.Identifier | null = null;
  const closed = new Map<ts.Statement, boolean>();
  const evaluated = (user: ts.Statement | null): boolean => {
    if (user === null || user === statement || !isClosedSource(user)) return false;
    let answer = closed.get(user);
    if (answer === undefined) closed.set(user, (answer = closedStatement(lowerer, user) !== null));
    return answer;
  };
  try {
    for (const mention of mentionsOf(lowerer, file, name)) {
      if (mention === declaration.name) continue;
      if (!evaluated(topLevelStatementOf(mention))) {
        outside = mention;
        break;
      }
      const shorthand =
        mention.parent !== undefined &&
        ts.isShorthandPropertyAssignment(mention.parent) &&
        mention.parent.name === mention
          ? lowerer.checker.getShorthandAssignmentValueSymbol(mention.parent)
          : undefined;
      if ((shorthand ?? lowerer.checker.getSymbolAtLocation(mention)) === symbol) users++;
    }
  } finally {
    state.active = outer.active;
    state.assumed = outer.assumed;
  }
  if (outside !== null) {
    const line = ts.getLineAndCharacterOfPosition(file, ts.tokenStartOfNode(outside)).line + 1;
    traceClosed(
      lowerer,
      declaration,
      `line ${line} names it outside the statements the island evaluates`,
    );
    return null;
  }
  // A table nothing names is left alone.
  if (users === 0) return null;
  traceClosed(lowerer, declaration, null);
  return table;
}

/** The JavaScript of a loop's binding, or null: a name, or an array
 * pattern of names (`[key, value]`), each a name of the generated module's
 * own from here on. */
function closedBinding(scan: Scan, name: ts.BindingName): string | null {
  const checker = scan.lowerer.checker;
  const local = (node: ts.Identifier): string => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined) scan.locals.add(symbol);
    return node.text;
  };
  if (ts.isIdentifier(name)) return local(name);
  if (!ts.isArrayBindingPattern(name)) return refuse(scan, name, "a binding pattern");
  const parts: string[] = [];
  for (const element of name.elements.nodes) {
    if (ts.isOmittedExpression(element)) {
      parts.push("");
      continue;
    }
    if (
      element.dotDotDotToken !== undefined ||
      element.initializer !== undefined ||
      element.propertyName !== undefined ||
      !ts.isIdentifier(element.name)
    )
      return refuse(scan, element, "a binding pattern");
    parts.push(local(element.name));
  }
  return `[${parts.join(", ")}]`;
}

/** The closed statement a top-level `for…of` is, or null: `const`
 * bindings, a closed iterable, and a body of calls and constructions with
 * closed operands, at least one of them on an island value. The island
 * runs the loop: its bindings are the island's values and nothing native
 * sees an iteration. */
function closedLoop(lowerer: Lowerer, statement: ts.ForOfStatement): ClosedConstant | null {
  if (statement.awaitModifier !== undefined) return null;
  const list = statement.initializer;
  if (!ts.isVariableDeclarationList(list)) return null;
  if ((list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return null;
  const binding = list.declarations.nodes.length === 1 ? list.declarations.nodes[0]! : undefined;
  if (binding === undefined) return null;
  const body = ts.isBlock(statement.statement)
    ? statement.statement.statements.nodes
    : [statement.statement];
  const calls: ts.Expression[] = [];
  for (const part of body) {
    if (!ts.isExpressionStatement(part)) return null;
    const expression = withoutParenthesesTypeWrappers(part.expression);
    if (!ts.isCallExpression(expression) && !ts.isNewExpression(expression)) return null;
    calls.push(expression);
  }
  // An island operation today: some call of the body is one.
  if (!calls.some((call) => islandRooted(lowerer, call))) return null;
  if (readThroughPatch(lowerer, statement)) return null;
  const scan = newScan(lowerer, statement);
  // The iterable evaluates before the bindings exist.
  const iterable = closedText(scan, statement.expression);
  const pattern = iterable === null ? null : closedBinding(scan, binding.name);
  const texts: string[] = [];
  if (pattern !== null)
    for (const call of calls) {
      const text = closedText(scan, call);
      if (text === null) break;
      texts.push(`${text};`);
    }
  if (iterable === null || pattern === null || texts.length !== calls.length) {
    traceClosed(lowerer, statement, `it holds ${scan.refusal ?? "a native value"}`);
    return null;
  }
  traceClosed(lowerer, statement, null);
  return {
    name: null,
    statement,
    table: false,
    initializer: statement.expression,
    text: `for (const ${pattern} of ${iterable}) { ${texts.join(" ")} }`,
    imports: scan.imports,
    operands: scan.operands,
    index: -1,
    key: "",
  };
}

/** What the island evaluates of the top-level statement `statement`, or
 * null. */
function decideStatement(lowerer: Lowerer, statement: ClosedSource): ClosedConstant | null {
  const file = statement.parent;
  if (file === undefined || !ts.isSourceFile(file) || !movable(lowerer, file)) return null;
  if (ts.isExpressionStatement(statement)) return closedExpressionStatement(lowerer, statement);
  if (ts.isForOfStatement(statement)) return closedLoop(lowerer, statement);
  const declarations = statement.declarationList.declarations.nodes;
  const declaration = declarations[0];
  if (declaration === undefined || constStatementOf(declaration) !== statement) return null;
  let constant: ClosedConstant | null = null;
  // Each declarator is looked at, so that the trace names what keeps it
  // native; only a statement's single declarator can be closed.
  for (const d of declarations) constant = closedDeclaration(lowerer, statement, d);
  return constant;
}

/** The closed constant a top-level `const` statement declares, or the
 * closed statement a top-level expression statement or `for…of` is, or
 * null. One declarator only: the initializers of two would evaluate before
 * either binding is assigned. */
function closedStatement(lowerer: Lowerer, statement: ClosedSource): ClosedConstant | null {
  const state = deciding(lowerer);
  const assumed = state.assumed?.get(statement);
  if (assumed !== undefined) return assumed;
  const known = lowerer.closedIslandStatements.get(statement);
  if (known !== undefined) return known;
  // A statement being decided names itself through a cycle of constants:
  // not closed.
  if (state.active.has(statement)) return null;
  state.active.add(statement);
  let closed: ClosedConstant | null;
  try {
    closed = decideStatement(lowerer, statement);
  } finally {
    state.active.delete(statement);
  }
  // A decision taken while a table is only assumed the island's own is
  // not kept: it is taken again once that table is decided.
  if (state.assumed === null) lowerer.closedIslandStatements.set(statement, closed);
  return closed;
}

/** The closed constants and statements of `file`, numbered in source
 * order. */
export function closedFile(lowerer: Lowerer, file: ts.SourceFile): ClosedFile {
  const known = lowerer.closedIslandFiles.get(file);
  if (known !== undefined) return known;
  const result: ClosedFile = { constants: [], initializers: new Map() };
  lowerer.closedIslandFiles.set(file, result);
  if (lowerer.nodeIslands === null || !movable(lowerer, file)) return result;
  const sources = file.statements.nodes.filter(isClosedSource);
  // A table is decided when a statement that names it is, so the statements
  // come first; then everything is numbered where it stands.
  for (const statement of sources) if (!tableShaped(statement)) closedStatement(lowerer, statement);
  for (const statement of sources) {
    const constant = tableShaped(statement)
      ? (lowerer.closedIslandStatements.get(statement) ?? null)
      : closedStatement(lowerer, statement);
    if (constant === null) continue;
    constant.index = result.constants.length;
    constant.key = `${file.fileName}.closed.${constant.index}.mjs`;
    result.constants.push(constant);
    // Only a constant with a native binding has an initializer to lower.
    if (constant.name !== null && !constant.table)
      result.initializers.set(constant.initializer, constant);
  }
  return result;
}

/** The generated module of `constant` (node-islands/generated.ts). */
function generatedModule(lowerer: Lowerer, constant: ClosedConstant): GeneratedModule {
  const imports = new Map<string, GeneratedImport>(constant.imports);
  for (const [name, operand] of constant.operands) {
    // The operand's file numbers its constants on demand.
    if (operand.key === "") closedFile(lowerer, ts.getSourceFileOfNode(operand.statement));
    // An operand is a constant: a statement has no name to be named by.
    const exported = operand.name!;
    const clause = exported === name ? `{ ${name} }` : `{ ${exported} as ${name} }`;
    imports.set(name, { clause, target: operand.key });
  }
  return {
    source: ts.getSourceFileOfNode(constant.statement).fileName,
    index: constant.index,
    imports: [...imports.values()],
    body:
      constant.name === null
        ? `${constant.text};\n`
        : `export const ${constant.name} = ${constant.text};\n`,
  };
}

/** What the island evaluates of the top-level statement `stmt` of `file`,
 * once the file's statements are decided (closedFile). */
function closedAt(
  lowerer: Lowerer,
  file: ts.SourceFile,
  stmt: ts.Statement,
): ClosedConstant | null {
  if (lowerer.nodeIslands === null || !isClosedSource(stmt)) return null;
  closedFile(lowerer, file);
  return lowerer.closedIslandStatements.get(stmt) ?? null;
}

/** Whether the island evaluates the whole top-level statement `stmt` of
 * `file`: a closed expression statement or loop, or a table only such
 * statements name. The load closedIslandInitLoad answers is then all there
 * is, and lowerFileInit lowers nothing else for it. */
export function isClosedIslandStatement(
  lowerer: Lowerer,
  file: ts.SourceFile,
  stmt: ts.Statement,
): boolean {
  const closed = closedAt(lowerer, file, stmt);
  return closed !== null && (closed.name === null || closed.table);
}

/** The %init statements that run before the top-level statement `stmt` of
 * `file` (lowerFileInit): when it declares a closed constant, or is a
 * closed statement, the load of its generated module, deferred like a
 * static island import's (snapshot.ts decides after lowering). */
export function closedIslandInitLoad(
  lowerer: Lowerer,
  file: ts.SourceFile,
  stmt: ts.Statement,
): IrStmt[] {
  const constant = closedAt(lowerer, file, stmt);
  if (constant === null) return [];
  lowerer.usesNodeIsland = true;
  const loc = locOf(stmt);
  const module = islandModuleGlobal(lowerer, constant.key);
  lowerer.nodeIslandModules.addGenerated(constant.key, generatedModule(lowerer, constant));
  const path: IrExpr & { kind: "strLit" } = {
    kind: "strLit",
    value: constant.key,
    type: STRING,
    loc,
  };
  lowerer.nodeIslandLoads.push({ literal: path, path: constant.key });
  return [
    {
      kind: "assign",
      localId: module.global.id,
      value: {
        kind: "libCall",
        fn: "nodeIsland.defer",
        args: [path, { kind: "strLit", value: "", type: STRING, loc }],
        type: DYN,
        loc,
      },
      loc,
    },
  ];
}

/** The closed constant whose initializer is `expr`, or null. */
function closedConstantAt(lowerer: Lowerer, expr: ts.Expression): ClosedConstant | null {
  if (
    !ts.isCallExpression(expr) &&
    !ts.isNewExpression(expr) &&
    !ts.isPropertyAccessExpression(expr) &&
    !ts.isElementAccessExpression(expr)
  )
    return null;
  let node: ts.Node = expr;
  while (
    node.parent !== undefined &&
    (ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isSatisfiesExpression(node.parent) ||
      ts.isTypeAssertion(node.parent) ||
      ts.isNonNullExpression(node.parent))
  )
    node = node.parent;
  const declaration = node.parent;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return null;
  if (declaration.initializer !== node) return null;
  const statement = constStatementOf(declaration);
  if (statement === null) return null;
  const file = ts.getSourceFileOfNode(statement);
  return closedFile(lowerer, file).initializers.get(expr) ?? null;
}

/** The lowerIslandExpr hook: the initializer of a closed constant reads
 * its export of its generated module (closedIslandInitLoad loaded
 * it), met with the conversion the original expression's value met. Null
 * for any other expression. */
export function lowerClosedIslandInit(lowerer: Lowerer, expr: ts.Expression): IrExpr | null {
  const constant = closedConstantAt(lowerer, expr);
  if (constant === null || constant.name === null || constant.table) return null;
  const loc = locOf(expr);
  lowerer.usesNodeIsland = true;
  const module = islandModuleGlobal(lowerer, constant.key);
  return fromIsland(
    lowerer,
    islandGet(varRef(module.global.id, DYN, loc), constant.name, loc),
    expr,
  );
}
