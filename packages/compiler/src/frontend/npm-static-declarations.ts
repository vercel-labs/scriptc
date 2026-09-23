/* Declaration-overload projection for --npm-static. The runtime program
 * still resolves to and compiles package JavaScript, but an authored .d.ts
 * can carry overloads inference cannot reproduce (the common getter/setter
 * shape `name(): string` / `name(value): this`). This string-bounded
 * TypeScript 5 parser island extracts only complete, representation-safe
 * groups and respells them as JSDoc immediately before the matching
 * exported JavaScript class method. TypeScript 7 then checks and lowers one
 * world: implementation bodies remain the runtime truth, while overload
 * calls get the package author's more precise signature. */

import ts from "typescript5";

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

export type NpmStaticDeclarationProperties = ReadonlyMap<
  string,
  ReadonlyMap<string, string>
>;

export interface NpmStaticOverloadRewrite {
  text: string;
  insertions: readonly { offset: number; length: number }[];
}

/** A JavaScript return annotation cannot make Array.find return a value
 * when no element matches. Widen only direct finds on constructor-owned
 * arrays; arbitrary methods also named find are left alone. */
export function applyNpmStaticFindReturnWidening(
  sourcePath: string,
  source: string,
): NpmStaticOverloadRewrite | null {
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const insertions: { offset: number; length: number }[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const constructor = statement.members.find(
      (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    if (constructor?.body === undefined) continue;
    const arrayFields = new Set<string>();
    for (const bodyStatement of constructor.body.statements) {
      if (!ts.isExpressionStatement(bodyStatement) || !ts.isBinaryExpression(bodyStatement.expression)) continue;
      const { left, right, operatorToken } = bodyStatement.expression;
      if (
        operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isArrayLiteralExpression(right)
      ) arrayFields.add(left.name.text);
    }
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || member.body?.statements.length !== 1) continue;
      const returned = member.body.statements[0];
      if (!returned || !ts.isReturnStatement(returned) || returned.expression === undefined || !ts.isCallExpression(returned.expression)) continue;
      const callee = returned.expression.expression;
      if (
        !ts.isPropertyAccessExpression(callee) || callee.name.text !== "find" ||
        !ts.isPropertyAccessExpression(callee.expression) ||
        callee.expression.expression.kind !== ts.SyntaxKind.ThisKeyword ||
        !arrayFields.has(callee.expression.name.text)
      ) continue;
      const returnType = ts.getJSDocReturnType(member);
      if (
        returnType === undefined || !ts.isTypeReferenceNode(returnType) ||
        !ts.isIdentifier(returnType.typeName) || (returnType.typeArguments?.length ?? 0) !== 0
      ) continue;
      insertions.push({ offset: returnType.getEnd(), length: " | undefined".length });
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function safeTypeText(node: ts.TypeNode, sourceFile: ts.SourceFile, className: string): string | null {
  if (SAFE_KEYWORD_TYPES.has(node.kind) || ts.isThisTypeNode(node)) return node.getText(sourceFile);
  if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isParenthesizedTypeNode(node)) {
    const inner = safeTypeText(node.type, sourceFile, className);
    return inner === null ? null : `(${inner})`;
  }
  if (ts.isArrayTypeNode(node)) {
    const element = safeTypeText(node.elementType, sourceFile, className);
    return element === null ? null : `${element}[]`;
  }
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return safeTypeText(node.type, sourceFile, className);
  }
  if (ts.isUnionTypeNode(node)) {
    const arms = node.types.map((type) => safeTypeText(type, sourceFile, className));
    return arms.some((arm) => arm === null) ? null : arms.join(" | ");
  }
  if (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === "Record" &&
    node.typeArguments?.length === 2 &&
    node.typeArguments[0]?.kind === ts.SyntaxKind.StringKeyword &&
    node.typeArguments[1]?.kind === ts.SyntaxKind.StringKeyword
  ) {
    return "Record<string, string>";
  }
  return ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === className &&
    (node.typeArguments?.length ?? 0) === 0
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
    (method.typeParameters?.length ?? 0) !== 0 ||
    hasModifier(method, ts.SyntaxKind.StaticKeyword) ||
    hasModifier(method, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(method, ts.SyntaxKind.ProtectedKeyword)
  ) {
    return null;
  }
  const returnType = safeTypeText(method.type, sourceFile, className);
  if (returnType === null) return null;
  const parameters: NpmStaticOverloadParameter[] = [];
  for (const parameter of method.parameters) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.name.text === "this" ||
      parameter.type === undefined ||
      parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined
    ) {
      return null;
    }
    const type = safeTypeText(parameter.type, sourceFile, className);
    if (type === null) return null;
    parameters.push({
      name: parameter.name.text,
      type,
      optional: parameter.questionToken !== undefined,
    });
  }
  return { parameters, returnType };
}

