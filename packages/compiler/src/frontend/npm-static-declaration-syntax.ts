/* Declaration-overload projection for --npm-static. The runtime program
 * still resolves to and compiles package JavaScript, but an authored .d.ts
 * can carry overloads inference cannot reproduce (the common getter/setter
 * shape `name(): string` / `name(value): this`). The native TypeScript 7 syntax pass extracts only complete, representation-safe
 * groups and respells them as JSDoc immediately before the matching
 * exported JavaScript class method. TypeScript 7 then checks and lowers one
 * world: implementation bodies remain the runtime truth, while overload
 * calls get the package author's more precise signature. Zero-argument
 * string/number/boolean methods retain their own declared return contract
 * too; inferred checked values validate at the ordinary return boundary. */

import * as ts from "./ts7/syntax.js";
import { getTextOfNode, tokenStartOfNode } from "./ts7/node-functions.js";

export interface NpmStaticOverloadParameter {
  name: string;
  type: string;
  optional: boolean;
}

export interface NpmStaticOverloadSignature {
  parameters: readonly NpmStaticOverloadParameter[];
  returnType: string;
}

export type NpmStaticDeclarationOverloads = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly NpmStaticOverloadSignature[]>
>;

export type NpmStaticDeclarationProperties = ReadonlyMap<string, ReadonlyMap<string, string>>;

const SCALAR_METHOD_RETURNS = new Set(["string", "number", "boolean"]);
const NULLABLE_VOID_CALLBACK = "(() => void) | null";

export interface NpmStaticRuntimeClassTarget {
  specifier: string | null;
  localName: string;
}

export interface NpmStaticOverloadRewrite {
  text: string;
  insertions: readonly { offset: number; length: number }[];
}

/** TypeScript truncates JSDoc inner/instance namepaths (`Owner~Item`,
 * `Owner#Item`) to Owner. That unrelated nominal type must not dictate a
 * native layout. Keep the unresolved atom checked, preserving containers,
 * string literal types, executable source and every diagnostic offset. */
