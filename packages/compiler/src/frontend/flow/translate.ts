/* Flow → TypeScript translation of one module (flow/index.ts serves the
 * result in place of the Flow file).
 *
 * Most Flow syntax is already TypeScript, so the translation edits the
 * source in place: every type is reprinted in TypeScript's spelling, and
 * the few non-type constructs that differ (casts, opaque types, variance
 * sigils, predicate functions) are rewritten. Everything else, comments and
 * formatting included, is copied, and the position maps lead diagnostics
 * back to the Flow source.
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
}

export class FlowTranslateError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

/** Flow's library type names and their TypeScript spelling; `null` when
 * the reference translates by its arguments (FlowTranslator.generic). */
const UNKNOWN_BUILTINS = new Set([
  "Function",
  "Object",
  "$FlowFixMe",
  "$FlowIssue",
  "$FlowExpectedError",
  "$FlowIgnore",
]);

const node = (value: unknown): FlowNode | null =>
  value !== null && typeof value === "object" && typeof (value as FlowNode).type === "string"
    ? (value as FlowNode)
    : null;
const nodes = (value: unknown): FlowNode[] => (Array.isArray(value) ? (value as FlowNode[]) : []);

/** Type nodes the printer handles (a node of one of these kinds is printed
 * whole; its children are not visited separately). */
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
  t.findUniqueSymbols(program);
  t.findConstructedBindings(program);
  t.visit(program);
  // Flow is the checker of record for its modules: TypeScript computes and
  // uses their types but reports none of its own rules' errors against them
  // (Flow refines and widens differently). scriptc's lowering still enforces
  // what it needs to compile each value.
  // First among the insertions at offset 0, which keep their order.
  t.edits.unshift({ start: 0, end: 0, text: "// @ts-nocheck: a Flow module, checked by Flow.\n" });
  return applySourceEdits(source, t.edits);
}

class FlowTranslator {
  readonly edits: SourceEdit[] = [];
  private readonly types: ReadonlyMap<string, string>;
  /** A type corrected to `unique symbol`, and the module constant whose
   * symbol it is (`const KEY: Key = Symbol.for(…)`). */
  private readonly uniqueSymbols = new Map<string, string>();
  /** Module `let x = null` bindings the module only assigns `new C(...)`
   * (or null): the class each holds (findConstructedBindings). */
  private readonly constructed = new Map<FlowNode, string>();
  /** The functions enclosing the node being visited. */
  private readonly functions: FlowNode[] = [];
  private readonly constants: ReadonlyMap<string, boolean | number | string | null>;