/** Extracts complete safe overload groups from exported non-generic classes. */
export function parseNpmStaticDeclarationOverloads(
  declarationPath: string,
  source: string,
): NpmStaticDeclarationOverloads {
  const sourceFile = ts.createSourceFile(declarationPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = new Map<string, ReadonlyMap<string, readonly NpmStaticOverloadSignature[]>>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isClassDeclaration(statement) ||
      statement.name === undefined ||
      (statement.typeParameters?.length ?? 0) !== 0 ||
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      continue;
    }
    const className = statement.name.text;
    const groups = new Map<string, ts.MethodDeclaration[]>();
    for (const member of statement.members) {
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
      if (signatures.length === 1 && !signatures[0]!.parameters.some((parameter) => parameter.optional)) continue;
      overloads.set(name, signatures as NpmStaticOverloadSignature[]);
    }
    if (overloads.size > 0) classes.set(className, overloads);
  }
  return classes;
}

function nullableSelfType(
  node: ts.TypeNode,
  sourceFile: ts.SourceFile,
  className: string,
): string | null {
  if (!ts.isUnionTypeNode(node) || node.types.length !== 2) return null;
  const arms = node.types.map((type) => safeTypeText(type, sourceFile, className));
  return arms.includes(className) && arms.includes("null") ? `${className} | null` : null;
}

/** Extracts the first declaration-backed field slice: nullable self links. */
export function parseNpmStaticDeclarationProperties(
  declarationPath: string,
  source: string,
): NpmStaticDeclarationProperties {
  const sourceFile = ts.createSourceFile(declarationPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = new Map<string, ReadonlyMap<string, string>>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isClassDeclaration(statement) ||
      statement.name === undefined ||
      (statement.typeParameters?.length ?? 0) !== 0 ||
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      continue;
    }
    const className = statement.name.text;
    const properties = new Map<string, string>();
    for (const member of statement.members) {
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
      const type = nullableSelfType(member.type, sourceFile, className);
      if (type !== null) properties.set(member.name.text, type);
    }
    if (properties.size > 0) classes.set(className, properties);
  }
  return classes;
}

/** Relative declaration-barrel edges whose target stays subject to the
 * caller's package-bounded resolution. Bare type dependencies deliberately
 * do not inherit the opted package's declaration trust. */
export function npmStaticDeclarationReexports(
  declarationPath: string,
  source: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(declarationPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sourceFile.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text.startsWith(".")
      ? [statement.moduleSpecifier.text]
      : []
  );
}

function requireSpecifier(expression: ts.Expression | undefined): string | null {
  const argument = expression !== undefined && ts.isCallExpression(expression) ? expression.arguments[0] : undefined;
  return expression !== undefined &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.arguments.length === 1 &&
    argument !== undefined &&
    ts.isStringLiteralLike(argument)
    ? argument.text
    : null;
}

/** Maps declaration class names to their implementation edge from one
 * runtime package entry. Null means the class is declared in the entry;
 * a string is a relative re-export target. Multi-hop and aliased class
 * re-exports stay out of the first safe slice. */