export function applyNpmStaticJsDocNamepaths(
  sourceFile: ts.SourceFile,
  source: string,
): string | null {
  const replacements = new Map<number, number>();
  const visit = (node: ts.Node): void => {
    for (const doc of node.jsDoc ?? [])
      for (const tag of doc.tags?.nodes ?? []) {
        const expression = tag.typeExpression;
        if (expression?.kind !== ts.SyntaxKind.JSDocTypeExpression) continue;
        const start = tokenStartOfNode(expression);
        if (source[start] !== "{") continue;
        let depth = 1;
        let quote = "";
        for (let i = start + 1; i < tag.end && depth > 0; i++) {
          const char = source[i]!;
          if (quote !== "") {
            if (char === "\\") i++;
            else if (char === quote) quote = "";
            continue;
          }
          if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
          }
          if (char === "{") {
            depth++;
            continue;
          }
          if (char === "}") {
            depth--;
            continue;
          }
          const name = /^[$A-Z_a-z][$\w]*(?:[.#~][$A-Z_a-z][$\w]*)*/.exec(
            source.slice(i, tag.end),
          )?.[0];
          if (!name) continue;
          if (name.includes("~") || name.includes("#")) replacements.set(i, name.length);
          i += name.length - 1;
        }
      }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (replacements.size === 0) return null;
  let text = source;
  for (const [offset, length] of replacements) {
    text = text.slice(0, offset) + "*" + " ".repeat(length - 1) + text.slice(offset + length);
  }
  return text;
}

/** Recover nullable class storage erased by a JavaScript bundle. A null
 * field whose writes construct one named class or call one static factory (or reset to null)
 * keeps that class's native methods instead of an opaque checked value.
 * Unknown writes, shadowed constructors and authored annotations decline;
 * downstream lowering still checks every assignment against the slot. */
export function applyNpmStaticNullableClassFields(
  sourceFile: ts.SourceFile,
  source: string,
): NpmStaticOverloadRewrite | null {
  const constructors = new Set<string>();
  for (const statement of sourceFile.statements.nodes) {
    if (ts.isClassDeclaration(statement) && statement.name) constructors.add(statement.name.text);
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      const clause = statement.importClause;
      if (clause?.name) constructors.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements.nodes) {
          if (!binding.isTypeOnly) constructors.add(binding.name.text);
        }
      }
    }
  }
  const assignment = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  // Mutable constructor bindings cannot supply a stable nominal type.
  const rejectAssignedName = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) constructors.delete(node.text);
    else if (ts.isArrayLiteralExpression(node))
      for (const item of node.elements.nodes) rejectAssignedName(item);
    else if (ts.isObjectLiteralExpression(node))
      for (const item of node.properties.nodes) {
        if (ts.isPropertyAssignment(item)) rejectAssignedName(item.initializer);
        else if (ts.isShorthandPropertyAssignment(item)) rejectAssignedName(item.name);
        else if (ts.isSpreadAssignment(item)) rejectAssignedName(item.expression);
      }
    else if (ts.isSpreadElement(node) || ts.isParenthesizedExpression(node))
      rejectAssignedName(node.expression);
    else if (assignment(node)) rejectAssignedName(node.left);
  };
  const rejectMutable = (node: ts.Node): void => {
    if (assignment(node)) rejectAssignedName(node.left);
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      rejectAssignedName(node.initializer);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    )
      constructors.delete(node.operand.text);
    ts.forEachChild(node, rejectMutable);
  };
  rejectMutable(sourceFile);
  const inserts: { offset: number; text: string }[] = [];
  for (const statement of sourceFile.statements.nodes) {
    if (!ts.isClassDeclaration(statement)) continue;
    const fields = new Map<
      string,
      { member: ts.PropertyDeclaration; className?: string; invalid: boolean }
    >();
    for (const member of statement.members.nodes) {
      if (
        !ts.isPropertyDeclaration(member) ||
        !ts.isIdentifier(member.name) ||
        member.initializer?.kind !== ts.SyntaxKind.NullKeyword ||
        hasModifier(member, ts.SyntaxKind.StaticKeyword)
      )
        continue;
      const leading = source.slice(member.pos, tokenStartOfNode(member));
      if (jsDocTypeOf(member) !== undefined || leading.includes("@type")) continue;
      fields.set(member.name.text, { member, invalid: false });
    }
    if (fields.size === 0) continue;
    // Be conservative about scope: even a binding in an unrelated method
    // excludes that constructor name from this class's inference.
    const shadowed = new Set<string>();
    const bindingNames = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) shadowed.add(name.text);
      else
        for (const element of name.elements.nodes)
          if (ts.isBindingElement(element) && element.name !== undefined)
            bindingNames(element.name);
    };
    const collectBindings = (node: ts.Node): void => {
      if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && node.name !== undefined)
        bindingNames(node.name);
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node)) &&
        node.name
      )
        shadowed.add(node.name.text);
      ts.forEachChild(node, collectBindings);
    };
    for (const member of statement.members.nodes) collectBindings(member);
    const targetField = (node: ts.Node): string | null => {
      if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword)
        return node.name.text;
      if (
        ts.isElementAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        return ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : "*";
      }
      return null;
    };
    const invalidate = (node: ts.Node): void => {
      const name = targetField(node);
      if (name === "*") for (const field of fields.values()) field.invalid = true;
      else if (name !== null && fields.has(name)) fields.get(name)!.invalid = true;
      ts.forEachChild(node, invalidate);
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)
      )
        return;
      if (assignment(node)) {
        const name = targetField(node.left);
        const field = name !== null ? fields.get(name) : undefined;
        if (field && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          let value = node.right;
          while (ts.isParenthesizedExpression(value)) value = value.expression;
          if (value.kind !== ts.SyntaxKind.NullKeyword) {
            const construct =
              ts.isNewExpression(value) && ts.isIdentifier(value.expression)
                ? value.expression
                : null;
            const factory =
              ts.isCallExpression(value) &&
              !value.questionDotToken &&
              ts.isPropertyAccessExpression(value.expression) &&
              !value.expression.questionDotToken &&
              ts.isIdentifier(value.expression.name) &&
              ts.isIdentifier(value.expression.expression)
                ? value.expression
                : null;
            const owner = construct ?? factory?.expression;
            if (
              owner &&
              ts.isIdentifier(owner) &&
              constructors.has(owner.text) &&
              !shadowed.has(owner.text)
            ) {
              // ReturnType asks the same implementation checker that types
              // the call; no declaration-only class name is invented.
              const name = factory
                ? `ReturnType<typeof ${owner.text}.${factory.name.text}>`
                : owner.text;
              if (field.className !== undefined && field.className !== name) field.invalid = true;
              field.className = name;
            } else field.invalid = true;
          }
        } else invalidate(node.left);
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      )
        invalidate(node.operand);
      if (ts.isDeleteExpression(node)) invalidate(node.expression);
      ts.forEachChild(node, visit);
    };
    for (const member of statement.members.nodes) {
      if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) continue;
      if (
        (ts.isConstructorDeclaration(member) ||
          ts.isMethodDeclaration(member) ||
          ts.isAccessor(member)) &&
        member.body
      )
        visit(member.body);
      if (ts.isPropertyDeclaration(member) && member.initializer) visit(member.initializer);
    }
    for (const field of fields.values()) {
      if (field.invalid || field.className === undefined) continue;
      inserts.push({
        offset: tokenStartOfNode(field.member),
        text: `/** @type {${field.className} | null} */ `,
      });
    }
  }
  if (inserts.length === 0) return null;
  let text = source;
  for (const insert of [...inserts].sort((a, b) => b.offset - a.offset))
    text = text.slice(0, insert.offset) + insert.text + text.slice(insert.offset);
  return {
    text,
    insertions: inserts.map((insert) => ({ offset: insert.offset, length: insert.text.length })),
  };
}

