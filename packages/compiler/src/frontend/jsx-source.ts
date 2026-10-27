/* JSX lowering at the source level, before IR lowering.
 *
 * A program that contains JSX is checked as written: the checker types JSX
 * with the project's jsx settings and reports the errors tsc reports. Each
 * file that contains JSX is then rewritten with every JSX expression
 * replaced by the calls TypeScript emits for it, and the rewritten program is
 * what the lowering compiles, through the same import, call and object
 * literal lowering as ordinary code.
 *
 * The rewrite copies every byte outside JSX expressions, and copies the
 * expressions inside them (attribute values, children, spreads) with their
 * own JSX rewritten. It keeps every line break of a JSX expression, between
 * the arguments it emits, so a position keeps its line in the rewritten
 * text. */

import * as ts from "./ts7/adapter.js";
import { jsxOptionName } from "./ts7/enums.js";
import { JSX_ENTITIES } from "./jsx-entities.js";

/** The project's jsx compiler options, as the tsconfig spells them. */
export interface JsxOptions {
  jsx?: string | number | undefined;
  jsxFactory?: string | undefined;
  jsxFragmentFactory?: string | undefined;
  jsxImportSource?: string | undefined;
  reactNamespace?: string | undefined;
}

/** The tsconfig name of a `jsx` option value (TS7 options carry JsxEmit
 * numbers, parsed tsconfigs may carry the name). */
export function jsxEmitName(value: string | number | undefined): string | undefined {
  if (typeof value === "number") return jsxOptionName(value);
  return value?.toLowerCase();
}

/** The `@jsx`, `@jsxFrag`, `@jsxImportSource` and `@jsxRuntime` pragmas of
 * a file's leading comments, as TypeScript reads them: multi-line comments
 * only, the first `@jsx` and `@jsxFrag` and the last `@jsxImportSource` and
 * `@jsxRuntime`. */
export interface JsxPragmas {
  jsx?: string;
  jsxFrag?: string;
  jsxImportSource?: string;
  jsxRuntime?: string;
}

export function jsxPragmas(text: string): JsxPragmas {
  const pragmas: JsxPragmas = {};
  for (const comment of leadingMultiLineComments(text)) {
    const pattern = /@(\S+)(\s+(?:\S.*)?)?$/gm;
    for (let match = pattern.exec(comment); match !== null; match = pattern.exec(comment)) {
      const argument = match[2]?.trim().split(/\s+/)[0];
      if (!argument) continue;
      switch (match[1]!.toLowerCase()) {
        case "jsx":
          pragmas.jsx ??= argument;
          break;
        case "jsxfrag":
          pragmas.jsxFrag ??= argument;
          break;
        case "jsximportsource":
          pragmas.jsxImportSource = argument;
          break;
        case "jsxruntime":
          pragmas.jsxRuntime = argument;
          break;
      }
    }
  }
  return pragmas;
}

/** The `/* ... *\/` comments before a file's first token (after a shebang). */
function leadingMultiLineComments(text: string): string[] {
  const comments: string[] = [];
  let i = text.startsWith("#!") ? text.indexOf("\n") : 0;
  if (i < 0) return comments;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (isLineBreak(ch) || isWhiteSpaceSingleLine(ch)) {
      i++;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && !isLineBreak(text.charCodeAt(i))) i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const close = end < 0 ? text.length : end + 2;
      comments.push(text.slice(i, close));
      i = close;
    } else {
      break;
    }
  }
  return comments;
}

function isLineBreak(ch: number): boolean {
  return ch === 10 || ch === 13 || ch === 0x2028 || ch === 0x2029;
}

function isWhiteSpaceSingleLine(ch: number): boolean {
  return (
    ch === 32 ||
    ch === 9 ||
    ch === 11 ||
    ch === 12 ||
    ch === 160 ||
    ch === 133 ||
    ch === 5760 ||
    (ch >= 8192 && ch <= 8203) ||
    ch === 8239 ||
    ch === 8287 ||
    ch === 12288 ||
    ch === 65279
  );
}