  constructor(
    private readonly source: string,
    options: FlowTranslateOptions,
  ) {
    this.types = options.types ?? new Map();
    this.constants = options.constants ?? new Map();
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
        if (name !== null) this.uniqueSymbols.set(name, node(declarator.id)!.name as string);
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
          const written =
            n.operator === "=" && callee?.type === "Identifier"
              ? (callee.name as string)
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
        return this.constants.has(n.name as string)
          ? this.constants.get(n.name as string)
          : undefined;
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
        if (n.operator === "===" || n.operator === "==") return l === r;
        if (n.operator === "!==" || n.operator === "!=") return l !== r;
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
      this.edits.push({ start, end: live!.range[0], text: "(" });
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
    this.edits.push({ start, end: live.range[0], text: "" });
    this.edits.push({ start: live.range[1], end, text: tail });
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
      case "TypeParameterDeclaration":
        this.replace(n, this.typeParameters(n));
        return;
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
        break;
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
        if (this.uniqueSymbolType(n) !== null) {
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
        if (this.constants.has(n.name as string)) {
          this.replace(n, JSON.stringify(this.constants.get(n.name as string)));
          return;
        }
        break;
      case "MemberExpression": {
        // Only the object, and a computed property, are references.
        const object = node(n.object);
        this.child(n.object);
        // `(x: any).m`: Flow code asserts x is present to read a member,
        // which TypeScript spells `x!`.
        if (object !== null && this.silencingCast(object))
          this.edits.push({ start: object.range[1], end: object.range[1], text: "!" });
        if (n.computed === true) this.child(n.property);
        return;
      }
      case "Property":
        if (n.computed === true) this.child(n.key);
        if (n.shorthand !== true) this.child(n.value);
        return;
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
      id?.type !== "Identifier" ||
      node(id.typeAnnotation) !== null ||
      init?.type !== "ArrayExpression"
    )
      return null;
    const elements = nodes(init.elements);
    if (elements.length === 0 || elements.length !== (init.elements as unknown[]).length)
      return null;
    const reference = (e: FlowNode): string | null =>
      e.type === "Identifier"
        ? (e.name as string)
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
    // The text between the operand and the cast's end: `: T` (and the
    // closing paren of a Flow cast, which the cast's range includes).
    const close = n.type === "TypeCastExpression" ? n.range[1] - 1 : n.range[1];
    const text = silences && !literal ? "" : ` as ${this.type(type)}`;
    this.edits.push({ start: expr.range[1], end: close, text });
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
      trailing = trailing && untyped && p.type === "Identifier" && p.optional !== true;
      // An unannotated parameter holds `unknown` (TypeScript would infer
      // `any`, which has no representation).
      if (untyped)
        this.edits.push({
          start: target.range[1],
          end: target.range[1],
          text: `${trailing ? "?" : ""}: unknown`,
        });
    }
    if (n.type !== "FunctionDeclaration" || node(n.id) === null) return;
    if (params.some((p) => p.type === "RestElement") || !this.readsArguments(node(n.body))) return;
    // TypeScript callers may pass any number of arguments, as JavaScript
    // callers do: a variadic overload says so, and the implementation keeps
    // its own parameters (and JavaScript's calling convention).
    // Inserted after an `export` (or `export default`) keyword, which the
    // implementation then repeats.
    const prefix =
      /\bexport\s+(default\s+)?$/.exec(
        this.source.slice(Math.max(0, n.range[0] - 40), n.range[0]),
      )?.[0] ?? "";
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
      return `${name}?: ${type}`;
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
    const ext = supers.length > 0 ? ` extends ${supers.join(", ")}` : "";
    return `interface ${id}${params}${ext} ${this.objectBody(node(n.body)!)}`;
  }

  private interfaceExtends(e: FlowNode): string {
    const id = this.qualified(node(e.id)!);
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
        if (decl === null) return "";
        const inner = TYPE_KINDS.has(decl.type)
          ? `const default_: ${this.type(decl)}`
          : this.declaration(decl);
        return inner.startsWith("declare ") ? `export ${inner}` : inner;
      }
      default:
        throw new FlowTranslateError(
          `Flow '${n.type}' declarations are not supported yet`,
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
        return this.objectBody(node(n.body)!);
      case "FunctionTypeAnnotation":
        return this.signature(n, " => ");
      case "TypeofTypeAnnotation": {
        const arg = node(n.argument)!;
        return `typeof ${arg.type === "Identifier" ? (arg.name as string) : this.qualified(arg)}`;
      }
      case "IndexedAccessType":
        return `${this.operand(node(n.objectType)!)}[${this.type(node(n.indexType)!)}]`;
      case "OptionalIndexedAccessType":
        return `NonNullable<${this.type(node(n.objectType)!)}>[${this.type(node(n.indexType)!)}]`;
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
        return `${name}<${arg(0)}, unknown, unknown>`;
    }
    return args.length > 0 ? `${name}<${args.map((a) => this.type(a)).join(", ")}>` : name;
  }

  private key(k: FlowNode): string {
    if (k.type === "Identifier") return k.name as string;
    return (k.raw as string) ?? JSON.stringify(k.value);
  }

  /** An object type: spreads become an intersection with the own members. */
  private object(n: FlowNode): string {
    const spreads = nodes(n.properties).filter((p) => p.type === "ObjectTypeSpreadProperty");
    const body = this.objectBody(n);
    if (spreads.length === 0) return body;
    const parts = spreads.map((s) => this.operand(node(s.argument)!));
    return body === "{}" ? parts.join(" & ") : [...parts, body].join(" & ");
  }

  private objectBody(n: FlowNode): string {
    const members: string[] = [];
    for (const p of nodes(n.properties)) {
      if (p.type === "ObjectTypeSpreadProperty") continue;
      const value = node(p.value)!;
      const readonly = node(p.variance)?.kind === "plus" ? "readonly " : "";
      const key = this.key(node(p.key)!);
      if (p.method) members.push(`${key}${this.signature(value, ": ")};`);
      else if (p.kind === "get")
        members.push(`get ${key}(): ${this.type(node(value.returnType)!)};`);
      else if (p.kind === "set")
        members.push(`set ${key}${this.signature(value, ": ").replace(/: [^:]*$/, "")};`);
      else members.push(`${readonly}${key}${p.optional ? "?" : ""}: ${this.type(value)};`);
    }
    for (const i of nodes(n.indexers)) {
      const keyType = this.type(node(i.key)!);
      const value = this.type(node(i.value)!);
      const name = (node(i.id)?.name as string | undefined) ?? "key";
      const readonly = node(i.variance)?.kind === "plus" ? "readonly " : "";
      if (keyType === "string" || keyType === "number" || keyType === "symbol")
        members.push(`${readonly}[${name}: ${keyType}]: ${value};`);
      else members.push(`[${name}: string]: ${value};`);
    }
    for (const c of nodes(n.callProperties))
      members.push(`${this.signature(node(c.value)!, ": ")};`);
    return members.length === 0 ? "{}" : `{ ${members.join(" ")} }`;
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