/** A JavaScript return annotation cannot make Array.find return a value
 * when no element matches. Widen only direct finds on constructor-owned
 * arrays; arbitrary methods also named find are left alone. */
export function applyNpmStaticFindReturnWidening(
  sourceFile: ts.SourceFile,
  source: string,
): NpmStaticOverloadRewrite | null {
  const insertions: { offset: number; length: number }[] = [];
  for (const statement of sourceFile.statements.nodes) {
    if (!ts.isClassDeclaration(statement)) continue;
    const constructor = statement.members.nodes.find(
      (member): member is ts.ConstructorDeclaration =>
        ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    if (constructor?.body === undefined) continue;
    const arrayFields = new Set<string>();
    for (const bodyStatement of constructor.body.statements.nodes) {
      if (
        !ts.isExpressionStatement(bodyStatement) ||
        !ts.isBinaryExpression(bodyStatement.expression)
      )
        continue;
      const { left, right, operatorToken } = bodyStatement.expression;
      if (
        operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isArrayLiteralExpression(right)
      )
        arrayFields.add(left.name.text);
    }
    for (const member of statement.members.nodes) {
      if (!ts.isMethodDeclaration(member) || member.body?.statements?.nodes.length !== 1) continue;
      const returned = member.body.statements.nodes[0];
      if (
        !returned ||
        !ts.isReturnStatement(returned) ||
        returned.expression === undefined ||
        !ts.isCallExpression(returned.expression)
      )
        continue;
      const callee = returned.expression.expression;
      if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "find" ||
        !ts.isPropertyAccessExpression(callee.expression) ||
        callee.expression.expression.kind !== ts.SyntaxKind.ThisKeyword ||
        !arrayFields.has(callee.expression.name.text)
      )
        continue;
      const returnType = jsDocReturnTypeOf(member);
      if (
        returnType === undefined ||
        !ts.isTypeReferenceNode(returnType) ||
        !ts.isIdentifier(returnType.typeName) ||
        (returnType.typeArguments?.nodes.length ?? 0) !== 0
      )
        continue;
      insertions.push({ offset: returnType.end, length: " | undefined".length });
    }
  }
  if (insertions.length === 0) return null;
  let text = source;
  for (const insertion of [...insertions].sort((a, b) => b.offset - a.offset)) {
    text = text.slice(0, insertion.offset) + " | undefined" + text.slice(insertion.offset);
  }
  return { text, insertions };
}

const SAFE_KEYWORD_TYPES = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.VoidKeyword,
]);

/** Ordinary tags belong to the last attached comment. Earlier comments
 * contribute overloads, which these type/return lookups do not consume. */
function lastJsDocTag(node: ts.Node, kind: ts.SyntaxKind): ts.Node | undefined {
  const docs = node.jsDoc;
  if (docs === undefined || docs.length === 0) return undefined;
  for (const tag of docs[docs.length - 1]!.tags?.nodes ?? []) {
    if (tag.kind === kind) return tag;
  }
  return undefined;
}

/** These passes inspect class properties and methods. A property's
 * initializer may own an annotation, but a parenthesized type assertion
 * describes the expression rather than the property's storage type. */
function jsDocTagType(node: ts.Node, kind: ts.SyntaxKind): ts.TypeNode | undefined {
  let tag: ts.Node | undefined;
  if (
    ts.isPropertyDeclaration(node) &&
    node.initializer !== undefined &&
    !ts.isParenthesizedExpression(node.initializer)
  ) {
    tag = lastJsDocTag(node.initializer, kind);
  }
  tag ??= lastJsDocTag(node, kind);
  return tag?.typeExpression?.type as ts.TypeNode | undefined;
}

function jsDocTypeOf(node: ts.Node): ts.TypeNode | undefined {
  return jsDocTagType(node, ts.SyntaxKind.JSDocTypeTag);
}

function jsDocReturnTypeOf(node: ts.Node): ts.TypeNode | undefined {
  const returned = jsDocTagType(node, ts.SyntaxKind.JSDocReturnTag);
  if (returned !== undefined) return returned;
  const type = jsDocTypeOf(node);
  if (type === undefined) return undefined;
  if (ts.isTypeLiteralNode(type)) {
    return type.members.nodes.find(ts.isCallSignatureDeclaration)?.type;
  }
  return ts.isFunctionTypeNode(type) ? type.type : undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function safeTypeText(node: ts.TypeNode, className: string): string | null {
  if (SAFE_KEYWORD_TYPES.has(node.kind) || ts.isThisTypeNode(node)) return getTextOfNode(node);
  if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isParenthesizedTypeNode(node)) {
    const inner = safeTypeText(node.type, className);
    return inner === null ? null : `(${inner})`;
  }
  if (ts.isArrayTypeNode(node)) {
    const element = safeTypeText(node.elementType, className);
    return element === null ? null : `${element}[]`;
  }
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return safeTypeText(node.type, className);
  }
  if (ts.isUnionTypeNode(node)) {
    const arms = node.types.nodes.map((type) => safeTypeText(type, className));
    return arms.some((arm) => arm === null) ? null : arms.join(" | ");
  }
  if (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === "Record" &&
    node.typeArguments?.nodes.length === 2 &&
    node.typeArguments.nodes[0]?.kind === ts.SyntaxKind.StringKeyword &&
    node.typeArguments.nodes[1]?.kind === ts.SyntaxKind.StringKeyword
  ) {
    return "Record<string, string>";
  }
  return ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === className &&
    (node.typeArguments?.nodes.length ?? 0) === 0
    ? className
    : null;
}