/** How a file's JSX is emitted, after its pragmas. */
export type JsxEmitPlan =
  | {
      runtime: "classic";
      /** The factory call (`h`, `React.createElement`). */
      factory: string;
      /** The fragment tag (`Fragment`, `React.Fragment`). */
      fragment: string;
    }
  | {
      runtime: "automatic";
      /** The module `jsx-runtime` (or `jsx-dev-runtime`) is under, and that
       * a `createElement` fallback imports from (`react`). */
      importSource: string;
      /** jsx: react-jsxdev: `jsxDEV` calls with source locations. */
      development: boolean;
    };

/** The plan of a file: the automatic runtime with jsx: react-jsx or
 * react-jsxdev, an import source or an `@jsxRuntime automatic` pragma (an
 * `@jsxRuntime classic` pragma overrides all of them), the classic runtime
 * otherwise. */
export function jsxEmitPlan(options: JsxOptions, pragmas: JsxPragmas): JsxEmitPlan {
  const mode = jsxEmitName(options.jsx);
  const automatic =
    pragmas.jsxRuntime !== "classic" &&
    (mode === "react-jsx" ||
      mode === "react-jsxdev" ||
      options.jsxImportSource !== undefined ||
      pragmas.jsxImportSource !== undefined ||
      pragmas.jsxRuntime === "automatic");
  if (automatic) {
    return {
      runtime: "automatic",
      importSource: pragmas.jsxImportSource ?? options.jsxImportSource ?? "react",
      development: mode === "react-jsxdev",
    };
  }
  const namespace = options.reactNamespace ?? "React";
  return {
    runtime: "classic",
    factory: pragmas.jsx ?? options.jsxFactory ?? `${namespace}.createElement`,
    fragment: pragmas.jsxFrag ?? options.jsxFragmentFactory ?? `${namespace}.Fragment`,
  };
}

