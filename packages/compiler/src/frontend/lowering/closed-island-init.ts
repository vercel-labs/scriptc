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
 * a representative), and no native code holds them. */
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
import { stripTypeWrappers } from "./typed-arguments.js";

/** A module-level constant whose initializer the island evaluates. */
export interface ClosedConstant {
  name: string;
  declaration: ts.VariableDeclaration;
  statement: ts.VariableStatement;
  /** The initializer without its type wrappers: the node whose lowering
   * reads the generated module's export. */
  initializer: ts.Expression;
  /** The initializer as JavaScript. */
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

/** The closed constants of one source file, in source order. */
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
  statement: ts.VariableStatement;
  imports: Map<string, GeneratedImport>;
  operands: Map<string, ClosedConstant>;
  /** Calls and constructions seen. */
  calls: number;
  /** Why the expression is not closed: the first reason the scan met. */
  refusal: string | null;
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
 * module-level constant whose initializer is an island operation, saying
 * whether the island evaluates it and, if not, what keeps it native. */
function traceClosed(declaration: ts.VariableDeclaration, why: string | null): void {
  const trace = process.env["SCRIPTC_NODE_ISLANDS_TRACE"];
  if (trace === undefined || !trace.includes("closed")) return;
  const file = ts.getSourceFileOfNode(declaration);
  const start = ts.tokenStartOfNode(declaration);
  const line = ts.getLineAndCharacterOfPosition(file, start).line + 1;
  const name = ts.isIdentifier(declaration.name) ? declaration.name.text : "(pattern)";
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
  const binding = islandBindingOf(lowerer, node);
  if (binding !== null) {
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
  const operand = operandOf(scan, node, lowerer.checker.getSymbolAtLocation(node));
  if (operand === null) return null;
  scan.operands.set(name, operand);
  return name;
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
      // the generated module imports under the same name. Only a closed
      // constant: an island import's shorthand is not looked through.
      if (ts.isShorthandPropertyAssignment(member)) {
        if (member.objectAssignmentInitializer !== undefined || !ts.isIdentifier(member.name))
          return refuse(scan, member, "an object member");
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

/** The closed constant `declaration` of `statement` declares, or null. */
function closedDeclaration(
  lowerer: Lowerer,
  statement: ts.VariableStatement,
  declaration: ts.VariableDeclaration,
): ClosedConstant | null {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return null;
  const initializer = stripTypeWrappers(declaration.initializer);
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
  if (!sharedWithIsland(lowerer, declaration, initializer)) {
    const type = lowerer.checker.typeToString(lowerer.typeOf(declaration.name));
    traceClosed(declaration, `its value becomes native data of type '${type}'`);
    return null;
  }
  const scan: Scan = {
    lowerer,
    statement,
    imports: new Map(),
    operands: new Map(),
    calls: 0,
    refusal: null,
  };
  const text = closedText(scan, initializer);
  if (text === null) {
    traceClosed(declaration, `its initializer holds ${scan.refusal ?? "a native value"}`);
    return null;
  }
  // Without a call there is nothing to move: member reads of an import are
  // answered by the island module's own snapshot.
  if (scan.calls === 0) return null;
  if (statement.declarationList.declarations.nodes.length > 1) {
    traceClosed(declaration, "a statement that declares more than one constant");
    return null;
  }
  traceClosed(declaration, null);
  return {
    name: declaration.name.text,
    declaration,
    statement,
    initializer,
    text,
    imports: scan.imports,
    operands: scan.operands,
    index: -1,
    key: "",
  };
}

/** The closed constant a top-level `const` statement declares, or null.
 * One declarator only: the initializers of two would evaluate before
 * either binding is assigned. */
function closedStatement(lowerer: Lowerer, statement: ts.VariableStatement): ClosedConstant | null {
  const known = lowerer.closedIslandStatements.get(statement);
  if (known !== undefined) return known;
  // A statement being decided names itself through a cycle of constants:
  // not closed.
  lowerer.closedIslandStatements.set(statement, null);
  const file = statement.parent;
  if (file === undefined || !ts.isSourceFile(file) || !movable(lowerer, file)) return null;
  const declarations = statement.declarationList.declarations.nodes;
  const declaration = declarations[0];
  if (declaration === undefined || constStatementOf(declaration) !== statement) return null;
  let constant: ClosedConstant | null = null;
  // Each declarator is looked at, so that the trace names what keeps it
  // native; only a statement's single declarator can be closed.
  for (const d of declarations) constant = closedDeclaration(lowerer, statement, d);
  lowerer.closedIslandStatements.set(statement, constant);
  return constant;
}

/** The closed constants of `file`, numbered in source order. */
export function closedFile(lowerer: Lowerer, file: ts.SourceFile): ClosedFile {
  const known = lowerer.closedIslandFiles.get(file);
  if (known !== undefined) return known;
  const result: ClosedFile = { constants: [], initializers: new Map() };
  lowerer.closedIslandFiles.set(file, result);
  if (lowerer.nodeIslands === null || !movable(lowerer, file)) return result;
  for (const statement of file.statements.nodes) {
    if (!ts.isVariableStatement(statement)) continue;
    const constant = closedStatement(lowerer, statement);
    if (constant === null) continue;
    constant.index = result.constants.length;
    constant.key = `${file.fileName}.closed.${constant.index}.mjs`;
    result.constants.push(constant);
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
    const clause = operand.name === name ? `{ ${name} }` : `{ ${operand.name} as ${name} }`;
    imports.set(name, { clause, target: operand.key });
  }
  return {
    source: ts.getSourceFileOfNode(constant.statement).fileName,
    index: constant.index,
    imports: [...imports.values()],
    body: `export const ${constant.name} = ${constant.text};\n`,
  };
}

/** The %init statements that run before the top-level statement `stmt` of
 * `file` (lowerFileInit): when it declares a closed constant, the load of
 * the constant's generated module, deferred like a static island import's
 * (snapshot.ts decides after lowering). */
export function closedIslandInitLoad(
  lowerer: Lowerer,
  file: ts.SourceFile,
  stmt: ts.Statement,
): IrStmt[] {
  if (lowerer.nodeIslands === null || !ts.isVariableStatement(stmt)) return [];
  const constant = closedStatement(lowerer, stmt);
  if (constant === null) return [];
  closedFile(lowerer, file);
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
  if (constant === null) return null;
  const loc = locOf(expr);
  lowerer.usesNodeIsland = true;
  const module = islandModuleGlobal(lowerer, constant.key);
  return fromIsland(
    lowerer,
    islandGet(varRef(module.global.id, DYN, loc), constant.name, loc),
    expr,
  );
}