function overloadSignature(
  sourceFile: ts.SourceFile,
  className: string,
  method: ts.MethodDeclaration,
): NpmStaticOverloadSignature | null {
  if (
    !ts.isIdentifier(method.name) ||
    method.type === undefined ||
    (method.typeParameters?.nodes.length ?? 0) !== 0 ||
    hasModifier(method, ts.SyntaxKind.StaticKeyword) ||
    hasModifier(method, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(method, ts.SyntaxKind.ProtectedKeyword)
  ) {
    return null;
  }
  const returnType = safeTypeText(method.type, className);
  if (returnType === null) return null;
  const parameters: NpmStaticOverloadParameter[] = [];
  for (const parameter of method.parameters.nodes) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.name.text === "this" ||
      parameter.type === undefined ||
      parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined
    ) {
      return null;
    }
    const type = safeTypeText(parameter.type, className);
    if (type === null) return null;
    parameters.push({
      name: parameter.name.text,
      type,
      optional: parameter.questionToken !== undefined,
    });
  }
  return { parameters, returnType };
}

/** Extracts complete safe overload groups and zero-argument scalar-return
 * contracts from exported non-generic classes. */
export function parseNpmStaticDeclarationOverloads(
  sourceFile: ts.SourceFile,
): NpmStaticDeclarationOverloads {
  const classes = new Map<string, ReadonlyMap<string, readonly NpmStaticOverloadSignature[]>>();
  for (const statement of sourceFile.statements.nodes) {
    if (
      !ts.isClassDeclaration(statement) ||
      statement.name === undefined ||
      (statement.typeParameters?.nodes.length ?? 0) !== 0 ||
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      continue;
    }
    const className = statement.name.text;
    const groups = new Map<string, ts.MethodDeclaration[]>();
    for (const member of statement.members.nodes) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const group = groups.get(member.name.text) ?? [];
      group.push(member);
      groups.set(member.name.text, group);
    }
    const overloads = new Map<string, readonly NpmStaticOverloadSignature[]>();
    for (const [name, methods] of groups) {
      const signatures = methods.map((method) => overloadSignature(sourceFile, className, method));
      // A partial set could select the wrong branch. Keep inference when
      // any authored signature is outside the projection's safe grammar.
      if (signatures.some((signature) => signature === null)) continue;
      if (
        signatures.length === 1 &&
        !signatures[0]!.parameters.some((parameter) => parameter.optional) &&
        !(
          signatures[0]!.parameters.length === 0 &&
          SCALAR_METHOD_RETURNS.has(signatures[0]!.returnType)
        )
      )
        continue;
      overloads.set(name, signatures as NpmStaticOverloadSignature[]);
    }
    if (overloads.size > 0) classes.set(className, overloads);
  }
  return classes;
}

function nullableSelfType(node: ts.TypeNode, className: string): string | null {
  if (!ts.isUnionTypeNode(node) || node.types.nodes.length !== 2) return null;
  const arms = node.types.nodes.map((type) => safeTypeText(type, className));
  return arms.includes(className) && arms.includes("null") ? `${className} | null` : null;
}

function nullableVoidCallbackType(node: ts.TypeNode): string | null {
  if (!ts.isUnionTypeNode(node) || node.types.nodes.length !== 2) return null;
  let callback = false;
  let nullable = false;
  for (let arm of node.types.nodes) {
    while (ts.isParenthesizedTypeNode(arm)) arm = arm.type;
    if (ts.isLiteralTypeNode(arm) && arm.literal.kind === ts.SyntaxKind.NullKeyword)
      nullable = true;
    else if (
      ts.isFunctionTypeNode(arm) &&
      arm.parameters.nodes.length === 0 &&
      (arm.typeParameters?.nodes.length ?? 0) === 0 &&
      arm.type?.kind === ts.SyntaxKind.VoidKeyword
    )
      callback = true;
    else return null;
  }
  return callback && nullable ? NULLABLE_VOID_CALLBACK : null;
}