/** True when the file contains a JSX expression. */
export function containsJsx(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isJsxExpressionRoot(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The first JSX expression of the file (for diagnostics), or null. */
export function firstJsx(sf: ts.SourceFile): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (isJsxExpressionRoot(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

type JsxRoot = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

function isJsxExpressionRoot(node: ts.Node): node is JsxRoot {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

/** A file's text with its JSX lowered, and the way back from a position of
 * that text to the source position it stands for. */
export interface LoweredJsx {
  text: string;
  /** A rewritten-text offset as an offset of the original text: copied text
   * keeps its offset; emitted call text maps to the JSX it stands for. */
  originalPosition(pos: number): number;
  /** An original-text offset in the rewritten text: copied text keeps its
   * offset; a position inside replaced JSX maps to the call text emitted
   * for the JSX at or before it (its end, for the `end` of a span). */
  rewrittenPosition(pos: number, end: boolean): number;
}

/** The file's text with its JSX replaced by the calls TypeScript emits for
 * the plan, and for the automatic runtime the imports of the runtime
 * functions those calls use. */
export function lowerJsx(sf: ts.SourceFile, plan: JsxEmitPlan): LoweredJsx {
  return new JsxRewriter(sf, plan).file();
}

/** A run of rewritten text: `copied` text starts at `original`; emitted
 * text stands for the source position `original`. */
interface Segment {
  rewritten: number;
  original: number;
  /** The copied length, 0 for emitted text. */
  copied: number;
}

class JsxRewriter {
  private readonly text: string;
  /** Output pieces; `cursor` is the source position whose line breaks the
   * output has reached. */
  private readonly pieces: string[] = [];
  private readonly segments: Segment[] = [];
  private length = 0;
  private cursor = 0;

  constructor(
    private readonly sf: ts.SourceFile,
    private readonly plan: JsxEmitPlan,
  ) {
    this.text = sf.text;
  }

  file(): LoweredJsx {
    const insertAt = this.plan.runtime === "automatic" ? this.prologueEnd() : -1;
    this.copy(0, this.text.length);
    if (insertAt >= 0) this.insertImports(insertAt);
    const segments = this.segments;
    const total = this.length;
    return {
      text: this.pieces.join(""),
      originalPosition: (pos: number): number => {
        let low = 0;
        let high = segments.length - 1;
        while (low < high) {
          const mid = (low + high + 1) >> 1;
          if (segments[mid]!.rewritten <= pos) low = mid;
          else high = mid - 1;
        }
        const segment = segments[low];
        if (segment === undefined) return pos;
        return segment.copied > 0
          ? segment.original + Math.min(pos - segment.rewritten, segment.copied)
          : segment.original;
      },
      rewrittenPosition: (pos: number, end: boolean): number => {
        // Segments are in source order: the last one starting at or before
        // `pos` holds it, or is the emitted text for the JSX holding it.
        let low = 0;
        let high = segments.length - 1;
        while (low < high) {
          const mid = (low + high + 1) >> 1;
          if (segments[mid]!.original <= pos) low = mid;
          else high = mid - 1;
        }
        const segment = segments[low];
        if (segment === undefined) return pos;
        if (segment.copied > 0)
          return segment.rewritten + Math.min(pos - segment.original, segment.copied);
        return end ? (segments[low + 1]?.rewritten ?? total) : segment.rewritten;
      },
    };
  }

  /** Local names of the automatic runtime's functions, by module and
   * export, in the order of first use (TypeScript's implicit imports). */
  private readonly imports = new Map<string, Map<string, string>>();
  private names: Set<string> | null = null;
  private fileNameLocal: string | null = null;

  /** The local name bound to `name` of `module`: `_name`, or `_name_1`,
   * `_name_2`, ... past an identifier the file already uses. */
  private importName(name: string, module: string): string {
    let names = this.imports.get(module);
    if (names === undefined) {
      names = new Map();
      this.imports.set(module, names);
    }
    let local = names.get(name);
    if (local === undefined) {
      local = this.uniqueName(`_${name}`);
      names.set(name, local);
    }
    return local;
  }

  private uniqueName(base: string): string {
    if (this.names === null) {
      const names = new Set<string>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) names.add(node.text);
        ts.forEachChild(node, visit);
      };
      visit(this.sf);
      this.names = names;
    }
    let name = base;
    for (let i = 1; this.names.has(name); i++) name = `${base}_${i}`;
    this.names.add(name);
    return name;
  }

  /** Where the runtime imports go: after the leading "use strict"-style
   * directives, else before the first statement, so the inserted text
   * shares that statement's line. */
  private prologueEnd(): number {
    const statements = this.sf.statements.nodes;
    let end = -1;
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      end = statement.end;
    }
    if (end >= 0) return end;
    const first = statements[0];
    return first === undefined ? this.text.length : first.getStart(this.sf);
  }

  /** Inserts the imports (or, in a CommonJS file, the requires) of the
   * runtime functions the file's JSX used, and react-jsxdev's file name
   * constant, at `at`: imports in the reverse order of their modules' first
   * use, as TypeScript inserts each after the prologue. */
  private insertImports(at: number): void {
    if (this.imports.size === 0 && this.fileNameLocal === null) return;
    const esm = ts.isExternalModule(this.sf);
    const parts: string[] = [];
    for (const [module, names] of [...this.imports].reverse()) {
      const specifier = JSON.stringify(module);
      if (esm) {
        const list = [...names].map(([name, local]) => `${name} as ${local}`).join(", ");
        parts.push(`import { ${list} } from ${specifier};`);
      } else if (/\.[cm]?jsx?$/.test(this.sf.fileName)) {
        const list = [...names].map(([name, local]) => `${name}: ${local}`).join(", ");
        parts.push(`const { ${list} } = require(${specifier});`);
      }
    }
    if (this.fileNameLocal !== null)
      parts.push(`const ${this.fileNameLocal} = ${JSON.stringify(this.sf.fileName)};`);
    if (parts.length === 0) return;
    const text = `${parts.join(" ")} `;
    let index = 0;
    let rewritten = 0;
    for (; index < this.segments.length; index++) {
      const segment = this.segments[index]!;
      if (segment.copied > 0 && segment.original <= at && at <= segment.original + segment.copied) {
        rewritten = segment.rewritten + (at - segment.original);
        break;
      }
    }
    // Split the copied segment holding `at` and shift what follows.
    const holder = this.segments[index];
    const joined = this.pieces.join("");
    this.pieces.length = 0;
    this.pieces.push(joined.slice(0, rewritten), text, joined.slice(rewritten));
    const following: Segment[] = [{ rewritten, original: at, copied: 0 }];
    if (holder !== undefined && holder.copied > 0) {
      const head = at - holder.original;
      const tail = holder.copied - head;
      holder.copied = head;
      if (tail > 0)
        following.push({ rewritten: rewritten + text.length, original: at, copied: tail });
    }
    for (let i = index + 1; i < this.segments.length; i++)
      this.segments[i]!.rewritten += text.length;
    this.segments.splice(index + 1, 0, ...following);
    if (holder !== undefined && holder.copied === 0) this.segments.splice(index, 1);
    this.length += text.length;
  }

  /** Emits source text [start, end) unchanged. */
  private copied(start: number, end: number): void {
    if (end <= start) return;
    this.segments.push({ rewritten: this.length, original: start, copied: end - start });
    this.pieces.push(this.text.slice(start, end));
    this.length += end - start;
  }

  /** Emits call text standing for the source position the cursor reached. */
  private emit(...texts: string[]): void {
    for (const text of texts) {
      if (text.length === 0) continue;
      const last = this.segments[this.segments.length - 1];
      if (last === undefined || last.copied > 0 || last.original !== this.cursor)
        this.segments.push({ rewritten: this.length, original: this.cursor, copied: 0 });
      this.pieces.push(text);
      this.length += text.length;
    }
  }

  /** Copies the source range [start, end), with its JSX expressions
   * replaced. */
  private copy(start: number, end: number): void {
    let at = start;
    const visit = (node: ts.Node): void => {
      if (node.end <= at || (node !== this.sf && node.getStart(this.sf) >= end)) return;
      if (isJsxExpressionRoot(node)) {
        const nodeStart = node.getStart(this.sf);
        this.copied(at, nodeStart);
        if (nodeStart > this.cursor) this.cursor = nodeStart;
        this.element(node);
        this.sync(node.end);
        at = node.end;
        return;
      }
      ts.forEachChild(node, visit);
    };
    // The cursor never moves back: a range copied after source that follows
    // it (jsx()'s key argument, after the children) emits no line break
    // twice.
    if (start > this.cursor) this.cursor = start;
    visit(this.enclosing(start, end));
    this.copied(at, end);
    if (end > this.cursor) this.cursor = end;
  }

  /** The smallest node around [start, end) whose children cover it. */
  private enclosing(start: number, end: number): ts.Node {
    let node: ts.Node = this.sf;
    for (;;) {
      let next: ts.Node | undefined;
      ts.forEachChild(node, (child) => {
        if (next === undefined && child.pos <= start && child.end >= end) next = child;
      });
      if (next === undefined || next === node) return node;
      node = next;
    }
  }

  /** Emits the line breaks of the source between the cursor and `pos`. */
  private sync(pos: number): void {
    for (let i = this.cursor; i < pos; i++) {
      const ch = this.text.charCodeAt(i);
      if (ch === 13 && this.text.charCodeAt(i + 1) === 10) {
        this.cursor = i;
        this.emit("\r\n");
        i++;
      } else if (isLineBreak(ch)) {
        this.cursor = i;
        this.emit(this.text[i]!);
      }
    }
    if (pos > this.cursor) this.cursor = pos;
  }

  /** Copies an expression in a JSX expression's place. */
  private expression(node: ts.Node): void {
    const start = node.getStart(this.sf);
    this.sync(start);
    this.copy(start, node.end);
  }

  private element(node: JsxRoot): void {
    const plan = this.plan;
    if (plan.runtime === "classic") {
      this.createElement(node, plan.factory, plan.fragment);
      return;
    }
    const opening = ts.isJsxFragment(node)
      ? null
      : ts.isJsxElement(node)
        ? node.openingElement
        : node;
    if (opening !== null && hasKeyAfterPropsSpread(opening.attributes)) {
      // A key after a spread of props is not jsx()'s key argument: the
      // element is the import source's createElement call.
      this.createElement(node, this.importName("createElement", plan.importSource), "");
      return;
    }
    this.automaticElement(node, opening, plan.importSource, plan.development);
  }

  /** The classic-runtime call: `factory(tag, props or null, ...children)`. */
  private createElement(node: JsxRoot, factory: string, fragment: string): void {
    const children = ts.isJsxSelfClosingElement(node) ? [] : node.children.nodes;
    if (ts.isJsxFragment(node)) {
      this.emit(`${factory}(${fragment}, null`);
    } else {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      this.emit(`${factory}(`);
      this.tagName(opening.tagName);
      this.emit(", ");
      this.attributes(opening.attributes.properties.nodes, null);
    }
    for (const child of children) {
      if (ts.isJsxText(child)) {
        const value = jsxTextValue(child.text);
        if (value === undefined) continue;
        this.emit(", ");
        this.sync(child.getStart(this.sf));
        this.emit(JSON.stringify(value));
      } else if (ts.isJsxExpression(child)) {
        if (child.expression === undefined) continue;
        this.emit(", ");
        if (child.dotDotDotToken !== undefined) this.emit("...");
        this.expression(child.expression);
      } else if (isJsxExpressionRoot(child)) {
        this.emit(", ");
        this.sync(child.getStart(this.sf));
        this.element(child);
      }
      this.sync(child.end);
    }
    this.sync(node.end);
    this.emit(")");
  }

  /** The automatic-runtime call: `jsx(tag, props[, key])` with the
   * children in props, `jsxs` for more than one child or a spread child, and
   * react-jsxdev's `jsxDEV(tag, props, key, isStatic, source, self)`. */
  private automaticElement(
    node: JsxRoot,
    opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null,
    importSource: string,
    development: boolean,
  ): void {
    const children: readonly ts.JsxChild[] = ts.isJsxSelfClosingElement(node)
      ? []
      : node.children.nodes;
    const semantic = children.filter(isSemanticJsxChild);
    const first = semantic[0];
    const isStatic =
      semantic.length > 1 ||
      (first !== undefined && ts.isJsxExpression(first) && first.dotDotDotToken !== undefined);
    const module = `${importSource}/${development ? "jsx-dev-runtime" : "jsx-runtime"}`;
    this.emit(`${this.importName(development ? "jsxDEV" : isStatic ? "jsxs" : "jsx", module)}(`);
    // TypeScript's children prop: the one semantic child itself, else an
    // array of every child that emits a value.
    const single = semantic.length === 1 && !isStatic ? first! : null;
    const listed = single === null ? children.filter((child) => jsxChildEmits(child)) : [];
    const childrenProp =
      children.length > 0 && (single !== null ? jsxChildEmits(single) : listed.length > 0)
        ? (): void => {
            this.emit("children: ");
            if (single !== null) {
              this.child(single);
            } else {
              this.emit("[");
              listed.forEach((child, index) => {
                if (index > 0) this.emit(", ");
                this.child(child);
                this.sync(child.end);
              });
              this.emit("]");
            }
          }
        : null;
    let key: ts.JsxAttribute | undefined;
    if (opening === null) {
      this.emit(this.importName("Fragment", module), ", ");
      if (childrenProp === null) this.emit("{}");
      else this.attributes([], childrenProp);
    } else {
      this.tagName(opening.tagName);
      this.emit(", ");
      const properties = opening.attributes.properties.nodes;
      key = properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "key",
      );
      const attributes = properties.filter((property) => property !== key);
      if (attributes.length === 0 && childrenProp === null) this.emit("{}");
      else this.attributes(attributes, childrenProp);
    }
    if (key !== undefined) {
      this.emit(", ");
      this.attributeValue(key.initializer);
    }
    if (development) {
      if (key === undefined) this.emit(", void 0");
      const { line, column } = lineAndColumn(this.text, node.pos);
      this.fileNameLocal ??= this.uniqueName("_jsxFileName");
      this.emit(
        `, ${isStatic}, { fileName: ${this.fileNameLocal}, lineNumber: ${line}, columnNumber: ${column} }, `,
        jsxSelf(node),
      );
    }
    this.sync(node.end);
    this.emit(")");
  }

  /** A child's value in the children prop (it emits one: jsxChildEmits). */
  private child(child: ts.JsxChild): void {
    if (ts.isJsxText(child)) {
      this.sync(child.getStart(this.sf));
      this.emit(JSON.stringify(jsxTextValue(child.text)!));
    } else if (ts.isJsxExpression(child)) {
      if (child.dotDotDotToken !== undefined) this.emit("...");
      this.expression(child.expression!);
    } else {
      this.sync(child.getStart(this.sf));
      this.element(child as JsxRoot);
    }
  }

  private tagName(tag: ts.JsxTagNameExpression): void {
    this.sync(tag.getStart(this.sf));
    if (ts.isIdentifier(tag) && isIntrinsicJsxName(tag.text)) {
      this.emit(JSON.stringify(tag.text));
    } else if (ts.isJsxNamespacedName(tag)) {
      this.emit(JSON.stringify(`${tag.namespace.text}:${tag.name.text}`));
    } else {
      this.emit(this.text.slice(tag.getStart(this.sf), tag.end));
    }
    this.cursor = tag.end;
  }

  /** The props object of `properties`, then `children` (the automatic
   * runtime's children prop), or `null` for no properties and no children
   * prop. */
  private attributes(
    properties: readonly ts.JsxAttributeLike[],
    children: (() => void) | null,
  ): void {
    if (properties.length === 0 && children === null) {
      this.emit("null");
      return;
    }
    if (properties.length === 0) {
      this.emit("{ ");
      children!();
      this.emit(" }");
      return;
    }
    this.emit("{ ");
    let first = true;
    const separate = (): void => {
      if (!first) this.emit(", ");
      first = false;
    };
    for (const attribute of properties) {
      if (ts.isJsxSpreadAttribute(attribute)) {
        const value = attribute.expression;
        if (ts.isObjectLiteralExpression(value) && !hasProtoProperty(value)) {
          // TypeScript inlines the properties of a spread object literal.
          for (const property of value.properties.nodes) {
            separate();
            this.expression(property);
          }
        } else {
          separate();
          this.emit("...");
          this.expression(value);
        }
      } else {
        separate();
        this.sync(attribute.getStart(this.sf));
        this.emit(attributeName(attribute.name), ": ");
        this.attributeValue(attribute.initializer);
      }
      this.sync(attribute.end);
    }
    if (children !== null) {
      this.emit(", ");
      children();
    }
    this.emit(" }");
  }

  private attributeValue(value: ts.JsxAttributeValue | undefined): void {
    if (value === undefined) {
      this.emit("true");
    } else if (ts.isStringLiteral(value)) {
      this.sync(value.getStart(this.sf));
      this.emit(JSON.stringify(decodeEntities(value.text)));
    } else if (ts.isJsxExpression(value)) {
      if (value.expression === undefined) this.emit("true");
      else this.expression(value.expression);
    } else {
      this.sync(value.getStart(this.sf));
      this.element(value as JsxRoot);
    }
  }
}

/** A child TypeScript counts: an expression container with an expression,
 * text that is not only white space spanning lines, or an element. */
function isSemanticJsxChild(child: ts.JsxChild): boolean {
  if (ts.isJsxExpression(child)) return child.expression !== undefined;
  if (ts.isJsxText(child)) return !child.containsOnlyTriviaWhiteSpaces;
  return true;
}

/** True when the child emits a value (text that trims to nothing and empty
 * expression containers emit none). */
function jsxChildEmits(child: ts.JsxChild): boolean {
  if (ts.isJsxText(child)) return jsxTextValue(child.text) !== undefined;
  if (ts.isJsxExpression(child)) return child.expression !== undefined;
  return true;
}

/** A `key` attribute after a spread that is not an object literal free of
 * spreads: TypeScript emits createElement for such an element. */
function hasKeyAfterPropsSpread(attributes: ts.JsxAttributes): boolean {
  let spread = false;
  for (const property of attributes.properties.nodes) {
    if (
      ts.isJsxSpreadAttribute(property) &&
      (!ts.isObjectLiteralExpression(property.expression) ||
        property.expression.properties.nodes.some((p: ts.ObjectLiteralElementLike) =>
          ts.isSpreadAssignment(p),
        ))
    ) {
      spread = true;
    } else if (
      spread &&
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "key"
    ) {
      return true;
    }
  }
  return false;
}

/** The 1-based line and column of `pos`, counting the line breaks
 * TypeScript counts (\r\n, \n, \r, U+2028, U+2029) and UTF-16 units. */
function lineAndColumn(text: string, pos: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < pos; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13 && text.charCodeAt(i + 1) === 10) continue;
    if (isLineBreak(ch)) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: pos - start + 1 };
}

