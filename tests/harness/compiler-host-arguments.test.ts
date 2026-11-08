import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

/* The compiler compiles itself, and in that build a class instance handed
 * over where another type is declared (an interface the class "satisfies", a
 * record type, a Pick of a context type) is converted to a dynamic value.
 * For the Lowerer that one conversion puts the Lowerer and every class its
 * fields reach in the dynamic tier: about 9,000 functions, 6% of the
 * compiler's own build. It happened three times in five days, each time
 * through one helper's parameter type (#2878, #3192, #2567), and nothing
 * failed.
 *
 * This reads the compiler's source without a type checker: a call that
 * passes a Lowerer (a parameter declared `Lowerer`, `this` inside the class,
 * or a `.lowerer` member) to a parameter whose declared type is neither
 * `Lowerer` nor an interface of data properties only. A data-only interface
 * (`KeyedNameOwner`: one Map) is a typed view of the class's fields and
 * costs nothing; a type with a method or a function-valued member is what
 * makes the conversion (`BindingScope`, `{ liftedFnNamed(name): … }`, a Pick
 * of the type mapper's context). Where a helper must not name the class,
 * give it what it reads: a record the Lowerer builds
 * (`lowerer.bindingScope()`, `lowerer.osConstantsCtx()`) or a function
 * (`(name) => lowerer.liftedFnNamed(name)`).
 *
 * What it does not see: a Lowerer assigned or returned into such a type, and
 * a call through a member whose declaration it cannot find by name. The
 * self-compile lines of a zero-cost gate round (functions of the dynamic
 * tier) remain the measurement; this is the check every pull request runs. */

const sourceRoot = fileURLToPath(new URL("../../packages/compiler/src", import.meta.url));

/** The classes that must be handed over as themselves. */
const HOSTS = new Set(["Lowerer"]);

/** A parameter type that takes the class as itself. */
const takesHost = (type: string): boolean => {
  const arms = type.split("|").map((arm) => arm.trim());
  return (
    arms.some((arm) => HOSTS.has(arm)) &&
    arms.every((arm) => HOSTS.has(arm) || arm === "undefined" || arm === "null")
  );
};

interface Params {
  /** Each parameter's declared type, null when it has none. */
  types: (ts.TypeNode | null)[];
  /** The last parameter is a rest parameter. */
  rest: boolean;
}

const written = (type: ts.TypeNode): string => type.getText().replace(/\s+/g, " ");

interface FileFacts {
  sf: ts.SourceFile;
  /** Functions and classes this file declares at its top level, by name. */
  declared: Map<string, Params>;
  /** Imported names: the file they come from and their name there. */
  imported: Map<string, { from: string; name: string }>;
  /** `export { name } from "./file.js"`: where a re-exported name lives. */
  forwarded: Map<string, { from: string; name: string }>;
}

function paramsOf(parameters: readonly ts.ParameterDeclaration[]): Params {
  return {
    types: parameters.map((p) => p.type ?? null),
    rest: parameters.at(-1)?.dotDotDotToken !== undefined,
  };
}

function functionLike(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
      out.push(path);
  }
  return out;
}