/** Extracts nullable self links and zero-argument void callback fields. */
export function parseNpmStaticDeclarationProperties(
  sourceFile: ts.SourceFile,
): NpmStaticDeclarationProperties {
  const classes = new Map<string, ReadonlyMap<string, string>>();
  for (const statement of sourceFile.statements.nodes) {
    if (
      !ts.isClassDeclaration(statement) ||
      statement.name === undefined ||
      (statement.typeParameters?.nodes.length ?? 0) !== 0 ||
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      continue;
    }
    const className = statement.name.text;
    const properties = new Map<string, string>();
    for (const member of statement.members.nodes) {
      if (
        !ts.isPropertyDeclaration(member) ||
        !ts.isIdentifier(member.name) ||
        member.type === undefined ||
        member.questionToken !== undefined ||
        hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
        hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
        hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
      ) {
        continue;
      }
      const type =
        nullableSelfType(member.type, className) ?? nullableVoidCallbackType(member.type);
      if (type !== null) properties.set(member.name.text, type);
    }
    if (properties.size > 0) classes.set(className, properties);
  }
  return classes;
}

/** Relative declaration-barrel edges whose target stays subject to the
 * caller's package-bounded resolution. Bare type dependencies deliberately
 * do not inherit the opted package's declaration trust. */
export function npmStaticDeclarationReexports(sourceFile: ts.SourceFile): readonly string[] {
  return sourceFile.statements.nodes.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text.startsWith(".")
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

function requireSpecifier(expression: ts.Expression | undefined): string | null {
  const argument =
    expression !== undefined && ts.isCallExpression(expression)
      ? expression.arguments.nodes[0]
      : undefined;
  return expression !== undefined &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.arguments.nodes.length === 1 &&
    argument !== undefined &&
    ts.isStringLiteralLike(argument)
    ? argument.text
    : null;
}

/** Maps declaration class names to one implementation edge and binding.
 * Named ESM aliases preserve the implementation's exported name, including
 * bundler-renamed classes. Multi-hop re-exports remain outside this slice. */
export function npmStaticRuntimeClassTargets(
  sourceFile: ts.SourceFile,
  source: string,
  classNames: ReadonlySet<string>,
): ReadonlyMap<string, NpmStaticRuntimeClassTarget> {
  const localClasses = new Set(
    sourceFile.statements.nodes.flatMap((statement) =>
      ts.isClassDeclaration(statement) && statement.name !== undefined ? [statement.name.text] : [],
    ),
  );
  const linked = new Map<string, { imported: string; specifier: string; esm?: true }>();
  for (const statement of sourceFile.statements.nodes) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations.nodes) {
        const specifier = requireSpecifier(declaration.initializer);
        if (
          specifier === null ||
          !specifier.startsWith(".") ||
          !ts.isObjectBindingPattern(declaration.name)
        )
          continue;
        for (const element of declaration.name.elements.nodes) {
          if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
          const imported =
            element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
          linked.set(element.name.text, { imported, specifier });
        }
      }
      continue;
    }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".") &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements.nodes) {
        if (element.isTypeOnly) continue;
        linked.set(element.name.text, {
          imported: element.propertyName?.text ?? element.name.text,
          specifier: statement.moduleSpecifier.text,
          esm: true,
        });
      }
    }
  }
  const targets = new Map<string, NpmStaticRuntimeClassTarget>();
  const record = (exported: string, local: string, specifier?: string, esmAlias = false): void => {
    if (!classNames.has(exported) || (!esmAlias && exported !== local) || targets.has(exported))
      return;
    if (specifier !== undefined) {
      targets.set(exported, { specifier, localName: local });
      return;
    }
    const imported = linked.get(local);
    if (imported !== undefined && ((esmAlias && imported.esm) || imported.imported === exported)) {
      targets.set(exported, { specifier: imported.specifier, localName: imported.imported });
    } else if (localClasses.has(local))
      targets.set(exported, { specifier: null, localName: local });
  };
  for (const statement of sourceFile.statements.nodes) {
    if (
      ts.isClassDeclaration(statement) &&
      statement.name !== undefined &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      record(statement.name.text, statement.name.text);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const specifier =
        statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      if (specifier !== undefined && !specifier.startsWith(".")) continue;
      for (const element of statement.exportClause.elements.nodes) {
        if (!statement.isTypeOnly && !element.isTypeOnly) {
          record(
            element.name.text,
            element.propertyName?.text ?? element.name.text,
            specifier,
            true,
          );
        }
      }
      continue;
    }
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression))
      continue;
    const { left, right, operatorToken } = statement.expression;
    if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    if (
      ts.isPropertyAccessExpression(left) &&
      ts.isIdentifier(right) &&
      ((ts.isIdentifier(left.expression) && left.expression.text === "exports") ||
        (ts.isPropertyAccessExpression(left.expression) &&
          ts.isIdentifier(left.expression.expression) &&
          left.expression.expression.text === "module" &&
          left.expression.name.text === "exports"))
    ) {
      record(left.name.text, right.text);
      continue;
    }
    if (
      ts.isPropertyAccessExpression(left) &&
      ts.isIdentifier(left.expression) &&
      left.expression.text === "module" &&
      left.name.text === "exports" &&
      ts.isObjectLiteralExpression(right)
    ) {
      for (const property of right.properties.nodes) {
        if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name))
          record(property.name.text, property.name.text);
        else if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          ts.isIdentifier(property.initializer)
        ) {
          record(property.name.text, property.initializer.text);
        }
      }
    }
  }
  return targets;
}

function exportedClassNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements.nodes) {
    if (
      ts.isClassDeclaration(statement) &&
      statement.name !== undefined &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      names.add(statement.name.text);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements.nodes)
        names.add(element.propertyName?.text ?? element.name.text);
      continue;
    }
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression))
      continue;
    const { left, right, operatorToken } = statement.expression;
    if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    if (
      ts.isPropertyAccessExpression(left) &&
      ts.isIdentifier(right) &&
      ((ts.isIdentifier(left.expression) && left.expression.text === "exports") ||
        (ts.isPropertyAccessExpression(left.expression) &&
          ts.isIdentifier(left.expression.expression) &&
          left.expression.expression.text === "module" &&
          left.expression.name.text === "exports")) &&
      left.name.text === right.text
    ) {
      names.add(right.text);
      continue;
    }
    if (
      ts.isPropertyAccessExpression(left) &&
      ts.isIdentifier(left.expression) &&
      left.expression.text === "module" &&
      left.name.text === "exports" &&
      ts.isObjectLiteralExpression(right)
    ) {
      for (const property of right.properties.nodes) {
        if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name))
          names.add(property.name.text);
        else if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          ts.isIdentifier(property.initializer) &&
          property.name.text === property.initializer.text
        ) {
          names.add(property.name.text);
        }
      }
    }
  }
  return names;
}

function overloadComment(signature: NpmStaticOverloadSignature): string {
  const params = signature.parameters.map(
    (parameter) =>
      `@param {${parameter.type}} ${parameter.optional ? `[${parameter.name}]` : parameter.name}`,
  );
  return `/** @overload ${params.join(" ")} @returns {${signature.returnType}} */`;
}

function implementationComment(
  className: string,
  method: ts.MethodDeclaration,
  signatures: readonly NpmStaticOverloadSignature[],
): string | null {
  if (
    method.parameters.nodes.some(
      (parameter) => !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken !== undefined,
    )
  )
    return null;
  const maxParams = Math.max(...signatures.map((signature) => signature.parameters.length));
  if (method.parameters.nodes.length !== maxParams) return null;
  const params: string[] = [];
  for (let index = 0; index < maxParams; index++) {
    const types = [
      ...new Set(
        signatures.flatMap((signature): string[] => {
          const type = signature.parameters[index]?.type;
          return type === undefined ? [] : [type];
        }),
      ),
    ];
    if (types.length === 0) return null;
    const parameter = method.parameters.nodes[index];
    if (parameter === undefined || !ts.isIdentifier(parameter.name)) return null;
    const name = parameter.name.text;
    const optional = signatures.some((signature) => {
      const candidate = signature.parameters[index];
      return candidate === undefined || candidate.optional;
    });
    params.push(`@param {${types.join(" | ")}} ${optional ? `[${name}]` : name}`);
  }
  const returns = [
    ...new Set(signatures.map((signature) => signature.returnType.replace(/\bthis\b/g, className))),
  ];
  return `/** ${params.join(" ")} @returns {${returns.join(" | ")}} */`;
}

function directReturn(statement: ts.Statement): ts.ReturnStatement | null {
  if (ts.isReturnStatement(statement)) return statement;
  return ts.isBlock(statement) &&
    statement.statements.nodes.length === 1 &&
    ts.isReturnStatement(statement.statements.nodes[0]!)
    ? statement.statements.nodes[0]!
    : null;
}

function undefinedParameterTest(expression: ts.Expression, parameter: string): boolean {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  )
    return false;
  const matches = (left: ts.Expression, right: ts.Expression): boolean =>
    ts.isIdentifier(left) &&
    left.text === parameter &&
    ts.isIdentifier(right) &&
    right.text === "undefined";
  return matches(expression.left, expression.right) || matches(expression.right, expression.left);
}

function overloadArrayBackingField(
  method: ts.MethodDeclaration,
  signatures: readonly NpmStaticOverloadSignature[],
): { field: string; type: string } | null {
  if (
    method.body === undefined ||
    method.parameters.nodes.length !== 1 ||
    !ts.isIdentifier(method.parameters.nodes[0]!.name)
  )
    return null;
  const getters = signatures.filter(
    (signature) => signature.parameters.length === 0 && signature.returnType.endsWith("[]"),
  );
  if (getters.length !== 1) return null;
  const parameter = method.parameters.nodes[0]!.name.text;
  for (const statement of method.body.statements.nodes) {
    if (!ts.isIfStatement(statement) || !undefinedParameterTest(statement.expression, parameter))
      continue;
    const returned = directReturn(statement.thenStatement);
    const expression = returned?.expression;
    if (
      expression !== undefined &&
      ts.isPropertyAccessExpression(expression) &&
      expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      return { field: expression.name.text, type: getters[0]!.returnType };
    }
  }
  return null;
}

