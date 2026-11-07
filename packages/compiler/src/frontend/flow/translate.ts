/* Flow → TypeScript translation of one module (flow/index.ts serves the
 * result in place of the Flow file).
 *
 * Most Flow syntax is already TypeScript, so the translation edits the
 * source in place: every type is reprinted in TypeScript's spelling (a
 * type's own comments and line breaks are not kept), and the few other
 * constructs that differ are rewritten: casts, opaque types, variance
 * sigils, predicate functions (dropped), unannotated parameters, functions
 * that read `arguments` (a variadic overload), and the project's constants.
 * Where Flow infers more than TypeScript, an annotation says so: tuples
 * from array literals of references, and module bindings only assigned one
 * class. Everything else, comments and formatting included, is copied. The
 * result maps its offsets back to the Flow source, which runtime fence
 * messages name (flow/index.ts fenceLocation).
 *
 * Flow's `mixed` and `any` both become `unknown`, scriptc's checked-dynamic
 * value: an `any` that only silences Flow (`(x: any)`, `({...}: any)`) keeps
 * the operand's own type, or the destination's for a literal, instead. A
 * type a project declares dynamic (FlowOptions.dynamicTypes) is `unknown`
 * too, and one it corrects (FlowOptions.types) is the type it names. */
import { applySourceEdits, type EditedSource, type SourceEdit } from "../source-edits.js";

/** A node of hermes-parser's ESTree AST. */
export interface FlowNode {
  type: string;
  range: [number, number];
  [key: string]: unknown;
}

export interface FlowTranslateOptions {
  /** Type names (aliases, interfaces, generic references) and the
   * TypeScript type each translates to: `unknown` for values a project
   * keeps checked-dynamic, or the type a Flow type really is. */
  types?: ReadonlyMap<string, string>;
  /** Compile-time constants (`scriptc.constants`, a build's `__DEV__`):
   * references become the value, and the `if` branches and `?:` arms their
   * value decides never reach the program. */
  constants?: ReadonlyMap<string, boolean | number | string | null>;
  /** The module holds JSX and is presented as `.tsx`: a generic arrow
   * function's type parameters are written `<T,>`, which TSX parses. */
  jsx?: boolean;
}

export class FlowTranslateError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

/** Flow library and escape-hatch type names that translate to `unknown`
 * (FlowTranslator.generic). */
const UNKNOWN_BUILTINS = new Set([
  "Function",
  "Object",
  "$FlowFixMe",
  "$FlowIssue",
  "$FlowExpectedError",
  "$FlowIgnore",
]);

/** Flow's type-level operators with no TypeScript counterpart here. */
const UNSUPPORTED_UTILITIES = new Set([
  "$Call",
  "$CharSet",
  "$Compose",
  "$ComposeReverse",
  "$Exports",
  "$KeyMirror",
  "$ObjMap",
  "$ObjMapConst",
  "$ObjMapi",
  "$Pred",
  "$Refine",
  "$Rest",
  "$Subtype",
  "$Supertype",
  "$TupleMap",
]);

const node = (value: unknown): FlowNode | null =>
  value !== null && typeof value === "object" && typeof (value as FlowNode).type === "string"
    ? (value as FlowNode)
    : null;
/** The nodes of a list. An array literal or pattern elision (`[a, , b]`)
 * arrives as a null element, which is not a node. */
const nodes = (value: unknown): FlowNode[] =>
  Array.isArray(value) ? value.filter((v): v is FlowNode => node(v) !== null) : [];

/** Type nodes the printer handles (a node of one of these kinds is printed
 * whole; its children are not visited separately). */
/** The library declarations without a translation, as Flow writes them. */
const DECLARATION_NAMES: Record<string, string> = {
  DeclareClass: "declare class",
  DeclareModule: "declare module",
  DeclareModuleExports: "declare module.exports",
  DeclareExportAllDeclaration: "declare export *",
};

/** Expressions a TypeScript `as` can follow without parentheses. */
const PRIMARY_KINDS = new Set([
  "Identifier",
  "Literal",
  "ThisExpression",
  "Super",
  "MemberExpression",
  "OptionalMemberExpression",
  "CallExpression",
  "OptionalCallExpression",
  "ArrayExpression",
  "ObjectExpression",
  "TemplateLiteral",
  "TaggedTemplateExpression",
  "TypeCastExpression",
]);

const TYPE_KINDS = new Set([
  "AnyTypeAnnotation",
  "MixedTypeAnnotation",
  "EmptyTypeAnnotation",
  "VoidTypeAnnotation",
  "NullLiteralTypeAnnotation",
  "NumberTypeAnnotation",
  "StringTypeAnnotation",
  "BooleanTypeAnnotation",
  "SymbolTypeAnnotation",
  "BigIntTypeAnnotation",
  "ExistsTypeAnnotation",
  "StringLiteralTypeAnnotation",
  "NumberLiteralTypeAnnotation",
  "BooleanLiteralTypeAnnotation",
  "BigIntLiteralTypeAnnotation",
  "NullableTypeAnnotation",
  "UnionTypeAnnotation",
  "IntersectionTypeAnnotation",
  "ArrayTypeAnnotation",
  "TupleTypeAnnotation",
  "GenericTypeAnnotation",
  "ObjectTypeAnnotation",
  "FunctionTypeAnnotation",
  "TypeofTypeAnnotation",
  "IndexedAccessType",
  "OptionalIndexedAccessType",
  "KeyofTypeAnnotation",
  "ConditionalTypeAnnotation",
  "InferTypeAnnotation",
  "TypeOperator",
  "InterfaceTypeAnnotation",
  "TypePredicate",
  "ComponentTypeAnnotation",
  "HookTypeAnnotation",
]);

export function translateFlow(
  source: string,
  program: FlowNode,
  options: FlowTranslateOptions = {},
): EditedSource {
  const t = new FlowTranslator(source, options);
  linkParents(program);
  t.findUniqueSymbols(program);
  t.findConstructedBindings(program);
  t.findDeclaredConstants(program);
  t.visit(program);
  // Flow is the checker of record for its modules: TypeScript computes and
  // uses their types but reports none of its own rules' errors against them
  // (Flow refines and widens differently). scriptc's lowering still enforces
  // what it needs to compile each value.
  // First among the insertions at its offset, which keep their order: the
  // start of the module, or after a `#!` line, which must stay first.
  const header = "// @ts-nocheck: a Flow module, checked by Flow.\n";
  const eol = source.startsWith("#!") ? source.indexOf("\n") : -1;
  if (source.startsWith("#!") && eol < 0)
    t.edits.unshift({ start: source.length, end: source.length, text: `\n${header}` });
  else t.edits.unshift({ start: eol + 1, end: eol + 1, text: header });
  return applySourceEdits(source, t.edits);
}

/** A part of an object type: a run of members with the keys it overrides,
 * a spread (whose type can be a union, so it overrides per arm), or a tail
 * of indexers, records and call signatures, which overrides nothing. */
interface ObjectPart {
  text: string;
  /** The keys a run of members overrides; null for a spread or a tail. */
  keys: string | null;
  spread: boolean;
}

/** Sets each node's `parent` (hermes-parser leaves it unset), which scope
 * lookups and a function's `export` wrapper are found through. */
