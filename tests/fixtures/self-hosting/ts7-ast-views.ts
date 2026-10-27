import type { AstFile } from "../../../packages/compiler/src/frontend/ts7/ast-node.js";
import type { Node, SourceFile, NodeArray, Statement } from "../../../packages/compiler/src/frontend/ts7/ast-types.js";
import * as ts from "../../../packages/compiler/src/frontend/ts7/ast-guards.generated.js";
import { KIND_NODE_LIST } from "../../../packages/compiler/src/frontend/ts7/ast-schema.generated.js";
import { tokenToString } from "../../../packages/compiler/src/frontend/ts7/ast-tokens.generated.js";
import { SyntaxKind } from "../../../packages/compiler/src/frontend/ts7/enums.js";

function check(value: boolean, message: string): void { if (!value) throw new Error(message); }

function checkStatements(nodes: NodeArray<Statement>, source: SourceFile): void {
  check(nodes.nodes === source.statements.nodes, "typed statement list nodes identity");
  for (const statement of nodes.nodes) {
    check(statement.parent === source && statement.getSourceFile() === source, "typed source identity");
    check(ts.isStatement(statement), "statement kind predicate");
  }
}

/** All narrowed values are consumed by native operations, so a structural
 * record copy or a wrong getter ABI cannot pass as a mere successful load. */
export function checkAstViews(file: AstFile): void {
  const source: SourceFile = file.sourceFile;
  checkStatements(source.statements, source);
  check(source.parent === undefined && !ts.isIdentifier(source.parent), "missing root parent");
  let identifiers = 0;
  let strings = 0;
  let declarations = 0;
  let methods = 0;
  let calls = 0;
  let binaries = 0;
  let bodies = 0;
  let names = 0;
  let modifiers = 0;
  for (let index = 1; index < file.wire.nodeCount; index++) {
    if (file.wire.kind(index) === KIND_NODE_LIST) continue;
    const node: Node = file.node(index);
    // These are the structural views used by the production frontend.
    // The cast changes the checker surface while the actual value remains
    // one AstNode; reads must use its original lazy getters and caches.
    const body = (node as { body?: Node }).body;
    const name = (node as { name?: Node })["name"];
    const flags = (node as { modifiers?: NodeArray<Node> }).modifiers;
    check(body === node.body && name === node.name, "structural child getter identity");
    check(flags?.nodes === node.modifiers?.nodes, "structural list getter nodes identity");
    if (body !== undefined) { bodies++; check(body.parent === node, "structural body parent"); }
    if (name !== undefined) { names++; check(name.parent === node, "structural name parent"); }
    if (flags !== undefined) {
      modifiers += flags.nodes.length;
      for (const modifier of flags.nodes) check(modifier.parent === node, "structural modifier parent");
    }
    if (ts.isIdentifier(node)) {
      identifiers += node.text.length;
      check(node.getSourceFile() === source, "identifier source identity");
      check(!ts.isTypeNode(node), "identifier is not a type node");
    }
    if (ts.isStringLiteral(node)) strings += node.text.toUpperCase().length;
    if (ts.isVariableDeclarationList(node)) {
      declarations += node.declarations.nodes.length;
      for (const declaration of node.declarations.nodes) check(declaration.parent === node, "declaration identity");
    }
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members.nodes) {
        if (ts.isMethodDeclaration(member)) methods += member.parameters.nodes.length;
      }
    }
    if (ts.isCallExpression(node)) {
      calls += node.arguments.nodes.length;
      check(node.expression.parent === node, "call callee identity");
    }
    if (ts.isBinaryExpression(node)) {
      binaries++;
      check(node.left === node.childNode("left") && node.right === node.childNode("right"), "binary child identity");
      check(tokenToString(node.operatorToken.kind) !== undefined, "operator spelling");
    }
  }
  check(identifiers > 10 && strings > 0 && declarations > 3 && methods > 0 && calls > 0 && binaries > 0, "typed AST paths executed");
  check(bodies > 0 && names > 0 && modifiers > 0, "structural AST paths executed");
  check(tokenToString(SyntaxKind.EqualsGreaterThanToken) === "=>", "native token lookup");
}