/** Injects declaration overload JSDoc into matching exported JS classes. */
export function applyNpmStaticDeclarationOverloads(
  sourceFile: ts.SourceFile,
  source: string,
  declarations: NpmStaticDeclarationOverloads,
): NpmStaticOverloadRewrite | null {
  if (declarations.size === 0) return null;
  const exported = exportedClassNames(sourceFile);
  const inserts: { offset: number; text: string }[] = [];
  for (const statement of sourceFile.statements.nodes) {
    if (
      !ts.isClassDeclaration(statement) ||
      statement.name === undefined ||
      !exported.has(statement.name.text)
    )
      continue;
    const classOverloads = declarations.get(statement.name.text);
    if (classOverloads === undefined) continue;
    const constructor = statement.members.nodes.find(
      (member): member is ts.ConstructorDeclaration =>
        ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    const projectedFields = new Set<string>();
    for (const member of statement.members.nodes) {
      if (
        !ts.isMethodDeclaration(member) ||
        !ts.isIdentifier(member.name) ||
        member.body === undefined
      )
        continue;
      const signatures = classOverloads.get(member.name.text);
      if (signatures === undefined) continue;
      if (
        hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
        hasModifier(member, ts.SyntaxKind.AsyncKeyword) ||
        member.asteriskToken !== undefined
      )
        continue;
      const backing = overloadArrayBackingField(member, signatures);
      if (
        backing !== null &&
        constructor?.body !== undefined &&
        !projectedFields.has(backing.field)
      ) {
        for (const bodyStatement of constructor.body.statements.nodes) {
          if (
            !ts.isExpressionStatement(bodyStatement) ||
            !ts.isBinaryExpression(bodyStatement.expression)
          )
            continue;
          const { left, right, operatorToken } = bodyStatement.expression;
          if (
            operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isArrayLiteralExpression(right) ||
            right.elements.nodes.length !== 0 ||
            !ts.isPropertyAccessExpression(left) ||
            left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
            left.name.text !== backing.field
          ) {
            continue;
          }
          const leading = source.slice(bodyStatement.pos, tokenStartOfNode(bodyStatement));
          if (!leading.includes("@type")) {
            inserts.push({
              offset: tokenStartOfNode(bodyStatement),
              text: `/** @type {${backing.type}} */ `,
            });
          }
          projectedFields.add(backing.field);
          break;
        }
      }
      const jsDocs = member.jsDoc ?? [];
      if (jsDocs.some((doc) => source.slice(doc.pos, doc.end).includes("@overload"))) continue;
      if (signatures.length === 1) {
        const implementation = implementationComment(statement.name.text, member, signatures);
        if (implementation !== null) {
          const existing = jsDocs.map((doc) => source.slice(doc.pos, doc.end)).join("\n");
          const missingOptional = signatures[0]!.parameters.some(
            (parameter) => parameter.optional && !existing.includes(`[${parameter.name}]`),
          );
          if (missingOptional)
            inserts.push({ offset: tokenStartOfNode(member), text: `${implementation} ` });
          else if (
            jsDocs.length === 0 &&
            member.parameters.nodes.length === 0 &&
            SCALAR_METHOD_RETURNS.has(signatures[0]!.returnType)
          ) {
            inserts.push({ offset: tokenStartOfNode(member), text: `${implementation} ` });
          }
        }
        continue;
      }
      const implementation =
        jsDocs.length === 0 ? implementationComment(statement.name.text, member, signatures) : null;
      if (jsDocs.length === 0 && implementation === null) continue;
      const offset =
        (jsDocs[0] === undefined ? undefined : tokenStartOfNode(jsDocs[0])) ??
        tokenStartOfNode(member);
      const text = `${signatures.map(overloadComment).join(" ")} ${implementation === null ? "" : implementation + " "}`;
      inserts.push({ offset, text });
    }
  }
  if (inserts.length === 0) return null;
  // TypeScript attaches method JSDoc only after a line break. Minified
  // classes need that break as well, or the projected return/overloads
  // are ignored and a second pass keeps injecting the same annotation.
  for (const insert of inserts) {
    const lineStart = source.lastIndexOf("\n", insert.offset - 1) + 1;
    if (source.slice(lineStart, insert.offset).trim().length !== 0)
      insert.text = "\n" + insert.text;
  }
  let text = source;
  for (const insert of [...inserts].sort((a, b) => b.offset - a.offset)) {
    text = text.slice(0, insert.offset) + insert.text + text.slice(insert.offset);
  }
  return {
    text,
    insertions: inserts
      .sort((a, b) => a.offset - b.offset)
      .map((insert) => ({ offset: insert.offset, length: insert.text.length })),
  };
}

/** Projects self links at constructor null writes and nullable callbacks at
 * field definitions. Local subclasses retain a callback's nullable storage
 * type when an arrow replaces null, keeping caller inference slot-exact. */
export function applyNpmStaticDeclarationProperties(
  sourceFile: ts.SourceFile,
  source: string,
  declarations: NpmStaticDeclarationProperties,
): NpmStaticOverloadRewrite | null {
  if (declarations.size === 0) return null;
  const exported = exportedClassNames(sourceFile);
  const inserts: { offset: number; text: string }[] = [];
  const classes = new Map<string, ts.ClassDeclaration>();
  for (const statement of sourceFile.statements.nodes) {
    if (ts.isClassDeclaration(statement) && statement.name !== undefined)
      classes.set(statement.name.text, statement);
  }
  const effectiveProperties = new Map<string, ReadonlyMap<string, string>>();
  const collecting = new Set<string>();
  const propertiesOf = (name: string): ReadonlyMap<string, string> => {
    const existing = effectiveProperties.get(name);
    if (existing) return existing;
    if (collecting.has(name)) return new Map();
    collecting.add(name);
    const statement = classes.get(name);
    const base = statement?.heritageClauses?.nodes.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types?.nodes[0]?.expression;
    const properties = new Map<string, string>();
    if (base && ts.isIdentifier(base) && classes.has(base.text)) {
      // Self-link types belong to their own class. Only the callback ABI
      // is independent of the declaring class and safe to inherit here.
      for (const [field, type] of propertiesOf(base.text)) {
        if (type === NULLABLE_VOID_CALLBACK) properties.set(field, type);
      }
    }
    if (exported.has(name)) {
      const declared = declarations.get(name);
      if (declared !== undefined) for (const [field, type] of declared) properties.set(field, type);
    }
    collecting.delete(name);
    effectiveProperties.set(name, properties);
    return properties;
  };
  const callbackInitializer = (node: ts.Expression): boolean => {
    if (
      !ts.isArrowFunction(node) ||
      node.parameters.nodes.length !== 0 ||
      (node.typeParameters?.nodes.length ?? 0) !== 0 ||
      hasModifier(node, ts.SyntaxKind.AsyncKeyword) ||
      !ts.isBlock(node.body)
    )
      return false;
    // A void callback contract permits value-returning implementations in
    // TypeScript. Widen only arrows that really return undefined, so a
    // derived callback's observable result can never be discarded here.
    const returnsValue = (child: ts.Node): boolean | undefined => {
      if (ts.isFunctionLike(child) || ts.isClassDeclaration(child) || ts.isClassExpression(child))
        return undefined;
      if (ts.isReturnStatement(child) && child.expression !== undefined) return true;
      return ts.forEachChild(child, returnsValue);
    };
    return returnsValue(node.body) !== true;
  };
  for (const statement of sourceFile.statements.nodes) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
    const properties = propertiesOf(statement.name.text);
    if (properties.size === 0) continue;
    for (const member of statement.members.nodes) {
      if (
        !ts.isPropertyDeclaration(member) ||
        !ts.isIdentifier(member.name) ||
        member.initializer === undefined ||
        hasModifier(member, ts.SyntaxKind.StaticKeyword)
      )
        continue;
      const type = properties.get(member.name.text);
      if (
        type !== NULLABLE_VOID_CALLBACK ||
        (member.initializer.kind !== ts.SyntaxKind.NullKeyword &&
          !callbackInitializer(member.initializer))
      )
        continue;
      const leading = source.slice(member.pos, tokenStartOfNode(member));
      if (jsDocTypeOf(member) !== undefined || leading.includes("@type")) continue;
      inserts.push({ offset: tokenStartOfNode(member), text: `/** @type {${type}} */ ` });
    }
    const constructor = statement.members.nodes.find(
      (member): member is ts.ConstructorDeclaration =>
        ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    if (constructor?.body === undefined) continue;
    for (const bodyStatement of constructor.body.statements.nodes) {
      if (
        !ts.isExpressionStatement(bodyStatement) ||
        !ts.isBinaryExpression(bodyStatement.expression)
      )
        continue;
      const { left, right, operatorToken } = bodyStatement.expression;
      if (
        operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        right.kind !== ts.SyntaxKind.NullKeyword ||
        !ts.isPropertyAccessExpression(left) ||
        left.expression.kind !== ts.SyntaxKind.ThisKeyword
      ) {
        continue;
      }
      const type = properties.get(left.name.text);
      if (type === undefined) continue;
      const leading = source.slice(bodyStatement.pos, tokenStartOfNode(bodyStatement));
      if (leading.includes("@type")) continue;
      inserts.push({ offset: tokenStartOfNode(bodyStatement), text: `/** @type {${type}} */ ` });
    }
  }
  if (inserts.length === 0) return null;
  let text = source;
  for (const insert of [...inserts].sort((a, b) => b.offset - a.offset)) {
    text = text.slice(0, insert.offset) + insert.text + text.slice(insert.offset);
  }
  return {
    text,
    insertions: inserts
      .sort((a, b) => a.offset - b.offset)
      .map((insert) => ({ offset: insert.offset, length: insert.text.length })),
  };
}
