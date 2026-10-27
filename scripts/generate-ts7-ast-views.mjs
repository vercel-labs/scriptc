import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Generate class views rather than structural copies of native AST nodes.
 * The build-time parser reads declarations only; no parser joins the client. */
export function generateAstViews(root, packageRoot, version, check) {
  const require = createRequire(join(root, "package.json"));
  const ts = require("typescript");
  const read = (name) => readFileSync(join(packageRoot, "dist/ast", name), "utf8");
  const parse = (name, source = read(name)) =>
    ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const generated = parse("ast.generated.d.ts");
  const header = [
    `// Generated from typescript@${version} by scripts/generate-ts7-ast-schema.mjs.`,
    "// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.",
    "// Regenerate when changing the TypeScript pin; do not edit by hand.",
  ];
  const write = (name, lines) => {
    const path = join(root, "packages/compiler/src/frontend/ts7", name);
    const output = lines.join("\n") + "\n";
    if (check) {
      if (readFileSync(path, "utf8") !== output)
        throw new Error(`${name} is stale; run node scripts/generate-ts7-ast-schema.mjs`);
    } else writeFileSync(path, output);
  };
  const interfaces = new Map(
    generated.statements.filter(ts.isInterfaceDeclaration).map((node) => [node.name.text, node]),
  );
  const replace = (text, bindings) =>
    text.replace(/\b[A-Za-z_$][\w$]*\b/g, (word) => bindings.get(word) ?? word);
  const members = (name, bindings = new Map()) => {
    if (name === "Node") return new Map();
    const declaration = interfaces.get(name);
    if (!declaration) throw new Error(`Unknown AST base ${name}`);
    const fields = new Map();
    for (const clause of declaration.heritageClauses ?? [])
      for (const base of clause.types) {
        const baseName = base.expression.getText(generated);
        const params = interfaces.get(baseName)?.typeParameters ?? [];
        const args = base.typeArguments ?? [];
        const inherited = new Map();
        params.forEach((param, index) => {
          const argument = args[index] ?? param.default;
          if (!argument)
            throw new Error(`Missing AST type argument ${baseName}.${param.name.text}`);
          inherited.set(param.name.text, replace(argument.getText(generated), bindings));
        });
        for (const [key, value] of members(baseName, inherited)) fields.set(key, value);
      }
    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isIdentifier(member.name))
        throw new Error(`Unexpected AST member in ${name}`);
      const key = member.name.text;
      // Brands and synthetic-factory fields do not exist on remote nodes.
      if (
        /^_.*Brand$/.test(key) ||
        (name === "FunctionLikeBase" && key === "fullSignature") ||
        (name === "SyntheticExpression" && (key === "isSpread" || key === "type"))
      )
        continue;
      let type = replace(member.type.getText(generated), bindings);
      // The pinned native wire and RemoteNode getter encode one tag, despite
      // the SDK factory-oriented interface declaring an array of tags.
      if (key === "jsdocPropertyTags") type = "JSDocPropertyTag";
      // A list's children are a node list, as every other list field.
      if (name === "SyntaxList" && key === "children") type = "NodeArray<Node>";
      // A declaration's modifiers are a modifier list, with their flags.
      if (key === "modifiers") type = type.replace("NodeArray<", "ModifierArray<");
      if (member.questionToken) type += " | undefined";
      fields.set(key, `  readonly ${key}: ${type};`);
    }
    return fields;
  };
  const types = [
    ...header,
    "",
    'import type { AstNode } from "./ast-node.js";',
    'import type { JsxTagNamePropertyAccess, ModifierArray, NodeArray } from "./ast-types.js";',
    'import { SyntaxKind, NodeFlags, ModifierFlags, TokenFlags } from "./enums.js";',
    "type Node = AstNode;",
  ];
  // Brand-only bases otherwise become identical to Node, making the false
  // side of a predicate narrow every node to never. Use actual descendant
  // kind discriminants instead of inventing fields in native storage.
  const derivesFrom = (name, base) =>
    name === base ||
    (interfaces.get(name)?.heritageClauses ?? []).some((clause) =>
      clause.types.some((type) => derivesFrom(type.expression.getText(generated), base)),
    );
  for (const node of generated.statements) {
    if (ts.isTypeAliasDeclaration(node))
      types.push(
        "",
        node.name.text === "TypeNode"
          ? "export type TypeNode = TypeNodeBase | ExpressionWithTypeArguments;"
          : node.getText(generated),
      );
    if (!ts.isInterfaceDeclaration(node)) continue;
    const params = node.typeParameters?.length
      ? `<${node.typeParameters.map((param) => param.getText(generated)).join(", ")}>`
      : "";
    const fields = members(node.name.text);
    // A default clause has no expression; the declaration shares the case clause's.
    if (node.name.text === "DefaultClause" && fields.has("expression"))
      fields.set("expression", "  readonly expression: undefined;");
    if (!fields.has("kind")) {
      const kinds = new Set();
      for (const [name, child] of interfaces) {
        if (!derivesFrom(name, node.name.text)) continue;
        let kind = child.members
          .find((member) => member.name?.getText(generated) === "kind")
          ?.type?.getText(generated);
        if (kind === undefined) continue;
        for (const parameter of child.typeParameters ?? [])
          kind = replace(
            kind,
            new Map([[parameter.name.text, parameter.constraint?.getText(generated) ?? "never"]]),
          );
        kinds.add(kind);
      }
      if (kinds.size > 0) fields.set("kind", `  readonly kind: ${[...kinds].join(" | ")};`);
    }
    types.push(
      "",
      `export interface ${node.name.text}${params} extends Node {`,
      ...fields.values(),
      "}",
    );
  }
  write("ast-types.generated.ts", types);

  // Pair upstream executable bodies with their declared predicates. This
  // preserves the pinned kind/flag semantics without loading SDK JavaScript.
  const guards = [
    ...header,
    "",
    'import { SyntaxKind, NodeFlags, ScriptKind, OuterExpressionKinds } from "./enums.js";',
    'import { getSourceFileOfNode } from "./node-functions.js";',
  ];
  for (const stem of ["is.generated", "is"]) {
    const declarations = parse(`${stem}.d.ts`);
    const signatures = new Map();
    for (const node of declarations.statements) {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) {
        guards.push(node.getText(declarations).replace('"./ast.ts"', '"./ast-types.js"'));
      }
      if (ts.isTypeAliasDeclaration(node))
        guards.push(
          node
            .getText(declarations)
            .replace("WrappedExpression<T extends Expression>", "WrappedExpression")
            .replace("WrappedExpression<Expression>", "WrappedExpression"),
        );
      if (ts.isFunctionDeclaration(node)) signatures.set(node.name.text, node);
    }
    const source = parse(`${stem}.js`);
    for (const fn of source.statements) {
      if (!ts.isFunctionDeclaration(fn) || !fn.body || !fn.name) continue;
      const name = fn.name.text;
      const signature = signatures.get(name);
      let head;
      if (signature) {
        head = signature.getText(declarations).replace("declare ", "").replace(/;$/, "");
        if (fn.parameters.some((param) => param.initializer)) {
          head = head.replace(
            "kinds?: OuterExpressionKinds",
            "kinds: OuterExpressionKinds = OuterExpressionKinds.All",
          );
        }
      } else {
        if (name === "isJSDocTypeAssertion")
          head = "function isJSDocTypeAssertion(node: Node): boolean";
        else {
          if (fn.parameters.length !== 1 || fn.parameters[0].name.getText(source) !== "kind")
            throw new Error(`Unrecognized private guard ${name}`);
          head = `function ${name}(kind: SyntaxKind): boolean`;
        }
      }
      let body = fn.body.getText(source);
      if (name === "isJSDocTypeAssertion")
        body = body
          .replace("expression.kind !==", "expression === undefined || expression.kind !==")
          .replace("node.getSourceFile()", "getSourceFileOfNode(node)");
      if (head.includes("node: Node") && name.startsWith("is")) {
        head = head.replace("node: Node", "node: Node | undefined");
        body = body.replace("{", "{\n    if (node === undefined) return false;");
      }
      guards.push("", head + " " + body);
    }
  }
  // Merge duplicate type-only imports before writing the generated module.
  const imported = new Set();
  const content = guards.filter((line) => {
    if (!line.startsWith("import type {")) return true;
    for (const name of line.slice(line.indexOf("{") + 1, line.indexOf("}")).split(","))
      imported.add(name.trim());
    return false;
  });
  content.splice(
    header.length + 1,
    0,
    `import type { ${[...imported].sort().join(", ")} } from "./ast-types.js";`,
  );
  write("ast-guards.generated.ts", content);

  const { tokenToString } = require(join(packageRoot, "dist/ast/scanner.js"));
  const { SyntaxKind } = require(join(packageRoot, "dist/enums/syntaxKind.js"));
  const tokens = [
    ...header,
    "",
    'import { SyntaxKind } from "./enums.js";',
    "",
    "export function tokenToString(kind: SyntaxKind): string | undefined {",
    "  switch (kind) {",
  ];
  for (let kind = 0; kind <= SyntaxKind.Count; kind++) {
    const text = tokenToString(kind);
    if (text !== undefined) tokens.push(`    case ${kind}: return ${JSON.stringify(text)};`);
  }
  tokens.push("    default: return undefined;", "  }", "}");
  write("ast-tokens.generated.ts", tokens);
}
