/* Removes Flow's type syntax from a module so Node can run it: the oracle
 * side of tests/harness/flow.test.ts. It covers the syntax the Flow fixtures
 * use (annotations, type declarations, type imports and specifiers, casts,
 * type parameters and arguments, declared `this` parameters,
 * optional-parameter marks, %checks) and throws on the type-level nodes and
 * Flow-only declarations it does not remove, so a fixture that uses them
 * fails loudly instead of running differently under Node. */
import { createRequire } from "node:module";
import { join } from "node:path";

interface FlowNode {
  type: string;
  range: [number, number];
  [key: string]: unknown;
}

interface HermesParser {
  parse(text: string, options: object): FlowNode;
  getVisitorKeys(node: FlowNode): readonly string[];
}

const hermes = createRequire(join(import.meta.dirname, "../../packages/compiler/package.json"))(
  "hermes-parser",
) as HermesParser;

/** Nodes removed whole, with their source text. */
const REMOVED = new Set([
  "TypeAnnotation",
  "TypeAlias",
  "OpaqueType",
  "InterfaceDeclaration",
  "DeclareTypeAlias",
  "DeclareOpaqueType",
  "DeclareInterface",
  "DeclareFunction",
  "DeclareVariable",
  "DeclareClass",
  "TypeParameterDeclaration",
  "TypeParameterInstantiation",
  "InferredPredicate",
  "DeclaredPredicate",
]);

/** Type-level nodes reached only below a removed node, and Flow-only
 * declarations the stripper does not handle. */
const TYPE_LEVEL = /(TypeAnnotation|Type|TypeParameter|Variance)$/;
const UNHANDLED = new Set([
  "EnumDeclaration",
  "DeclareExportDeclaration",
  "DeclareExportAllDeclaration",
  "DeclareModule",
  "DeclareModuleExports",
  "ComponentDeclaration",
  "HookDeclaration",
  "AsConstExpression",
]);

export function stripFlowTypes(text: string): string {
  const ast = hermes.parse(text, { flow: "all", sourceType: "module", tokens: false });
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (visited: FlowNode): void => {
    let node = visited;
    const removedDeclaration =
      (node.type === "ImportDeclaration" &&
        (node["importKind"] === "type" || node["importKind"] === "typeof")) ||
      (node.type === "ExportNamedDeclaration" && node["exportKind"] === "type");
    if (REMOVED.has(node.type) || removedDeclaration) {
      edits.push({ start: node.range[0], end: node.range[1], text: "" });
      return;
    }
    // `import {type T, value}`: the import of the value specifiers alone.
    if (node.type === "ImportDeclaration") {
      const specifiers = node["specifiers"] as FlowNode[];
      const isType = (s: FlowNode): boolean =>
        s["importKind"] === "type" || s["importKind"] === "typeof";
      if (specifiers.some(isType)) {
        const kept = specifiers.filter((s) => !isType(s));
        const source = node["source"] as FlowNode;
        const from = text.slice(source.range[0], source.range[1]);
        const named = kept.filter((s) => s.type === "ImportSpecifier");
        const others = kept.filter((s) => s.type !== "ImportSpecifier");
        const parts = others.map((s) => text.slice(s.range[0], s.range[1]));
        if (named.length > 0)
          parts.push(`{ ${named.map((s) => text.slice(s.range[0], s.range[1])).join(", ")} }`);
        const replacement = parts.length === 0 ? "" : `import ${parts.join(", ")} from ${from};`;
        edits.push({ start: node.range[0], end: node.range[1], text: replacement });
        return;
      }
    }
    if (UNHANDLED.has(node.type))
      throw new Error(`stripFlowTypes: unhandled Flow node ${node.type}`);
    if (node.type === "TypeCastExpression" || node.type === "AsExpression") {
      const expression = node["expression"] as FlowNode;
      // `(x: T)` and `x as T` are the operand, kept in parentheses so the
      // surrounding expression parses the same.
      const keep = text.slice(expression.range[0], expression.range[1]);
      edits.push({
        start: node.range[0],
        end: node.range[1],
        text: `(${strip(keep, expression)})`,
      });
      return;
    }
    // A declared `this` is the first parameter: it goes with its comma.
    const params = node["params"];
    if (Array.isArray(params) && params.length > 0) {
      const first = params[0] as FlowNode;
      if (first.type === "Identifier" && first["name"] === "this") {
        const next = params[1] as FlowNode | undefined;
        edits.push({ start: first.range[0], end: next ? next.range[0] : first.range[1], text: "" });
        node = { ...node, params: params.slice(1) };
      }
    }
    if (node.type === "Identifier" && node["optional"] === true) {
      const nameEnd = node.range[0] + (node["name"] as string).length;
      if (text[nameEnd] === "?") edits.push({ start: nameEnd, end: nameEnd + 1, text: "" });
    }
    if (TYPE_LEVEL.test(node.type) && node.type !== "TypeCastExpression")
      throw new Error(`stripFlowTypes: unhandled Flow node ${node.type}`);
    for (const key of hermes.getVisitorKeys(node)) {
      const child = node[key];
      for (const item of Array.isArray(child) ? child : [child])
        if (
          item !== null &&
          typeof item === "object" &&
          typeof (item as FlowNode).type === "string"
        )
          visit(item as FlowNode);
    }
  };
  /** The cast operand's own text with its nested type syntax removed. */
  const strip = (operandText: string, operand: FlowNode): string => {
    const before = edits.length;
    visit(operand);
    const nested = edits.splice(before).sort((a, b) => b.start - a.start);
    let out = operandText;
    for (const edit of nested) {
      const start = edit.start - operand.range[0];
      out = out.slice(0, start) + edit.text + out.slice(edit.end - operand.range[0]);
    }
    return out;
  };
  visit(ast);
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}