function linkParents(n: FlowNode): void {
  for (const [key, value] of Object.entries(n)) {
    if (key === "parent" || key === "range" || key === "loc") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      const c = node(child);
      if (c === null) continue;
      c.parent = n;
      linkParents(c);
    }
  }
}

class FlowTranslator {
  readonly edits: SourceEdit[] = [];
  private readonly types: ReadonlyMap<string, string>;
  /** A type corrected to `unique symbol`, and the module constant whose
   * symbol it is (`const KEY: Key = Symbol.for(…)`). */
  private readonly uniqueSymbols = new Map<string, string>();
  /** The declarator of each such constant: the one that becomes
   * `unique symbol` (any other binding of the type keeps the alias). */
  private readonly uniqueSymbolDeclarators = new Map<string, FlowNode>();
  /** Module `let x = null` bindings the module only assigns `new C(...)`
   * (or null): the class each holds (findConstructedBindings). */
  private readonly constructed = new Map<FlowNode, string>();
  /** The functions enclosing the node being visited. */
  private readonly functions: FlowNode[] = [];
  private readonly constants: ReadonlyMap<string, boolean | number | string | null>;
  /** The scopes (a function, block, catch clause, class or the module) that
   * declare a binding of a constant's name: within them the name is not
   * the build constant, so the module keeps it as written. */
  private readonly shadowingScopes = new Map<string, Set<FlowNode>>();
  /** Where an expression statement in a statement list starts: a rewrite
   * there that begins with `(` gets a `;` so it cannot continue the
   * previous line. (A statement that is a whole `if` or loop body has no
   * previous line to continue, and a `;` there would end the body.) */
  private readonly statementStarts = new Set<number>();
  /** The kinds of the variable declarations being visited. */
  private readonly declarationKinds: string[] = [];
  /** Setter functions: their parameter is required. */
  private readonly setters = new Set<FlowNode>();
  /** Type parameters of generic arrow functions, written `<T,>` in TSX. */
  private readonly arrowTypeParameters = new Set<FlowNode>();
  private readonly jsx: boolean;
  /** The type variable a distributive spread binds: a name the module
   * never spells, so it captures none of the module's own types. Each
   * nesting level takes its own. */
  private binder(level: number): string {
    if (this.binderName === undefined) {
      let name = "Spread_";
      while (this.source.includes(name)) name += "_";
      this.binderName = name;
    }
    return this.binderName + "_".repeat(level);
  }
  private binderName: string | undefined;

  constructor(
    private readonly source: string,
    options: FlowTranslateOptions,
  ) {
    this.types = options.types ?? new Map();
    this.constants = options.constants ?? new Map();
    this.jsx = options.jsx === true;
  }