function handedOver(root: string): string[] {
  const files = new Map<string, FileFacts>();
  /** Methods and function-valued members of every class and object, by name. */
  const members = new Map<string, Params[]>();
  const member = (name: string, params: Params): void => {
    const list = members.get(name);
    if (list) list.push(params);
    else members.set(name, [params]);
  };
  /** Interfaces and type aliases of the compiler's source, by name. */
  const interfaces = new Map<string, ts.InterfaceDeclaration[]>();
  const aliases = new Map<string, ts.TypeNode[]>();
  const target = (file: string, specifier: string): string =>
    resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));

  for (const path of sourceFiles(root)) {
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const facts: FileFacts = { sf, declared: new Map(), imported: new Map(), forwarded: new Map() };
    files.set(path, facts);
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        facts.declared.set(statement.name.text, paramsOf(statement.parameters));
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        const ctor = statement.members.find(ts.isConstructorDeclaration);
        facts.declared.set(statement.name.text, paramsOf(ctor?.parameters ?? []));
      } else if (ts.isVariableStatement(statement)) {
        for (const d of statement.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && functionLike(d.initializer)) {
            facts.declared.set(d.name.text, paramsOf(d.initializer.parameters));
          }
        }
      } else if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier.text;
        const named = statement.importClause?.namedBindings;
        if (specifier.startsWith(".") && named && ts.isNamedImports(named)) {
          for (const e of named.elements) {
            facts.imported.set(e.name.text, {
              from: target(path, specifier),
              name: (e.propertyName ?? e.name).text,
            });
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const e of statement.exportClause.elements) {
          facts.forwarded.set(e.name.text, {
            from: target(path, statement.moduleSpecifier.text),
            name: (e.propertyName ?? e.name).text,
          });
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        const list = interfaces.get(node.name.text);
        if (list) list.push(node);
        else interfaces.set(node.name.text, [node]);
      } else if (ts.isTypeAliasDeclaration(node) && node.typeParameters === undefined) {
        const list = aliases.get(node.name.text);
        if (list) list.push(node.type);
        else aliases.set(node.name.text, [node.type]);
      }
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        member(node.name.text, paramsOf(node.parameters));
      } else if (
        (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) &&
        ts.isIdentifier(node.name) &&
        functionLike(node.initializer)
      ) {
        member(node.name.text, paramsOf(node.initializer.parameters));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /** The declaration a name used in `file` refers to, through imports and re-exports. */
  const declaration = (file: string, name: string, depth = 0): Params | undefined => {
    const facts = files.get(file);
    if (!facts || depth > 8) return undefined;
    const own = facts.declared.get(name);
    if (own) return own;
    const next = facts.imported.get(name) ?? facts.forwarded.get(name);
    return next ? declaration(next.from, next.name, depth + 1) : undefined;
  };

  /** Whether a type is a function type, as written or through an alias. */
  const isFunctionType = (type: ts.TypeNode, depth = 0): boolean => {
    if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) return true;
    if (ts.isParenthesizedTypeNode(type)) return isFunctionType(type.type, depth);
    if (ts.isUnionTypeNode(type)) return type.types.some((arm) => isFunctionType(arm, depth));
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && depth < 4) {
      return (aliases.get(type.typeName.text) ?? []).some((a) => isFunctionType(a, depth + 1));
    }
    return false;
  };
  /** Whether every member is a data property: no method, no function-valued
   * property, no call or index signature. */
  const dataMembers = (members: readonly ts.TypeElement[]): boolean =>
    members.every(
      (m) => ts.isPropertySignature(m) && m.type !== undefined && !isFunctionType(m.type),
    );
  /** Whether a declared type is a view of data properties only: a type
   * literal, or an interface or alias of the compiler's source (with what
   * it extends), found by name. */
  const dataOnly = (type: ts.TypeNode, depth = 0): boolean => {
    if (depth > 6) return false;
    if (ts.isTypeLiteralNode(type)) return dataMembers(type.members);
    if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeArguments) {
      return false;
    }
    const name = type.typeName.text;
    const declared = interfaces.get(name);
    if (declared) {
      return declared.every(
        (d) =>
          dataMembers(d.members) &&
          (d.heritageClauses ?? []).every((clause) =>
            clause.types.every(
              (base) =>
                ts.isIdentifier(base.expression) &&
                base.typeArguments === undefined &&
                (interfaces.get(base.expression.text) ?? []).length > 0 &&
                interfaces
                  .get(base.expression.text)!
                  .every((b) => dataMembers(b.members) && b.heritageClauses === undefined),
            ),
          ),
      );
    }
    const alias = aliases.get(name);
    return alias !== undefined && alias.every((a) => dataOnly(a, depth + 1));
  };
  /** Whether a parameter of this declared type may be given a host. */
  const accepts = (type: ts.TypeNode): boolean => takesHost(written(type)) || dataOnly(type);

  /** Whether `node` is, by what the source says, a value of a host class. */
  const isHost = (node: ts.Expression): boolean => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
        if (ts.isClassDeclaration(p)) return p.name !== undefined && HOSTS.has(p.name.text);
        // `this` of a function that is not a member of the class is not the class's.
        if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) return false;
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "lowerer";
    if (!ts.isIdentifier(node)) return false;
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (!ts.isFunctionLike(p)) continue;
      const param = p.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === node.text);
      if (param) return param.type !== undefined && takesHost(written(param.type));
    }
    return false;
  };

  const found: string[] = [];
  for (const [path, { sf }] of files) {
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
        const callee = node.expression;
        let name: string | undefined;
        let candidates: Params[] = [];
        if (ts.isIdentifier(callee)) {
          name = callee.text;
          const one = declaration(path, name);
          if (one) candidates = [one];
        } else if (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(node)) {
          name = callee.name.text;
          candidates = members.get(name) ?? [];
        }
        node.arguments.forEach((argument, index) => {
          if (name === undefined || candidates.length === 0 || !isHost(argument)) return;
          const declaredTypes = candidates
            .map((c) => c.types[index] ?? (c.rest ? c.types.at(-1) : undefined))
            .filter((type): type is ts.TypeNode => type !== undefined && type !== null);
          // A member is found by name only, so one declaration that takes the
          // class answers for the call; a function is found exactly.
          if (declaredTypes.length === 0 || declaredTypes.some(accepts)) return;
          const { line } = sf.getLineAndCharacterOfPosition(argument.getStart(sf));
          const where = relative(root, path).split("\\").join("/");
          found.push(`${where}:${line + 1} ${name}(#${index + 1}: ${written(declaredTypes[0]!)})`);
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found.sort();
}

test("a Lowerer is handed over only where the Lowerer class is declared", () => {
  // Calls that hand the Lowerer to another declared type on purpose, each
  // with the reason it does not make the Lowerer a dynamic value of the
  // compiler's own build. Give a new helper a record or a function instead
  // of adding to this list.
  const allowed: string[] = [];
  expect(handedOver(sourceRoot)).toEqual(allowed);
}, 120_000);