/** react-jsxdev's `self` argument. TypeScript passes `this`; where `this`
 * has no declared type (the top level of an ES module and a function that is
 * not a method and declares no `this` parameter) the argument is the
 * `undefined` such code observes when called without a receiver, since an
 * untyped `this` does not type-check under noImplicitThis. */
function jsxSelf(node: ts.Node): string {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isArrowFunction(at)) continue;
    if (
      ts.isMethodDeclaration(at) ||
      ts.isConstructorDeclaration(at) ||
      ts.isGetAccessorDeclaration(at) ||
      ts.isSetAccessorDeclaration(at) ||
      ts.isPropertyDeclaration(at) ||
      ts.isClassStaticBlockDeclaration(at)
    )
      return "this";
    if (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at)) {
      const declaresThis = at.parameters.nodes.some(
        (parameter: ts.ParameterDeclaration) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === "this",
      );
      const objectMethod =
        ts.isFunctionExpression(at) &&
        at.parent !== undefined &&
        ts.isPropertyAssignment(at.parent);
      return declaresThis || objectMethod ? "this" : "undefined";
    }
    if (ts.isSourceFile(at)) return ts.isExternalModule(at) ? "undefined" : "this";
  }
  return "undefined";
}

/** TypeScript's intrinsic-element test: a lowercase first letter or a dash. */
function isIntrinsicJsxName(name: string): boolean {
  const ch = name.charCodeAt(0);
  return (ch >= 97 && ch <= 122) || name.includes("-");
}