  /** The scopes that declare a binding of a constant's name: a variable
   * (`var` in its function, `let`, `const` and a function or class
   * declaration in their block), a parameter, a function or class
   * expression's own name, a catch binding or an import. A `declare var`
   * only describes the global and declares nothing. */
  findDeclaredConstants(program: FlowNode): void {
    if (this.constants.size === 0) return;
    const scopes: FlowNode[] = [];
    const declare = (names: string[], scope: FlowNode | undefined): void => {
      for (const name of names) {
        if (!this.constants.has(name) || scope === undefined) continue;
        let set = this.shadowingScopes.get(name);
        if (set === undefined) this.shadowingScopes.set(name, (set = new Set()));
        set.add(scope);
      }
    };
    const functionScope = (): FlowNode | undefined =>
      [...scopes]
        .reverse()
        .find(
          (s) =>
            s.type === "Program" ||
            s.type === "FunctionDeclaration" ||
            s.type === "FunctionExpression" ||
            s.type === "ArrowFunctionExpression",
        );
    const visit = (n: FlowNode | null, kind?: string): void => {
      if (n === null || n.type.startsWith("Declare")) return;
      if (n.type === "VariableDeclaration") kind = n.kind as string;
      if (n.type === "VariableDeclarator") {
        const names: string[] = [];
        this.patternNames(node(n.id)!, names);
        declare(names, kind === "var" ? functionScope() : scopes[scopes.length - 1]);
      }
      if (n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") {
        const id = node(n.id);
        if (id !== null) declare([id.name as string], scopes[scopes.length - 1]);
      }
      if (
        n.type === "ImportSpecifier" ||
        n.type === "ImportDefaultSpecifier" ||
        n.type === "ImportNamespaceSpecifier"
      )
        declare([node(n.local)!.name as string], scopes[0]);
      const scope =
        n.type === "Program" ||
        n.type === "BlockStatement" ||
        n.type === "StaticBlock" ||
        n.type === "SwitchStatement" ||
        n.type === "ForStatement" ||
        n.type === "ForInStatement" ||
        n.type === "ForOfStatement" ||
        n.type === "CatchClause" ||
        n.type === "ClassExpression" ||
        n.type === "FunctionDeclaration" ||
        n.type === "FunctionExpression" ||
        n.type === "ArrowFunctionExpression";
      if (scope) scopes.push(n);
      if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
        const id = node(n.id);
        if (id !== null) declare([id.name as string], n);
      }
      if (n.type === "ClassExpression" && node(n.id) !== null)
        declare([node(n.id)!.name as string], n);
      if (n.type.startsWith("Function") || n.type === "ArrowFunctionExpression") {
        const names: string[] = [];
        for (const param of nodes(n.params)) this.patternNames(param, names);
        declare(names, n);
      }
      if (n.type === "CatchClause" && node(n.param) !== null) {
        const names: string[] = [];
        this.patternNames(node(n.param)!, names);
        declare(names, n);
      }
      for (const [key, value] of Object.entries(n)) {
        if (key === "parent" || key === "range" || key === "loc") continue;
        // A declarator's kind reaches its own patterns, not nested ones.
        const inner = n.type === "VariableDeclaration" ? kind : undefined;
        for (const child of Array.isArray(value) ? value : [value]) visit(node(child), inner);
      }
      if (scope) scopes.pop();
    };
    visit(program);
  }

  /** Whether the identifier `n` names a build constant: a constant's name
   * that no enclosing scope declares a binding of. */
  private isConstant(n: FlowNode): boolean {
    const name = n.name as string;
    if (!this.constants.has(name)) return false;
    const scopes = this.shadowingScopes.get(name);
    if (scopes === undefined) return true;
    for (let p = node(n.parent); p !== null; p = node(p.parent)) if (scopes.has(p)) return false;
    return true;
  }

  /** A constant's value as source text: numbers in parentheses, so a
   * member read or a unary operator applies to the whole value. */
  private constantText(name: string): string {
    // Asked only for a configured constant's name.
    const value = this.constants.get(name)!;
    return typeof value === "number" ? `(${JSON.stringify(value)})` : JSON.stringify(value);
  }

  /** The module constants declared with a type the project corrects to
   * `unique symbol`: the type is that constant's symbol, which equality
   * refines out of a union, as Flow refines the literal it stands for. */
  findUniqueSymbols(program: FlowNode): void {
    for (const statement of nodes(program.body)) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? node(statement.declaration) : statement;
      if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
      for (const declarator of nodes(declaration.declarations)) {
        const name = this.uniqueSymbolType(declarator);
        if (name !== null) {
          this.uniqueSymbols.set(name, node(declarator.id)!.name as string);
          this.uniqueSymbolDeclarators.set(name, declarator);
        }
      }
    }
  }

  /** Flow types an unannotated binding by the values written to it, where
   * TypeScript says `any`: a module `let x = null` whose every assignment
   * (anywhere in the module, by name) is `new C(...)` or `null` holds
   * `C | null`. */
  findConstructedBindings(program: FlowNode): void {
    const candidates = new Map<string, FlowNode>();
    for (const statement of nodes(program.body)) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? node(statement.declaration) : statement;
      if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "let") continue;
      for (const declarator of nodes(declaration.declarations)) {
        const id = node(declarator.id);
        const init = node(declarator.init);
        if (
          id?.type === "Identifier" &&
          node(id.typeAnnotation) === null &&
          init?.type === "Literal" &&
          init.value === null
        )
          candidates.set(id.name as string, declarator);
      }
    }
    if (candidates.size === 0) return;
    const classes = new Map<string, string | null>();
    const visit = (n: FlowNode | null): void => {
      if (n === null) return;
      if (n.type === "AssignmentExpression") {
        const left = node(n.left);
        const name = left?.type === "Identifier" ? (left.name as string) : null;
        if (name !== null && candidates.has(name)) {
          const right = node(n.right);
          const callee = right?.type === "NewExpression" ? node(right.callee) : null;
          const typeArgs = right?.type === "NewExpression" ? node(right.typeArguments) : null;
          const written =
            n.operator === "=" && callee?.type === "Identifier"
              ? (callee.name as string) +
                (typeArgs === null
                  ? ""
                  : `<${nodes(typeArgs.params)
                      .map((p) => this.type(p))
                      .join(", ")}>`)
              : n.operator === "=" && right?.type === "Literal" && right.value === null
                ? undefined
                : null;
          if (written === null) classes.set(name, null);
          else if (written !== undefined) {
            const known = classes.get(name);
            classes.set(name, known === undefined || known === written ? written : null);
          }
        }
      } else if (n.type === "UpdateExpression") {
        const argument = node(n.argument);
        if (argument?.type === "Identifier" && candidates.has(argument.name as string))
          classes.set(argument.name as string, null);
      }
      // Destructuring and loop heads write values of any class.
      const pattern =
        n.type === "AssignmentExpression"
          ? node(n.left)
          : n.type === "ForOfStatement" || n.type === "ForInStatement"
            ? node(n.left)
            : null;
      if (pattern !== null && pattern.type !== "MemberExpression") {
        const written: string[] = [];
        if (pattern.type !== "VariableDeclaration" && pattern.type !== "Identifier")
          this.patternNames(pattern, written);
        else if (pattern.type === "Identifier" && n.type !== "AssignmentExpression")
          written.push(pattern.name as string);
        for (const name of written) if (candidates.has(name)) classes.set(name, null);
      }
      for (const [key, value] of Object.entries(n)) {
        if (key === "parent" || key === "range" || key === "loc") continue;
        for (const child of Array.isArray(value) ? value : [value]) visit(node(child));
      }
    };
    visit(program);
    for (const [name, written] of classes)
      if (written) this.constructed.set(candidates.get(name)!, written);
  }

  /** The `unique symbol` type a declarator is annotated with, if any. */
  private uniqueSymbolType(declarator: FlowNode): string | null {
    const id = node(declarator.id);
    const annotation = id?.type === "Identifier" ? node(id.typeAnnotation) : null;
    const type =
      annotation?.type === "TypeAnnotation" ? node(annotation.typeAnnotation) : annotation;
    const target = type?.type === "GenericTypeAnnotation" ? node(type.id) : null;
    const name = target?.type === "Identifier" ? (target.name as string) : null;
    return name !== null && this.types.get(name) === "unique symbol" ? name : null;
  }

  /** The value a condition built from constants, literals, `!`, `&&`, `||`
   * and equality decides, or undefined. */
  private decided(n: FlowNode): unknown {
    switch (n.type) {
      case "Identifier":
        return this.isConstant(n) ? this.constants.get(n.name as string) : undefined;
      case "Literal":
        return n.value;
      case "UnaryExpression": {
        if (n.operator !== "!") return undefined;
        const v = this.decided(node(n.argument)!);
        return v === undefined ? undefined : !v;
      }
      case "LogicalExpression": {
        const l = this.decided(node(n.left)!);
        if (l === undefined) return undefined;
        if (n.operator === "&&") return l ? this.decided(node(n.right)!) : l;
        if (n.operator === "||") return l ? l : this.decided(node(n.right)!);
        return undefined;
      }
      case "BinaryExpression": {
        const l = this.decided(node(n.left)!);
        const r = this.decided(node(n.right)!);
        if (l === undefined || r === undefined) return undefined;
        if (n.operator === "===") return l === r;
        if (n.operator === "!==") return l !== r;
        // Loose equality converts between types; folded only where it
        // cannot (both sides of one type, or null against null).
        if (typeof l !== typeof r) return undefined;
        if (n.operator === "==") return l === r;
        if (n.operator === "!=") return l !== r;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /** The `var` names a dropped branch declares: they stay declared, holding
   * undefined, as the hoisted declarations would. */
  private varNames(n: FlowNode, out: string[] = []): string[] {
    if (n.type === "VariableDeclaration" && n.kind === "var")
      for (const d of nodes(n.declarations)) this.patternNames(node(d.id)!, out);
    if (n.type.startsWith("Function") || n.type === "ArrowFunctionExpression") return out;
    for (const [key, value] of Object.entries(n)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        const c = node(child);
        if (c !== null) this.varNames(c, out);
      }
    }
    return out;
  }

  private patternNames(p: FlowNode, out: string[]): void {
    if (p.type === "Identifier") out.push(p.name as string);
    else if (p.type === "ObjectPattern")
      for (const prop of nodes(p.properties))
        this.patternNames(node(prop.value ?? prop.argument)!, out);
    else if (p.type === "ArrayPattern")
      for (const e of nodes(p.elements)) this.patternNames(e, out);
    else if (p.type === "AssignmentPattern") this.patternNames(node(p.left)!, out);
    else if (p.type === "RestElement") this.patternNames(node(p.argument)!, out);
  }

  /** An `if` or `?:` whose condition a constant decides: the untaken part
   * is removed and the taken part kept in place. False when undecided. */
  private decide(n: FlowNode): boolean {
    if (this.constants.size === 0) return false;
    const taken = this.decided(node(n.test)!);
    if (taken === undefined) return false;
    const live = node(taken ? n.consequent : n.alternate);
    const dead = node(taken ? n.alternate : n.consequent);
    const [start, end] = n.range;
    if (n.type === "ConditionalExpression") {
      const open = this.statementStarts.has(start) ? ";(" : "(";
      this.edits.push({ start, end: live!.range[0], text: open });
      this.edits.push({ start: live!.range[1], end, text: ")" });
      this.visit(live!);
      return true;
    }
    const hoisted = dead === null ? [] : this.varNames(dead);
    const tail = hoisted.length > 0 ? ` var ${hoisted.join(", ")};` : "";
    if (live === null) {
      this.edits.push({ start, end, text: `;${tail}` });
      return true;
    }
    // A kept statement goes in braces, with the dropped branch's `var`
    // names: it may stand where one statement belongs (an outer `if` body,
    // before its `else`), and it cannot run into the previous line. A
    // block without such names stays as it is.
    const wrap = live.type !== "BlockStatement" || tail !== "";
    this.edits.push({ start, end: live.range[0], text: wrap ? "{ " : "" });
    this.edits.push({ start: live.range[1], end, text: wrap ? `${tail} }` : "" });
    this.visit(live);
    return true;
  }

  private replace(n: { range: [number, number] }, text: string): void {
    this.edits.push({ start: n.range[0], end: n.range[1], text });
  }

  visit(n: FlowNode): void {
    if (TYPE_KINDS.has(n.type)) {
      this.replace(n, this.type(n));
      return;
    }
    switch (n.type) {
      case "TypeCastExpression":
      case "AsExpression":
        this.cast(n);
        return;
      case "TypeAlias":
      case "OpaqueType":
      case "DeclareTypeAlias":
      case "DeclareOpaqueType":
        this.replace(n, this.alias(n));
        return;
      case "InterfaceDeclaration":
      case "DeclareInterface":
        this.replace(n, this.interface(n));
        return;
      case "DeclareVariable":
      case "DeclareFunction":
      case "DeclareClass":
      case "DeclareModule":
      case "DeclareModuleExports":
      case "DeclareExportDeclaration":
      case "DeclareExportAllDeclaration":
        // Library declarations: types only, which a module of the program
        // does not export at run time.
        this.replace(n, this.declaration(n));
        return;
      case "TypeParameterDeclaration": {
        const text = this.typeParameters(n);
        // `<T>(x) =>` reads as a JSX element in TSX; `<T,>(x) =>` does not.
        const arrow = this.arrowTypeParameters.has(n) && !text.includes(",");
        this.replace(n, arrow ? `${text.slice(0, -1)},>` : text);
        return;
      }
      case "TypeParameterInstantiation":
        this.replace(
          n,
          `<${nodes(n.params)
            .map((p) => this.type(p))
            .join(", ")}>`,
        );
        return;
      case "Variance": {
        // Class property variance: a covariant (+) property is read-only.
        this.replace(n, (n.kind as string) === "plus" ? "readonly " : "");
        return;
      }
      case "ImportDeclaration":
        if (n.importKind === "typeof")
          throw new FlowTranslateError("`import typeof` is not supported yet", n.range[0]);
        for (const specifier of nodes(n.specifiers))
          if (specifier.importKind === "typeof")
            throw new FlowTranslateError(
              "`import typeof` is not supported yet",
              specifier.range[0],
            );
        break;
      case "VariableDeclaration":
        this.declarationKinds.push(n.kind as string);
        this.children(n);
        this.declarationKinds.pop();
        return;

      case "EnumDeclaration":
      case "DeclareEnum":
        throw new FlowTranslateError("Flow enums are not supported yet", n.range[0]);
      case "ComponentDeclaration":
      case "HookDeclaration":
      case "DeclareComponent":
      case "DeclareHook":
        throw new FlowTranslateError(
          "Flow component and hook syntax is not supported yet",
          n.range[0],
        );
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (this.jsx && n.type === "ArrowFunctionExpression" && node(n.typeParameters) !== null)
          this.arrowTypeParameters.add(node(n.typeParameters)!);
        this.predicate(n);
        this.arity(n);
        this.functions.push(n);
        this.children(n);
        this.functions.pop();
        return;
      case "IfStatement":
      case "ConditionalExpression":
        if (this.decide(n)) return;
        break;
      case "VariableDeclarator": {
        const constructed = this.constructed.get(n);
        if (constructed !== undefined) {
          this.edits.push({
            start: node(n.id)!.range[1],
            end: node(n.id)!.range[1],
            text: `: ${constructed} | null`,
          });
          this.child(n.init);
          return;
        }
        const tuple = this.tupleOf(n);
        if (tuple !== null) {
          this.edits.push({
            start: node(n.id)!.range[1],
            end: node(n.id)!.range[1],
            text: `: ${tuple}`,
          });
          this.child(n.init);
          return;
        }
        const uniqueSymbol = this.uniqueSymbolType(n);
        if (uniqueSymbol !== null && this.uniqueSymbolDeclarators.get(uniqueSymbol) === n) {
          const annotation = node(node(n.id)!.typeAnnotation)!;
          const type =
            annotation.type === "TypeAnnotation" ? node(annotation.typeAnnotation)! : annotation;
          this.replace(type, "unique symbol");
          this.child(n.init);
          return;
        }
        // `const f: T = (null: any)` (after constant folding, e.g. a
        // `__DEV__ ? impl : (null: any)` in production): Flow stores a null
        // its annotation excludes, so the binding holds `T | null`.
        const id = node(n.id);
        const annotation = id?.type === "Identifier" ? node(id.typeAnnotation) : null;
        const unit = annotation === null ? null : this.silencedUnit(node(n.init));
        if (annotation === null || unit === null) break;
        const type =
          annotation.type === "TypeAnnotation" ? node(annotation.typeAnnotation)! : annotation;
        this.replace(type, `(${this.type(type)}) | ${unit}`);
        this.child(n.init);
        return;
      }
      case "Identifier":
        if (this.isConstant(n)) {
          const text = this.constantText(n.name as string);
          const guard = text.startsWith("(") && this.statementStarts.has(n.range[0]) ? ";" : "";
          this.replace(n, guard + text);
          return;
        }
        break;
      case "Program":
      case "BlockStatement":
      case "StaticBlock":
        for (const statement of nodes(n.body)) {
          if (n.type === "Program") this.refuseCommonJsExport(statement);
          this.noteStatementStart(statement);
        }
        break;
      case "SwitchCase":
        for (const statement of nodes(n.consequent)) this.noteStatementStart(statement);
        break;
      case "LabeledStatement":
        this.child(n.body);
        return;
      // Names a module imports or exports are bindings, not references
      // (an export without `from` refers to its local binding).
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
      // `import.meta` and `new.target` name no binding.
      case "MetaProperty":
        return;
      case "ExportNamedDeclaration":
        this.child(n.declaration);
        if (n.source === null || n.source === undefined)
          for (const specifier of nodes(n.specifiers)) this.child(specifier.local);
        return;
      case "ExportAllDeclaration":
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
        if (n.kind === "set" && node(n.value) !== null) this.setters.add(node(n.value)!);
        // A member's name is not a reference.
        if (n.computed === true) this.child(n.key);
        for (const [key, value] of Object.entries(n)) {
          if (key === "key" || key === "parent" || key === "range" || key === "loc") continue;
          if (Array.isArray(value)) for (const child of value) this.child(child);
          else this.child(value);
        }
        return;
      case "MemberExpression": {
        // Only the object, and a computed property, are references.
        const object = node(n.object);
        const property = node(n.property);
        if (
          object?.type === "Identifier" &&
          object.name === "module" &&
          n.computed !== true &&
          property?.name === "exports"
        )
          throw new FlowTranslateError("CommonJS Flow modules are not supported yet", n.range[0]);
        this.child(n.object);
        // `(x: any).m`: Flow code asserts x is present to read a member,
        // which TypeScript spells `x!` (`?.` reads one that may be absent).
        if (object !== null && n.optional !== true && this.silencingCast(object))
          this.edits.push({ start: object.range[1], end: object.range[1], text: "!" });
        if (n.computed === true) this.child(n.property);
        return;
      }
      case "Property": {
        const value = node(n.value);
        // `{__DEV__}` reads the constant: it becomes `__DEV__: false`.
        if (n.shorthand === true && value?.type === "Identifier" && this.isConstant(value)) {
          this.replace(
            value,
            `${value.name as string}: ${this.constantText(value.name as string)}`,
          );
          return;
        }
        if (n.kind === "set" && value !== null) this.setters.add(value);
        if (n.computed === true) this.child(n.key);
        // A shorthand's value is its name, or a pattern default (`{a = x}`).
        this.child(n.value);
        return;
      }
    }
    this.children(n);
  }

  private children(n: FlowNode): void {
    for (const [key, value] of Object.entries(n)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      if (Array.isArray(value)) for (const child of value) this.child(child);
      else this.child(value);
    }
  }

  private child(value: unknown): void {
    const n = node(value);
    if (n !== null) this.visit(n);
  }

  /** Flow types an array literal of known elements as a tuple; TypeScript
   * infers an array unless told. The tuple type an unannotated `const x =
   * [a, b.c]` holds (`[typeof a, typeof b.c]`), when every element is a
   * reference and the enclosing function never uses `x` as an array. */
  private tupleOf(n: FlowNode): string | null {
    const id = node(n.id);
    const init = node(n.init);
    if (
      this.declarationKinds[this.declarationKinds.length - 1] !== "const" ||
      id?.type !== "Identifier" ||
      node(id.typeAnnotation) !== null ||
      init?.type !== "ArrayExpression"
    )
      return null;
    const elements = nodes(init.elements);
    // A hole has no element to name, so the literal is an array, not a tuple.
    if (elements.length === 0 || elements.length !== (init.elements as unknown[]).length)
      return null;
    const reference = (e: FlowNode): string | null =>
      e.type === "Identifier"
        ? this.isConstant(e)
          ? null
          : (e.name as string)
        : e.type === "MemberExpression" &&
            e.computed !== true &&
            node(e.property)?.type === "Identifier"
          ? ((object) =>
              object === null ? null : `${object}.${node(e.property)!.name as string}`)(
              reference(node(e.object)!),
            )
          : null;
    const types = elements.map(reference);
    if (types.some((t) => t === null)) return null;
    const scope = this.functions[this.functions.length - 1];
    if (scope === undefined || this.usedAsArray(node(scope.body), id.name as string)) return null;
    return `[${types.map((t) => `typeof ${t}`).join(", ")}]`;
  }

  /** Whether `name` is the object of a member access anywhere in `n`. */
  private usedAsArray(n: FlowNode | null, name: string): boolean {
    if (n === null) return false;
    if (n.type === "MemberExpression") {
      const object = node(n.object);
      if (object?.type === "Identifier" && object.name === name) return true;
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (this.usedAsArray(node(child), name)) return true;
    }
    return false;
  }

  /** The unit an initializer evaluates to through a `(null: any)` or
   * `null as any` cast (or the same over undefined), looking through conditionals the constants
   * decide. */
  private silencedUnit(n: FlowNode | null): "null" | "undefined" | null {
    while (n !== null && n.type === "ConditionalExpression") {
      const taken = this.decided(node(n.test)!);
      if (taken === undefined) return null;
      n = node(taken ? n.consequent : n.alternate);
    }
    if (n === null || (n.type !== "TypeCastExpression" && n.type !== "AsExpression")) return null;
    const annotation = node(n.typeAnnotation)!;
    const type =
      annotation.type === "TypeAnnotation" ? node(annotation.typeAnnotation)! : annotation;
    if (type.type !== "AnyTypeAnnotation") return null;
    const expr = node(n.expression)!;
    if (expr.type === "Literal" && expr.value === null) return "null";
    if (expr.type === "Identifier" && expr.name === "undefined") return "undefined";
    return null;
  }

  /** Whether `n` is a `(e: any)` or `e as any` cast of a non-literal. */
  private silencingCast(n: FlowNode): boolean {
    if (n.type !== "TypeCastExpression" && n.type !== "AsExpression") return false;
    const annotation = node(n.typeAnnotation)!;
    const type =
      annotation.type === "TypeAnnotation" ? node(annotation.typeAnnotation)! : annotation;
    const expr = node(n.expression)!;
    return (
      type.type === "AnyTypeAnnotation" &&
      expr.type !== "Literal" &&
      expr.type !== "ObjectExpression" &&
      expr.type !== "ArrayExpression"
    );
  }

  /** `(e: T)` → `(e as T)`; `(e: any)` keeps `e`'s own type unless `e` is a
   * literal whose type the cast supplies. */
  private cast(n: FlowNode): void {
    const expr = node(n.expression)!;
    const annotation = node(n.typeAnnotation)!;
    const type =
      annotation.type === "TypeAnnotation" ? node(annotation.typeAnnotation)! : annotation;
    this.visit(expr);
    // Object and array literals take their type from the destination (the
    // `({...}: any)` that silences Flow's exactness check stays static);
    // only `null`/`undefined` need the cast to fill a typed slot.
    const silences = type.type === "AnyTypeAnnotation";
    const literal =
      (expr.type === "Literal" && expr.value === null) ||
      (expr.type === "Identifier" && expr.name === "undefined");
    const text = silences && !literal ? "" : ` as ${this.type(type)}`;
    if (n.type === "AsExpression") {
      this.edits.push({ start: expr.range[1], end: n.range[1], text });
      return;
    }
    // `(e: T)`: the `: T` (from its colon, so parentheses and comments
    // around the operand stay) up to the cast's closing paren. `as` binds
    // tighter than an arrow, a conditional or a binary operator, so such an
    // operand is parenthesized.
    let colon = annotation.range[0];
    while (colon > expr.range[1] && this.source[colon] !== ":") colon--;
    if (text !== "" && !PRIMARY_KINDS.has(expr.type)) {
      this.edits.push({ start: expr.range[0], end: expr.range[0], text: "(" });
      this.edits.push({ start: expr.range[1], end: expr.range[1], text: ")" });
    }
    this.edits.push({ start: colon, end: n.range[1] - 1, text });
  }

  /** JavaScript arity for what Flow leaves unannotated: a trailing run of
   * unannotated parameters is optional (they hold `unknown`, which
   * undefined already is). A function that reads `arguments` takes the
   * JavaScript calling convention (call-signatures.ts). */
  private arity(n: FlowNode): void {
    // Arrow functions are typed by their context (and a bare `x =>` has no
    // room for `?`).
    if (n.type === "ArrowFunctionExpression") return;
    const params = nodes(n.params);
    let trailing = true;
    for (let i = params.length - 1; i >= 0; i--) {
      const p = params[i]!;
      const target = p.type === "AssignmentPattern" ? node(p.left)! : p;
      const untyped = target.type === "Identifier" && node(target.typeAnnotation) === null;
      // Optional already: `x?`, or a parameter with a default.
      const optional = p.type === "AssignmentPattern" || p.optional === true;
      trailing =
        trailing && !this.setters.has(n) && (optional || (untyped && p.type === "Identifier"));
      // An unannotated parameter holds `unknown` (TypeScript would infer
      // `any`, which has no representation).
      if (untyped)
        this.edits.push({
          start: target.range[1],
          end: target.range[1],
          text: `${trailing && !optional ? "?" : ""}: unknown`,
        });
    }
    if (n.type !== "FunctionDeclaration" || node(n.id) === null) return;
    if (params.some((p) => p.type === "RestElement") || !this.readsArguments(node(n.body))) return;
    // TypeScript callers may pass any number of arguments, as JavaScript
    // callers do: a variadic overload says so, and the implementation keeps
    // its own parameters (and JavaScript's calling convention).
    // Inserted after an `export` (or `export default`) keyword, which the
    // implementation then repeats.
    const parent = node(n.parent)?.type;
    const prefix =
      parent === "ExportNamedDeclaration"
        ? "export "
        : parent === "ExportDefaultDeclaration"
          ? "export default "
          : "";
    const declared = params.map((p, i) => {
      const target = p.type === "AssignmentPattern" ? node(p.left)! : p;
      const annotation = node(target.typeAnnotation);
      const name = target.type === "Identifier" ? (target.name as string) : `p${i}_`;
      const type =
        annotation === null
          ? "unknown"
          : this.type(
              annotation.type === "TypeAnnotation" ? node(annotation.typeAnnotation)! : annotation,
            );
      // A declared `this` is not an argument: it stays required.
      return name === "this" ? `this: ${type}` : `${name}?: ${type}`;
    });
    const returnType = node(n.returnType);
    const ret =
      returnType === null
        ? "unknown"
        : this.type(
            returnType.type === "TypeAnnotation" ? node(returnType.typeAnnotation)! : returnType,
          );
    const typeParams = node(n.typeParameters);
    const tp = typeParams === null ? "" : this.typeParameters(typeParams);
    const overload = `function ${node(n.id)!.name as string}${tp}(${[...declared, "...rest_: unknown[]"].join(", ")}): ${ret};\n${prefix}`;
    this.edits.push({ start: n.range[0], end: n.range[0], text: overload });
  }

  /** Whether a function body reads `arguments` (not through a nested
   * non-arrow function, which has its own). */
  private readsArguments(n: FlowNode | null): boolean {
    if (n === null) return false;
    if (n.type === "Identifier" && n.name === "arguments") return true;
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") return false;
    for (const [key, value] of Object.entries(n)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (this.readsArguments(node(child))) return true;
    }
    return false;
  }

  /** `function f(x): %checks` → `function f(x)`. */
  private predicate(n: FlowNode): void {
    const predicate = node(n.predicate);
    if (predicate === null) return;
    if (node(n.returnType) !== null) {
      // `: R %checks`: drop the predicate after the return type.
      this.edits.push({ start: node(n.returnType)!.range[1], end: predicate.range[1], text: "" });
      return;
    }
    let colon = predicate.range[0] - 1;
    while (colon > 0 && this.source[colon] !== ":") colon--;
    this.edits.push({ start: colon, end: predicate.range[1], text: "" });
  }

  private noteStatementStart(statement: FlowNode): void {
    if (statement.type === "ExpressionStatement") this.statementStarts.add(statement.range[0]);
  }

  /** A top-level `exports.x = ...` makes the module CommonJS, which a
   * Flow module presented as TypeScript cannot be. */
  private refuseCommonJsExport(statement: FlowNode): void {
    const e = statement.type === "ExpressionStatement" ? node(statement.expression) : null;
    const left = e?.type === "AssignmentExpression" ? node(e.left) : null;
    const object = left?.type === "MemberExpression" ? node(left.object) : null;
    if (object?.type === "Identifier" && object.name === "exports")
      throw new FlowTranslateError(
        "CommonJS Flow modules are not supported yet",
        statement.range[0],
      );
  }

  private alias(n: FlowNode): string {
    const id = node(n.id)!.name as string;
    const params = node(n.typeParameters) ? this.typeParameters(node(n.typeParameters)!) : "";
    const right = node(n.right) ?? node(n.impltype) ?? node(n.supertype);
    const override = this.types.get(id);
    const body =
      override === "unique symbol"
        ? this.uniqueSymbols.has(id)
          ? `typeof ${this.uniqueSymbols.get(id)!}`
          : "symbol"
        : (override ?? (right === null ? "unknown" : this.type(right)));
    const declare = n.type.startsWith("Declare") ? "declare " : "";
    return `${declare}type ${id}${params} = ${body};`;
  }

  private interface(n: FlowNode): string {
    const id = node(n.id)!.name as string;
    const params = node(n.typeParameters) ? this.typeParameters(node(n.typeParameters)!) : "";
    const override = this.types.get(id);
    if (override !== undefined) return `type ${id}${params} = ${override};`;
    const supers = nodes(n.extends).map((e) => this.interfaceExtends(e));
    const parts = this.objectParts(node(n.body)!);
    // An interface body is one object type; any other form is an alias.
    if (parts.length !== 1 || !parts[0]!.text.startsWith("{ "))
      return `type ${id}${params} = ${[...supers, this.object(node(n.body)!, parts)].join(" & ")};`;
    const ext = supers.length > 0 ? ` extends ${supers.join(", ")}` : "";
    return `interface ${id}${params}${ext} ${parts[0]!.text}`;
  }

  private interfaceExtends(e: FlowNode): string {
    const id = this.qualified(node(e.id)!);
    const override = this.types.get(id);
    if (override !== undefined) return `(${override})`;
    const args = node(e.typeParameters);
    return args
      ? `${id}<${nodes(args.params)
          .map((p) => this.type(p))
          .join(", ")}>`
      : id;
  }

  private declaration(n: FlowNode): string {
    switch (n.type) {
      case "DeclareVariable": {
        const id = node(n.id)!;
        const annotation = node(id.typeAnnotation);
        const type = annotation ? this.type(node(annotation.typeAnnotation)!) : "unknown";
        return `declare var ${id.name as string}: ${type};`;
      }
      case "DeclareFunction": {
        const id = node(n.id)!;
        const fn = node(node(id.typeAnnotation)!.typeAnnotation)!;
        return `declare function ${id.name as string}${this.signature(fn, ": ")};`;
      }
      case "DeclareExportDeclaration": {
        const decl = node(n.declaration);
        if (decl === null || n.default === true || TYPE_KINDS.has(decl.type))
          throw new FlowTranslateError(
            "this form of `declare export` is not supported yet",
            n.range[0],
          );
        if (
          decl.type === "TypeAlias" ||
          decl.type === "OpaqueType" ||
          decl.type === "DeclareTypeAlias" ||
          decl.type === "DeclareOpaqueType"
        )
          return `export ${this.alias(decl)}`;
        if (decl.type === "InterfaceDeclaration" || decl.type === "DeclareInterface")
          return `export ${this.interface(decl)}`;
        // A declared function or variable would be an export no code of
        // the module defines.
        throw new FlowTranslateError(
          "this form of `declare export` is not supported yet",
          n.range[0],
        );
      }
      default:
        throw new FlowTranslateError(
          `Flow \`${DECLARATION_NAMES[n.type] ?? n.type}\` declarations are not supported yet`,
          n.range[0],
        );
    }
  }

  private typeParameters(n: FlowNode): string {
    const params = nodes(n.params).map((p) => {
      let text = p.name as string;
      const bound = node(p.bound);
      if (bound) text += ` extends ${this.type(node(bound.typeAnnotation) ?? bound)}`;
      const def = node(p.default);
      if (def) text += ` = ${this.type(def)}`;
      return text;
    });
    return `<${params.join(", ")}>`;
  }

  private qualified(id: FlowNode): string {
    if (id.type === "Identifier") return id.name as string;
    return `${this.qualified(node(id.qualification)!)}.${node(id.id)!.name as string}`;
  }

  /** The TypeScript text of a type node. */
  type(n: FlowNode): string {
    switch (n.type) {
      case "AnyTypeAnnotation":
      case "MixedTypeAnnotation":
      case "ExistsTypeAnnotation":
      case "TypeOperator":
      case "ComponentTypeAnnotation":
      case "HookTypeAnnotation":
        return "unknown";
      case "EmptyTypeAnnotation":
        return "never";
      case "VoidTypeAnnotation":
        return "void";
      case "NullLiteralTypeAnnotation":
        return "null";
      case "NumberTypeAnnotation":
        return "number";
      case "StringTypeAnnotation":
        return "string";
      case "BooleanTypeAnnotation":
        return "boolean";
      case "SymbolTypeAnnotation":
        return "symbol";
      case "BigIntTypeAnnotation":
        return "bigint";
      case "StringLiteralTypeAnnotation":
      case "NumberLiteralTypeAnnotation":
      case "BigIntLiteralTypeAnnotation":
        return (n.raw as string) ?? JSON.stringify(n.value);
      case "BooleanLiteralTypeAnnotation":
        return String(n.value);
      case "TypeAnnotation":
        return this.type(node(n.typeAnnotation)!);
      case "NullableTypeAnnotation":
        return `${this.operand(node(n.typeAnnotation)!)} | null | undefined`;
      case "UnionTypeAnnotation":
        // Flow's `void` in a union is the undefined value.
        return nodes(n.types)
          .map((t) => (t.type === "VoidTypeAnnotation" ? "undefined" : this.operand(t)))
          .join(" | ");
      case "IntersectionTypeAnnotation":
        return nodes(n.types)
          .map((t) => this.operand(t))
          .join(" & ");
      case "ArrayTypeAnnotation":
        return `Array<${this.type(node(n.elementType)!)}>`;
      case "TupleTypeAnnotation":
        return `[${nodes(n.elementTypes ?? n.types)
          .map((e) => this.tupleElement(e))
          .join(", ")}]`;
      case "GenericTypeAnnotation":
        return this.generic(n);
      case "ObjectTypeAnnotation":
        return this.object(n);
      case "InterfaceTypeAnnotation":
        return [
          ...nodes(n.extends).map((e) => this.interfaceExtends(e)),
          this.object(node(n.body)!),
        ].join(" & ");
      case "FunctionTypeAnnotation":
        return this.signature(n, " => ");
      case "TypeofTypeAnnotation": {
        const arg = node(n.argument)!;
        return `typeof ${arg.type === "Identifier" ? (arg.name as string) : this.qualified(arg)}`;
      }
      case "IndexedAccessType":
        return `${this.operand(node(n.objectType)!)}[${this.type(node(n.indexType)!)}]`;
      case "OptionalIndexedAccessType":
        // `O?.[K]` is the member's type, or undefined when O is missing.
        return `NonNullable<${this.type(node(n.objectType)!)}>[${this.type(node(n.indexType)!)}] | undefined`;
      case "KeyofTypeAnnotation":
        return `keyof ${this.operand(node(n.argument)!)}`;
      case "ConditionalTypeAnnotation":
        return `${this.operand(node(n.checkType)!)} extends ${this.operand(node(n.extendsType)!)} ? ${this.type(node(n.trueType)!)} : ${this.type(node(n.falseType)!)}`;
      case "InferTypeAnnotation":
        return `infer ${node(n.typeParameter)!.name as string}`;
      case "TypePredicate": {
        const name = node(n.parameterName)!.name as string;
        const t = node(n.typeAnnotation);
        if (n.kind === "asserts")
          return t ? `asserts ${name} is ${this.type(t)}` : `asserts ${name}`;
        return t ? `${name} is ${this.type(t)}` : "boolean";
      }
      default:
        throw new FlowTranslateError(`Flow type '${n.type}' is not supported yet`, n.range[0]);
    }
  }

  /** A type as the operand of a union, intersection or postfix: functions,
   * conditionals and unions are parenthesized. */
  private operand(n: FlowNode): string {
    const text = this.type(n);
    const loose =
      n.type === "FunctionTypeAnnotation" ||
      n.type === "ConditionalTypeAnnotation" ||
      n.type === "UnionTypeAnnotation" ||
      n.type === "NullableTypeAnnotation" ||
      n.type === "IntersectionTypeAnnotation" ||
      n.type === "KeyofTypeAnnotation" ||
      n.type === "TypeofTypeAnnotation";
    return loose ? `(${text})` : text;
  }

  private tupleElement(e: FlowNode): string {
    if (e.type === "TupleTypeLabeledElement")
      return `${node(e.label)!.name as string}${e.optional ? "?" : ""}: ${this.type(node(e.elementType)!)}`;
    if (e.type === "TupleTypeSpreadElement") return `...${this.type(node(e.typeAnnotation)!)}`;
    return this.type(e);
  }

  private generic(n: FlowNode): string {
    const id = node(n.id)!;
    const name = id.type === "Identifier" ? (id.name as string) : this.qualified(id);
    const args = nodes(node(n.typeParameters)?.params);
    const arg = (i: number): string => (args[i] ? this.type(args[i]!) : "unknown");
    const override = this.types.get(name);
    // A unique symbol is its declaring module's alias, which references import.
    if (override === "unique symbol") return name;
    if (override !== undefined) return `(${override})`;
    // `React$Node` and the other `React$` types are Flow library globals.
    if (UNKNOWN_BUILTINS.has(name) || name.startsWith("React$")) return "unknown";
    switch (name) {
      case "$ReadOnly":
        return `Readonly<${arg(0)}>`;
      case "$ReadOnlyArray":
        return `ReadonlyArray<${arg(0)}>`;
      case "$ReadOnlyMap":
        return `ReadonlyMap<${arg(0)}, ${arg(1)}>`;
      case "$ReadOnlySet":
        return `ReadonlySet<${arg(0)}>`;
      case "$Keys":
        return `keyof ${args[0] ? this.operand(args[0]) : "unknown"}`;
      case "$Values":
        return `${args[0] ? this.operand(args[0]) : "unknown"}[keyof ${args[0] ? this.operand(args[0]) : "unknown"}]`;
      case "$Shape":
      case "$Partial":
        return `Partial<${arg(0)}>`;
      case "$Exact":
        return arg(0);
      case "$NonMaybeType":
        return `NonNullable<${arg(0)}>`;
      case "$PropertyType":
      case "$ElementType":
        return `${args[0] ? this.operand(args[0]) : "unknown"}[${arg(1)}]`;
      case "$Diff":
        return `Omit<${arg(0)}, keyof ${args[1] ? this.operand(args[1]) : "unknown"}>`;
      case "Class":
        return `{ new (...args: never[]): ${arg(0)} }`;
      // TypeScript defaults the omitted result types to `any`.
      case "Iterator":
      case "AsyncIterator":
      case "Iterable":
      case "AsyncIterable":
      case "Generator":
      case "AsyncGenerator":
        return `${name}<${arg(0)}, ${arg(1)}, ${arg(2)}>`;
      case "_":
        throw new FlowTranslateError(
          "Flow's `_` type placeholder is not supported yet",
          n.range[0],
        );
      // Flow library names for the TypeScript library's types.
      case "$Iterator":
      case "$AsyncIterator":
      case "$Iterable":
      case "$AsyncIterable":
        return `${name.slice(1)}<${arg(0)}, ${arg(1)}, ${arg(2)}>`;
      case "$ArrayBufferView":
        return "ArrayBufferView";
    }
    if (UNSUPPORTED_UTILITIES.has(name))
      throw new FlowTranslateError(`Flow utility type '${name}' is not supported yet`, n.range[0]);
    return args.length > 0 ? `${name}<${args.map((a) => this.type(a)).join(", ")}>` : name;
  }

  private key(k: FlowNode): string {
    if (k.type === "Identifier") return k.name as string;
    return (k.raw as string) ?? JSON.stringify(k.value);
  }

  /** An object type, members and spreads in source order: a later member
   * overrides an earlier one with the same key, as in Flow, so each part
   * after the first omits the keys of what follows it from what precedes
   * it, in each member of a union (`{...B, a: T}` is `Omit<B, "a"> & { a:
   * T }` for each B; an intersection would make an overridden `a` never).
   * A spread's type can itself be a union, whose arms carry different
   * keys, so a spread omits per arm: the keys of the whole union are only
   * the keys every arm has, and a key only some arms carry would keep the
   * earlier part's type and turn the arm that overrides it into `never`. */
  private object(n: FlowNode, parts = this.objectParts(n)): string {
    if (parts.length === 0) return "{}";
    let text = parts[0]!.text;
    let level = 0;
    for (const part of parts.slice(1)) {
      if (part.spread) {
        const member = this.binder(level);
        const arm = this.binder(level + 1);
        text = `(${part.text} extends infer ${arm} ? (${arm} extends unknown ? (${text} extends infer ${member} ? (${member} extends unknown ? Omit<${member}, keyof ${arm}> : never) : never) & ${arm} : never) : never)`;
        level += 2;
      } else if (part.keys === null) text = `${text} & ${part.text}`;
      else {
        const member = this.binder(level);
        text = `(${text} extends infer ${member} ? (${member} extends unknown ? Omit<${member}, ${part.keys}> : never) : never) & ${part.text}`;
        level++;
      }
    }
    return text;
  }

  /** An object type's parts: runs of members, spreads, then indexers and
   * call signatures. */
  private objectParts(n: FlowNode): ObjectPart[] {
    for (const slot of nodes(n.internalSlots))
      throw new FlowTranslateError(
        "Flow internal slot properties are not supported yet",
        slot.range[0],
      );
    const parts: ObjectPart[] = [];
    let group: FlowNode[] = [];
    const flush = (): void => {
      if (group.length > 0) parts.push(this.members(group));
      group = [];
    };
    for (const p of nodes(n.properties)) {
      if (p.type === "ObjectTypeProperty") group.push(p);
      else if (p.type === "ObjectTypeSpreadProperty") {
        flush();
        // Spreading null or undefined adds nothing.
        const text = `NonNullable<${this.type(node(p.argument)!)}>`;
        parts.push({ text, keys: null, spread: true });
      } else if (p.type === "ObjectTypeMappedTypeProperty")
        throw new FlowTranslateError("Flow mapped types are not supported yet", p.range[0]);
      else
        throw new FlowTranslateError(
          `Flow '${p.type}' object members are not supported yet`,
          p.range[0],
        );
    }
    flush();
    // Indexers and call signatures have no key a spread overrides.
    const extra: string[] = [];
    const records: string[] = [];
    for (const i of nodes(n.indexers)) {
      const keyType = this.type(node(i.key)!);
      const value = this.type(node(i.value)!);
      const name = (node(i.id)?.name as string | undefined) ?? "key";
      const readonly = node(i.variance)?.kind === "plus";
      if (keyType === "string" || keyType === "number" || keyType === "symbol")
        extra.push(`${readonly ? "readonly " : ""}[${name}: ${keyType}]: ${value};`);
      else {
        // A Flow indexer's keys are each optional.
        const record = `Partial<Record<${keyType}, ${value}>>`;
        records.push(readonly ? `Readonly<${record}>` : record);
      }
    }
    for (const c of nodes(n.callProperties)) extra.push(`${this.signature(node(c.value)!, ": ")};`);
    if (extra.length > 0) parts.push({ text: `{ ${extra.join(" ")} }`, keys: null, spread: false });
    for (const record of records) parts.push({ text: record, keys: null, spread: false });
    return parts;
  }

  /** A run of an object type's own properties, and their keys as a union
   * of literal types. */
  private members(properties: FlowNode[]): ObjectPart {
    const members: string[] = [];
    const keys: string[] = [];
    for (const p of properties) {
      const value = node(p.value)!;
      const readonly = node(p.variance)?.kind === "plus" ? "readonly " : "";
      const keyNode = node(p.key)!;
      const key = this.key(keyNode);
      keys.push(
        keyNode.type === "Identifier"
          ? JSON.stringify(keyNode.name)
          : typeof keyNode.value === "string"
            ? JSON.stringify(keyNode.value)
            : String(keyNode.value),
      );
      if (p.method) members.push(`${key}${this.signature(value, ": ")};`);
      else if (p.kind === "get")
        members.push(`get ${key}(): ${this.type(node(value.returnType)!)};`);
      else if (p.kind === "set")
        members.push(`set ${key}${this.signature(value, ": ").replace(/: [^:]*$/, "")};`);
      else members.push(`${readonly}${key}${p.optional ? "?" : ""}: ${this.type(value)};`);
    }
    return { text: `{ ${members.join(" ")} }`, keys: keys.join(" | "), spread: false };
  }

  /** `<T>(a: A, ...r: R) => Ret` (arrow `sep`) or `(a: A): Ret` (`: `). */
  private signature(fn: FlowNode, sep: string): string {
    const typeParams = node(fn.typeParameters) ? this.typeParameters(node(fn.typeParameters)!) : "";
    const params: string[] = [];
    const thisParam = node(fn.this);
    if (thisParam) params.push(`this: ${this.type(node(thisParam.typeAnnotation)!)}`);
    nodes(fn.params).forEach((p, i) => {
      const name = (node(p.name)?.name as string | undefined) ?? `arg${i}`;
      params.push(`${name}${p.optional ? "?" : ""}: ${this.type(node(p.typeAnnotation)!)}`);
    });
    const rest = node(fn.rest);
    if (rest)
      params.push(
        `...${(node(rest.name)?.name as string | undefined) ?? "rest"}: ${this.type(node(rest.typeAnnotation)!)}`,
      );
    const ret = node(fn.returnType);
    return `${typeParams}(${params.join(", ")})${sep}${ret ? this.type(ret) : "void"}`;
  }
}