export function npmStaticRuntimeClassTargets(
  sourcePath: string,
  source: string,
  classNames: ReadonlySet<string>,
): ReadonlyMap<string, string | null> {
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const localClasses = new Set(
    sourceFile.statements.flatMap((statement) =>
      ts.isClassDeclaration(statement) && statement.name !== undefined ? [statement.name.text] : []
    ),
  );
  const linked = new Map<string, { imported: string; specifier: string }>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const specifier = requireSpecifier(declaration.initializer);
        if (specifier === null || !specifier.startsWith(".") || !ts.isObjectBindingPattern(declaration.name)) continue;
        for (const element of declaration.name.elements) {
          if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
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
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        linked.set(element.name.text, {
          imported: element.propertyName?.text ?? element.name.text,
          specifier: statement.moduleSpecifier.text,
        });
      }
    }
  }
  const targets = new Map<string, string | null>();
  const record = (exported: string, local: string, specifier?: string): void => {
    if (!classNames.has(exported) || exported !== local || targets.has(exported)) return;
    if (specifier !== undefined) {
      targets.set(exported, specifier);
      return;
    }
    const imported = linked.get(local);
    if (imported !== undefined && imported.imported === exported) targets.set(exported, imported.specifier);
    else if (localClasses.has(local)) targets.set(exported, null);
  };
  for (const statement of sourceFile.statements) {
    if (
      ts.isClassDeclaration(statement) &&
      statement.name !== undefined &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      record(statement.name.text, statement.name.text);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      const specifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      if (specifier !== undefined && !specifier.startsWith(".")) continue;
      for (const element of statement.exportClause.elements) {
        record(element.name.text, element.propertyName?.text ?? element.name.text, specifier);
      }
      continue;
    }
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
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
      for (const property of right.properties) {
        if (ts.isShorthandPropertyAssignment(property)) record(property.name.text, property.name.text);
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
  for (const statement of sourceFile.statements) {
    if (
      ts.isClassDeclaration(statement) &&
      statement.name !== undefined &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      names.add(statement.name.text);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.propertyName?.text ?? element.name.text);
      continue;
    }
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
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
      for (const property of right.properties) {
        if (ts.isShorthandPropertyAssignment(property)) names.add(property.name.text);
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
  const params = signature.parameters.map((parameter) =>
    `@param {${parameter.type}} ${parameter.optional ? `[${parameter.name}]` : parameter.name}`
  );
  return `/** @overload ${params.join(" ")} @returns {${signature.returnType}} */`;
}

function implementationComment(
  className: string,
  method: ts.MethodDeclaration,
  signatures: readonly NpmStaticOverloadSignature[],
): string | null {
  if (method.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken !== undefined)) return null;
  const maxParams = Math.max(...signatures.map((signature) => signature.parameters.length));
  if (method.parameters.length !== maxParams) return null;
  const params: string[] = [];
  for (let index = 0; index < maxParams; index++) {
    const types = [...new Set(signatures.flatMap((signature) => signature.parameters[index]?.type ?? []))];
    if (types.length === 0) return null;
    const parameter = method.parameters[index];
    if (parameter === undefined || !ts.isIdentifier(parameter.name)) return null;
    const name = parameter.name.text;
    const optional = signatures.some((signature) => {
      const candidate = signature.parameters[index];
      return candidate === undefined || candidate.optional;
    });
    params.push(`@param {${types.join(" | ")}} ${optional ? `[${name}]` : name}`);
  }
  const returns = [...new Set(signatures.map((signature) =>
    signature.returnType.replace(/\bthis\b/g, className)
  ))];
  return `/** ${params.join(" ")} @returns {${returns.join(" | ")}} */`;
}

function directReturn(statement: ts.Statement): ts.ReturnStatement | null {
  if (ts.isReturnStatement(statement)) return statement;
  return ts.isBlock(statement) && statement.statements.length === 1 && ts.isReturnStatement(statement.statements[0]!)
    ? statement.statements[0]!
    : null;
}

function undefinedParameterTest(expression: ts.Expression, parameter: string): boolean {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  const matches = (left: ts.Expression, right: ts.Expression): boolean =>
    ts.isIdentifier(left) && left.text === parameter && ts.isIdentifier(right) && right.text === "undefined";
  return matches(expression.left, expression.right) || matches(expression.right, expression.left);
}

function overloadArrayBackingField(
  method: ts.MethodDeclaration,
  signatures: readonly NpmStaticOverloadSignature[],
): { field: string; type: string } | null {
  if (method.body === undefined || method.parameters.length !== 1 || !ts.isIdentifier(method.parameters[0]!.name)) return null;
  const getters = signatures.filter((signature) => signature.parameters.length === 0 && signature.returnType.endsWith("[]"));
  if (getters.length !== 1) return null;
  const parameter = method.parameters[0]!.name.text;
  for (const statement of method.body.statements) {
    if (!ts.isIfStatement(statement) || !undefinedParameterTest(statement.expression, parameter)) continue;
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
  sourcePath: string,
  source: string,
  declarations: NpmStaticDeclarationOverloads,
): NpmStaticOverloadRewrite | null {
  if (declarations.size === 0) return null;
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const exported = exportedClassNames(sourceFile);
  const inserts: { offset: number; text: string }[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined || !exported.has(statement.name.text)) continue;
    const classOverloads = declarations.get(statement.name.text);
    if (classOverloads === undefined) continue;
    const constructor = statement.members.find(
      (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    const projectedFields = new Set<string>();
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name) || member.body === undefined) continue;
      const signatures = classOverloads.get(member.name.text);
      if (signatures === undefined) continue;
      const backing = overloadArrayBackingField(member, signatures);
      if (backing !== null && constructor?.body !== undefined && !projectedFields.has(backing.field)) {
        for (const bodyStatement of constructor.body.statements) {
          if (!ts.isExpressionStatement(bodyStatement) || !ts.isBinaryExpression(bodyStatement.expression)) continue;
          const { left, right, operatorToken } = bodyStatement.expression;
          if (
            operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isArrayLiteralExpression(right) || right.elements.length !== 0 ||
            !ts.isPropertyAccessExpression(left) ||
            left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
            left.name.text !== backing.field
          ) {
            continue;
          }
          const leading = source.slice(bodyStatement.getFullStart(), bodyStatement.getStart(sourceFile));
          if (!leading.includes("@type")) {
            inserts.push({ offset: bodyStatement.getStart(sourceFile), text: `/** @type {${backing.type}} */ ` });
          }
          projectedFields.add(backing.field);
          break;
        }
      }
      const jsDocs = (member as ts.MethodDeclaration & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? [];
      if (jsDocs.some((doc) => source.slice(doc.pos, doc.end).includes("@overload"))) continue;
      if (signatures.length === 1) {
        const implementation = implementationComment(statement.name.text, member, signatures);
        if (implementation !== null) {
          const existing = jsDocs.map((doc) => source.slice(doc.pos, doc.end)).join("\n");
          const missingOptional = signatures[0]!.parameters.some(
            (parameter) => parameter.optional && !existing.includes(`[${parameter.name}]`),
          );
          if (missingOptional) inserts.push({ offset: member.getStart(sourceFile), text: `${implementation} ` });
        }
        continue;
      }
      const implementation = jsDocs.length === 0 ? implementationComment(statement.name.text, member, signatures) : null;
      if (jsDocs.length === 0 && implementation === null) continue;
      const offset = jsDocs[0]?.getStart(sourceFile) ?? member.getStart(sourceFile);
      const text = `${signatures.map(overloadComment).join(" ")} ${implementation === null ? "" : implementation + " "}`;
      inserts.push({ offset, text });
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

/** Injects nullable-self property JSDoc at matching constructor writes. */
export function applyNpmStaticDeclarationProperties(
  sourcePath: string,
  source: string,
  declarations: NpmStaticDeclarationProperties,
): NpmStaticOverloadRewrite | null {
  if (declarations.size === 0) return null;
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const exported = exportedClassNames(sourceFile);
  const inserts: { offset: number; text: string }[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined || !exported.has(statement.name.text)) continue;
    const properties = declarations.get(statement.name.text);
    if (properties === undefined) continue;
    const constructor = statement.members.find(
      (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined,
    );
    if (constructor?.body === undefined) continue;
    for (const bodyStatement of constructor.body.statements) {
      if (!ts.isExpressionStatement(bodyStatement) || !ts.isBinaryExpression(bodyStatement.expression)) continue;
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
      const leading = source.slice(bodyStatement.getFullStart(), bodyStatement.getStart(sourceFile));
      if (leading.includes("@type")) continue;
      inserts.push({ offset: bodyStatement.getStart(sourceFile), text: `/** @type {${type}} */ ` });
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