function attributeName(name: ts.JsxAttributeName): string {
  if (ts.isJsxNamespacedName(name))
    return JSON.stringify(`${name.namespace.text}:${name.name.text}`);
  return /^[A-Z_]\w*$/i.test(name.text) ? name.text : JSON.stringify(name.text);
}

function hasProtoProperty(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.nodes.some(
    (property: ts.ObjectLiteralElementLike) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === "__proto__") ||
        (ts.isStringLiteral(property.name) && property.name.text === "__proto__")),
  );
}

/** A JSX text child's string value: each line trimmed (the first line keeps
 * its leading and the last line its trailing white space), lines without
 * text dropped, the rest joined with one space and entities decoded.
 * Undefined when nothing remains. */
export function jsxTextValue(text: string): string | undefined {
  let value: string | undefined;
  let firstNonWhitespace = 0;
  let lastNonWhitespace = -1;
  const add = (line: string): void => {
    const decoded = decodeEntities(line);
    value = value === undefined ? decoded : `${value} ${decoded}`;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (isLineBreak(ch)) {
      if (firstNonWhitespace !== -1 && lastNonWhitespace !== -1)
        add(text.slice(firstNonWhitespace, lastNonWhitespace + 1));
      firstNonWhitespace = -1;
    } else if (!isWhiteSpaceSingleLine(ch)) {
      lastNonWhitespace = i;
      if (firstNonWhitespace === -1) firstNonWhitespace = i;
    }
  }
  if (firstNonWhitespace !== -1) add(text.slice(firstNonWhitespace));
  return value;
}

/** Decodes `&name;`, `&#ddd;` and `&#xhh;` references. Unknown names and
 * numbers past U+10FFFF stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&((#((\d+)|x([\da-fA-F]+)))|(\w+));/g,
    (
      match: string,
      _all: string | undefined,
      _number: string | undefined,
      _digits: string | undefined,
      decimal: string | undefined,
      hex: string | undefined,
      word: string | undefined,
    ) => {
      const code = decimal
        ? parseInt(decimal, 10)
        : hex
          ? parseInt(hex, 16)
          : JSX_ENTITIES.get(word!);
      return code === undefined || code > 0x10ffff ? match : String.fromCodePoint(code);
    },
  );
}
