/* Finds the declarations a type patch selector names in one package file
 * and computes the text edits that apply the patch.
 *
 * Declaration files (and TypeScript sources) are matched on their syntax
 * tree: the edit replaces or widens a written type node. JavaScript is
 * matched on its JSDoc: the edit replaces or widens the `{...}` of a
 * `@typedef`'s `@property`, a `@returns`, a `@param` or a `@type` tag.
 * Executable code is never edited, and no edit adds or removes a line
 * break, so every later pass and diagnostic keeps its line. */

import * as ts from "../ts7/syntax.js";
import { tokenStartOfNode } from "../ts7/node-functions.js";
import {
  normalizeType,
  splitUnion,
  type Selector,
  type SelectorSegment,
  type TypePatchOp,
} from "./selector.js";

export interface PatchRequest {
  /** Caller's id, echoed in matches and problems. */
  id: number;
  selector: Selector;
  op: TypePatchOp;
}

export interface PatchMatch {
  id: number;
  /** 1-based line of the patched type. */
  line: number;
  before: string;
  after: string;
  /** The declaration already has the patched type: nothing was edited. */
  redundant: boolean;
}

export interface PatchProblem {
  id: number;
  message: string;
  /** Reported even when the selector matched elsewhere (an ambiguous
   * replacement left a declaration unpatched). */
  always?: true;
}

export interface PatchEdit {
  start: number;
  end: number;
  text: string;
}

export interface FilePatchResult {
  edits: PatchEdit[];
  matches: PatchMatch[];
  problems: PatchProblem[];
}

/** A place a type is (or can be) written. */
interface Slot {
  /** The written type's span, or null when there is none. */
  span: { start: number; end: number } | null;
  /** The declaration is optional (`x?:`, `[x]`), so it already admits
   * undefined. */
  optional: boolean;
  /** Where a replacement goes when nothing is written: the inserted text
   * is `prefix + type + suffix`. */
  insert: { at: number; prefix: string; suffix: string } | null;
  /** A JSDoc slot inside a comment (one-line edits only). */
  jsdoc: boolean;
  /** The type is an array element (`T[]`): a union must be wrapped. */
  wrap?: boolean;
}

type Step = { slots: Slot[] } | { problem: string };

/** Type texts that need parentheses before `| T` is appended. */
function needsParens(text: string): boolean {
  return /=>|\?|\bextends\b|^\s*new\b|^\s*function\b|^\s*!/.test(text);
}

function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function editsFor(
  text: string,
  req: PatchRequest,
  slot: Slot,
): { edits: PatchEdit[]; match: PatchMatch } | { problem: string } {
  const op = req.op;
  if (slot.span === null) {
    if (op.kind === "widen" || slot.insert === null)
      return {
        problem: `'${req.selector.text}' has no written type to widen; give the whole type instead`,
      };
    const ins = slot.insert;
    return {
      edits: [{ start: ins.at, end: ins.at, text: ins.prefix + op.text + ins.suffix }],
      match: {
        id: req.id,
        line: lineOf(text, ins.at),
        before: "(none)",
        after: op.text,
        redundant: false,
      },
    };
  }
  const { start, end } = slot.span;
  const original = text.slice(start, end);
  const line = lineOf(text, start);
  if (op.kind === "widen") {
    const present = new Set(splitUnion(original).map(normalizeType));
    if (slot.optional) present.add("undefined");
    const add = op.arms.filter((a) => !present.has(normalizeType(a)));
    if (add.length === 0)
      return {
        edits: [],
        match: { id: req.id, line, before: original, after: original, redundant: true },
      };
    // `(() => void) | undefined`; an array element wraps the whole union:
    // `(string | undefined)[]`.
    const inner = needsParens(original);
    const outer = slot.wrap === true;
    const suffix = ` | ${add.join(" | ")}`;
    const open = (outer ? "(" : "") + (inner ? "(" : "");
    const close = (inner ? ")" : "") + suffix + (outer ? ")" : "");
    const edits: PatchEdit[] =
      open === ""
        ? [{ start: end, end, text: close }]
        : [
            { start, end: start, text: open },
            { start: end, end, text: close },
          ];
    const after = `${open}${original}${close}`;
    return { edits, match: { id: req.id, line, before: original, after, redundant: false } };
  }
  if (normalizeType(original) === normalizeType(op.text))
    return {
      edits: [],
      match: { id: req.id, line, before: original, after: original, redundant: true },
    };
  const breaks = original.split("\n").length - 1;
  if (breaks > 0 && slot.jsdoc)
    return {
      problem: `'${req.selector.text}' names a JSDoc type that spans lines; replace it in one line upstream or widen it`,
    };
  const replacement =
    slot.wrap === true && (splitUnion(op.text).length > 1 || needsParens(op.text))
      ? `(${op.text})`
      : op.text;
  return {
    edits: [{ start, end, text: replacement + "\n".repeat(breaks) }],
    match: { id: req.id, line, before: original, after: replacement, redundant: false },
  };
}

/** Applies a file's requests. `sf` is the file's syntax tree, parsed as
 * TypeScript for declaration files and TypeScript sources and as
 * JavaScript otherwise. */
export function patchFile(
  relPath: string,
  text: string,
  sf: ts.SourceFile,
  requests: readonly PatchRequest[],
): FilePatchResult {
  const js = !/\.(d\.)?[mc]?ts$/.test(relPath);
  const resolver = js ? new JsResolver(text, sf) : new TsResolver(text, sf);
  const result: FilePatchResult = { edits: [], matches: [], problems: [] };
  for (const req of requests) {
    if (req.selector.file !== null && req.selector.file !== relPath) continue;
    const step = resolver.resolve(req.selector);
    if ("problem" in step) {
      result.problems.push({ id: req.id, message: step.problem });
      continue;
    }
    if (step.slots.length === 0) continue;
    if (req.op.kind === "replace" && step.slots.length > 1) {
      result.problems.push({
        id: req.id,
        message: `'${req.selector.text}' matches ${step.slots.length} declarations in ${relPath}; a replacement must name one (widen them, or replace the declaration file)`,
        always: true,
      });
      continue;
    }
    for (const slot of step.slots) {
      const out = editsFor(text, req, slot);
      if ("problem" in out) {
        result.problems.push({ id: req.id, message: out.problem });
        continue;
      }
      result.edits.push(...out.edits);
      result.matches.push(out.match);
    }
  }
  return result;
}

/** Applies edits (sorted by position; at one position, in request order).
 * An edit overlapping an earlier replacement is dropped. */
export function applyPatchEdits(text: string, edits: readonly PatchEdit[]): string {
  const sorted = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i)
    .map((x) => x.e);
  let out = "";
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) continue;
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

function nameText(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))
    return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

/* ── declaration files ─────────────────────────────────────────────── */

type TsPos = { node: ts.Node; optional: boolean; element?: boolean };

class TsResolver {
  /** Top-level declarations by name, ambient module bodies included. */
  private readonly roots = new Map<string, ts.Node[]>();
  private exportEquals: string | null = null;
  private exportDefault: ts.Node[] = [];

  constructor(
    private readonly text: string,
    sf: ts.SourceFile,
  ) {
    this.collect(sf.statements.nodes, true);
  }

  private collect(statements: readonly ts.Statement[], top: boolean): void {
    for (const s of statements) {
      if (ts.isExportAssignment(s)) {
        if (ts.isIdentifier(s.expression)) {
          if (s.isExportEquals) this.exportEquals = s.expression.text;
          else this.exportDefault.push(...this.rootsNamed(s.expression.text));
        }
        continue;
      }
      if (ts.isModuleDeclaration(s) && ts.isStringLiteral(s.name)) {
        // `declare module "pkg" { ... }`: its statements are the module's.
        if (top && s.body !== undefined && ts.isModuleBlock(s.body))
          this.collect(s.body.statements.nodes, false);
        continue;
      }
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations.nodes) this.add(nameText(d.name), d);
        continue;
      }
      const named =
        ts.isFunctionDeclaration(s) ||
        ts.isClassDeclaration(s) ||
        ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) ||
        ts.isModuleDeclaration(s) ||
        ts.isEnumDeclaration(s);
      if (!named) continue;
      this.add(nameText((s as ts.FunctionDeclaration).name), s);
      if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && hasDefaultModifier(s))
        this.exportDefault.push(s);
    }
  }

  private add(name: string | null, node: ts.Node): void {
    if (name === null) return;
    const list = this.roots.get(name);
    if (list === undefined) this.roots.set(name, [node]);
    else list.push(node);
  }

  private rootsNamed(name: string): ts.Node[] {
    return this.roots.get(name) ?? [];
  }

  resolve(sel: Selector): Step {
    let start: ts.Node[];
    if (sel.root === "export=")
      start = this.exportEquals === null ? [] : this.rootsNamed(this.exportEquals);
    else if (sel.root === "default") start = this.exportDefault;
    else start = this.rootsNamed(sel.root);
    let positions: TsPos[] = start.map((node) => ({ node, optional: false }));
    // A position that cannot continue is a problem only when no other
    // position of the same name matches (a function merged with a
    // namespace, an export and its declaration).
    let problem: string | null = null;
    for (const seg of sel.segments) {
      const next: TsPos[] = [];
      for (const pos of positions) {
        const step = this.step(pos, seg);
        if (typeof step === "string") problem ??= step;
        else next.push(...step);
      }
      positions = next;
      if (positions.length === 0)
        return problem === null ? { slots: [] } : { problem: `'${sel.text}' ${problem}` };
    }
    const slots: Slot[] = [];
    for (const pos of positions) {
      const slot = this.slotOf(pos);
      if (typeof slot === "string") problem ??= slot;
      else slots.push(slot);
    }
    if (slots.length === 0 && problem !== null) return { problem: `'${sel.text}' ${problem}` };
    return { slots };
  }

  private typeSlot(type: ts.TypeNode | undefined, optional: boolean): Slot {
    return {
      span: type === undefined ? null : { start: tokenStartOfNode(type), end: type.end },
      optional,
      insert: null,
      jsdoc: false,
    };
  }

  private slotOf(pos: TsPos): Slot | string {
    const n = pos.node;
    if (ts.isTypeNode(n)) return { ...this.typeSlot(n, pos.optional), wrap: pos.element === true };
    if (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n))
      return this.typeSlot(
        n.type,
        pos.optional || n.postfixToken?.kind === ts.SyntaxKind.QuestionToken,
      );
    if (
      ts.isVariableDeclaration(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isIndexSignatureDeclaration(n)
    )
      return this.typeSlot(n.type, false);
    if (ts.isParameter(n))
      return this.typeSlot(n.type, n.questionToken !== undefined || n.initializer !== undefined);
    if (ts.isGetAccessor(n)) return this.typeSlot(n.type, false);
    if (this.isFunctionLike(n))
      return "names a function; add '()' for its return type or '(name)' for a parameter";
    return "names a declaration without a type of its own; name one of its members";
  }

  private isFunctionLike(n: ts.Node): boolean {
    return (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodSignatureDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isCallSignatureDeclaration(n) ||
      ts.isFunctionTypeNode(n)
    );
  }

  /** The type a position stands for when a segment navigates into it. */
  private typeOf(n: ts.Node): ts.TypeNode | undefined {
    if (
      ts.isPropertySignature(n) ||
      ts.isPropertyDeclaration(n) ||
      ts.isVariableDeclaration(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isParameter(n)
    )
      return n.type;
    return undefined;
  }

  /** Object-like members a type node holds, following parentheses, unions,
   * intersections, `Promise<T>` and references to declarations in this
   * file. Null when it passes through a type it cannot follow. */
  private containers(type: ts.TypeNode, depth = 0): ts.Node[] | null {
    if (depth > 8) return null;
    if (ts.isTypeLiteralNode(type)) return [type];
    if (ts.isParenthesizedTypeNode(type)) return this.containers(type.type, depth + 1);
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
      const out: ts.Node[] = [];
      for (const arm of type.types.nodes) {
        if (arm.kind === ts.SyntaxKind.LiteralType || this.isKeywordType(arm)) continue;
        const c = this.containers(arm, depth + 1);
        if (c === null) return null;
        out.push(...c);
      }
      return out;
    }
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const name = type.typeName.text;
      const args = type.typeArguments?.nodes ?? [];
      if ((name === "Promise" || name === "PromiseLike") && args.length === 1)
        return this.containers(args[0]!, depth + 1);
      if (args.length > 0) return null;
      const decls = this.rootsNamed(name);
      if (decls.length === 0) return null;
      const out: ts.Node[] = [];
      for (const d of decls) {
        if (ts.isTypeAliasDeclaration(d)) {
          const c = this.containers(d.type, depth + 1);
          if (c === null) return null;
          out.push(...c);
        } else out.push(d);
      }
      return out;
    }
    return null;
  }

  private isKeywordType(n: ts.Node): boolean {
    return (
      n.kind === ts.SyntaxKind.NullKeyword ||
      n.kind === ts.SyntaxKind.UndefinedKeyword ||
      n.kind === ts.SyntaxKind.StringKeyword ||
      n.kind === ts.SyntaxKind.NumberKeyword ||
      n.kind === ts.SyntaxKind.BooleanKeyword
    );
  }

  private membersOf(n: ts.Node): readonly ts.Node[] | null {
    if (ts.isInterfaceDeclaration(n) || ts.isTypeLiteralNode(n) || ts.isClassDeclaration(n))
      return n.members.nodes;
    if (ts.isModuleDeclaration(n))
      return n.body !== undefined && ts.isModuleBlock(n.body) ? n.body.statements.nodes : [];
    return null;
  }

  /** Expands a position into the object-like nodes that hold members. */
  private holders(pos: TsPos): ts.Node[] | string {
    const n = pos.node;
    if (this.membersOf(n) !== null) return [n];
    if (ts.isTypeAliasDeclaration(n) || ts.isTypeNode(n) || this.typeOf(n) !== undefined) {
      const type = ts.isTypeNode(n) ? n : this.typeOf(n)!;
      const c = this.containers(type);
      if (c === null)
        return "passes through a type it cannot follow (a generic, mapped, conditional or imported type); name the declared type itself";
      return c;
    }
    if (ts.isFunctionDeclaration(n) || ts.isEnumDeclaration(n)) return [];
    return "has a member segment after a declaration without members";
  }

  private signaturesOf(pos: TsPos): ts.Node[] | string {
    const n = pos.node;
    if (this.isFunctionLike(n)) return [n];
    if (ts.isInterfaceDeclaration(n) || ts.isTypeLiteralNode(n))
      return n.members.nodes.filter((m) => ts.isCallSignatureDeclaration(m));
    const type = ts.isTypeNode(n) ? n : this.typeOf(n);
    if (type !== undefined) {
      let t: ts.TypeNode = type;
      while (ts.isParenthesizedTypeNode(t)) t = t.type;
      if (ts.isFunctionTypeNode(t)) return [t];
      const c = this.containers(t);
      if (c === null)
        return "passes through a type it cannot follow; name the declared type itself";
      return c.flatMap((h) =>
        ts.isInterfaceDeclaration(h) || ts.isTypeLiteralNode(h)
          ? h.members.nodes.filter((m) => ts.isCallSignatureDeclaration(m))
          : [],
      );
    }
    if (ts.isModuleDeclaration(n) || ts.isClassDeclaration(n)) return [];
    return "has '()' after a declaration that is not a function";
  }

  private step(pos: TsPos, seg: SelectorSegment): TsPos[] | string {
    switch (seg.kind) {
      case "member": {
        const holders = this.holders(pos);
        if (typeof holders === "string") return holders;
        const out: TsPos[] = [];
        for (const h of holders) {
          const members = this.membersOf(h) ?? [];
          for (const m of members) {
            if (ts.isVariableStatement(m)) {
              for (const d of m.declarationList.declarations.nodes)
                if (nameText(d.name) === seg.name) out.push({ node: d, optional: false });
              continue;
            }
            if (nameText((m as ts.PropertySignatureDeclaration).name) === seg.name)
              out.push({ node: m, optional: false });
          }
        }
        return out;
      }
      case "return":
      case "param": {
        const sigs = this.signaturesOf(pos);
        if (typeof sigs === "string") return sigs;
        const out: TsPos[] = [];
        for (const s of sigs) {
          const sig = s as ts.FunctionDeclaration;
          if (seg.kind === "return") {
            if (sig.type !== undefined) out.push({ node: sig.type, optional: false });
            else return "has no written return type";
          } else {
            for (const p of sig.parameters.nodes)
              if (nameText(p.name) === seg.name) out.push({ node: p, optional: false });
          }
        }
        return out;
      }
      case "element": {
        let t: ts.TypeNode | undefined = ts.isTypeNode(pos.node) ? pos.node : this.typeOf(pos.node);
        while (t !== undefined && ts.isParenthesizedTypeNode(t)) t = t.type;
        if (t !== undefined && ts.isArrayTypeNode(t))
          return [{ node: t.elementType, optional: false, element: true }];
        if (
          t !== undefined &&
          ts.isTypeReferenceNode(t) &&
          ts.isIdentifier(t.typeName) &&
          (t.typeName.text === "Array" || t.typeName.text === "ReadonlyArray") &&
          t.typeArguments?.nodes.length === 1
        )
          return [{ node: t.typeArguments.nodes[0]!, optional: false }];
        return "has '[]' after a type that is not an array";
      }
      case "index": {
        const holders = this.holders(pos);
        if (typeof holders === "string") return holders;
        const want =
          seg.key === "string" ? ts.SyntaxKind.StringKeyword : ts.SyntaxKind.NumberKeyword;
        const out: TsPos[] = [];
        for (const h of holders)
          for (const m of this.membersOf(h) ?? [])
            if (ts.isIndexSignatureDeclaration(m) && m.parameters.nodes[0]?.type?.kind === want)
              out.push({ node: m, optional: false });
        return out;
      }
    }
  }
}

/* ── JSDoc in JavaScript ───────────────────────────────────────────── */

interface JsDocTag {
  tag: string;
  /** Inner span of the `{...}` type, or null. */
  type: { start: number; end: number } | null;
  /** Parameter or property name (brackets and defaults removed). */
  name: string | null;
  optional: boolean;
  /** Offset of the `@`. */
  at: number;
}

interface JsDocComment {
  start: number;
  end: number;
  tags: JsDocTag[];
}

function parseJsDoc(text: string, start: number, end: number): JsDocComment {
  const tags: JsDocTag[] = [];
  const re = /(^|[\s*])@([A-Za-z]+)/g;
  re.lastIndex = start + 3;
  const body = text.slice(0, end - 2);
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const at = m.index + m[1]!.length;
    const tag = m[2]!;
    let i = at + 1 + tag.length;
    while (i < body.length && (body[i] === " " || body[i] === "\t")) i++;
    let type: JsDocTag["type"] = null;
    if (body[i] === "{") {
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= body.length) continue;
      type = { start: i + 1, end: j };
      // Trim the inner span to the type text.
      while (type.start < type.end && /\s/.test(text[type.start]!)) type.start++;
      while (type.end > type.start && /\s/.test(text[type.end - 1]!)) type.end--;
      i = j + 1;
      re.lastIndex = i;
    }
    let name: string | null = null;
    let optional = false;
    const rest = /^[ \t]*(\[)?[ \t]*([A-Za-z_$][\w$.]*)/.exec(body.slice(i, i + 200));
    if (rest !== null) {
      name = rest[2]!;
      optional = rest[1] !== undefined;
    }
    if (type !== null && text[type.end - 1] === "=") optional = true;
    tags.push({ tag, type, name, optional, at });
  }
  return { start, end, tags };
}

/** The spans of a file's string, template and regular expression literal
 * tokens. */
function literalSpans(sf: ts.SourceFile): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const kinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.RegularExpressionLiteral,
  ]);
  const visit = (n: ts.Node): void => {
    if (kinds.has(n.kind)) out.push({ start: tokenStartOfNode(n), end: n.end });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.start - b.start);
}

const RETURN_TAGS = new Set(["returns", "return"]);
const PROPERTY_TAGS = new Set(["property", "prop"]);

/** A declaration in JavaScript a selector can stand on. */
type JsPos =
  | { kind: "decl"; node: ts.Node; owner: ts.Node; fn: ts.Node | null; members: ts.Node | null }
  | { kind: "typedef"; comment: JsDocComment; tagIndex: number; prefix: string }
  | { kind: "slot"; slot: Slot };

class JsResolver {
  private readonly comments: JsDocComment[] = [];
  private readonly roots = new Map<string, JsPos[]>();
  private readonly exportEquals: JsPos[] = [];
  private readonly exportDefault: JsPos[] = [];

  constructor(
    private readonly text: string,
    sf: ts.SourceFile,
  ) {
    // JSDoc comments, not text inside string, template or regular
    // expression literals that looks like one.
    const literals = literalSpans(sf);
    const re = /\/\*\*(?!\/)[\s\S]*?\*\//g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const inside = literals.find((l) => l.start <= m!.index && m!.index < l.end);
      if (inside !== undefined) {
        re.lastIndex = inside.end;
        continue;
      }
      this.comments.push(parseJsDoc(text, m.index, m.index + m[0].length));
    }
    for (const c of this.comments)
      c.tags.forEach((t, i) => {
        if ((t.tag === "typedef" || t.tag === "callback") && t.name !== null)
          this.add(t.name, { kind: "typedef", comment: c, tagIndex: i, prefix: "" });
      });
    // Declarations first: `exports.name = name` may come before the
    // function declaration it exports, which is hoisted.
    for (const s of sf.statements.nodes) if (!ts.isExpressionStatement(s)) this.collect(s);
    for (const s of sf.statements.nodes) if (ts.isExpressionStatement(s)) this.collect(s);
  }

  private add(name: string, pos: JsPos): void {
    const list = this.roots.get(name);
    if (list === undefined) this.roots.set(name, [pos]);
    else list.push(pos);
  }

  /** The position of a declaration whose value is `value` (or none). */
  private declPos(node: ts.Node, owner: ts.Node, value: ts.Node | undefined): JsPos {
    let fn: ts.Node | null = null;
    let members: ts.Node | null = null;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) fn = node;
    else if (ts.isClassDeclaration(node)) members = node;
    if (value !== undefined) {
      let v = value;
      while (ts.isParenthesizedExpression(v)) v = v.expression;
      if (ts.isFunctionExpression(v) || ts.isArrowFunction(v)) fn = v;
      else if (ts.isClassExpression(v) || ts.isObjectLiteralExpression(v)) members = v;
    }
    return { kind: "decl", node, owner, fn, members };
  }

  private collect(s: ts.Statement): void {
    if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) {
      const pos = this.declPos(s, s, undefined);
      const name = nameText(s.name);
      if (name !== null) this.add(name, pos);
      if (hasDefaultModifier(s)) this.exportDefault.push(pos);
      return;
    }
    if (ts.isVariableStatement(s)) {
      const decls = s.declarationList.declarations.nodes;
      for (const d of decls) {
        const name = nameText(d.name);
        if (name !== null)
          this.add(name, this.declPos(d, decls.length === 1 ? s : d, d.initializer));
      }
      return;
    }
    if (ts.isExportAssignment(s)) {
      if (!s.isExportEquals) this.exportDefault.push(this.declPos(s, s, s.expression));
      return;
    }
    if (!ts.isExpressionStatement(s)) return;
    const e = s.expression;
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const target = exportTarget(e.left);
    if (target === null) return;
    if (target === "export=") {
      this.exportEquals.push(this.declPos(s, s, e.right));
      // `module.exports = name`: the named declaration is the export.
      if (ts.isIdentifier(e.right)) {
        const named = this.roots.get(e.right.text);
        if (named !== undefined) this.exportEquals.push(...named);
      }
    } else if (ts.isIdentifier(e.right) && this.roots.has(e.right.text)) {
      // `exports.name = local`: the named declaration is the export (and
      // already is under its own name).
      if (target !== e.right.text)
        for (const pos of [...this.roots.get(e.right.text)!])
          if (pos.kind === "decl") this.add(target, pos);
    } else this.add(target, this.declPos(s, s, e.right));
  }

  /** The last JSDoc comment directly before a node's first token. */
  private docOf(owner: ts.Node): JsDocComment | null {
    const start = tokenStartOfNode(owner);
    for (let i = this.comments.length - 1; i >= 0; i--) {
      const c = this.comments[i]!;
      if (c.end > start) continue;
      return /^\s*$/.test(this.text.slice(c.end, start)) ? c : null;
    }
    return null;
  }

  /** Tags of a comment that belong to the declaration it documents, not
   * to a `@typedef` or `@callback` block inside it. */
  private ownTags(c: JsDocComment): JsDocTag[] {
    const out: JsDocTag[] = [];
    let inBlock = false;
    for (const t of c.tags) {
      if (t.tag === "typedef" || t.tag === "callback") {
        inBlock = true;
        continue;
      }
      if (inBlock && (PROPERTY_TAGS.has(t.tag) || t.tag === "type")) continue;
      if (inBlock && t.tag !== "param" && !RETURN_TAGS.has(t.tag)) inBlock = false;
      if (inBlock) continue;
      out.push(t);
    }
    return out;
  }

  private tagSlot(tag: JsDocTag): Slot {
    return { span: tag.type, optional: tag.optional, insert: null, jsdoc: true };
  }

  /** A slot for a tag of the declaration `owner` documents; when it has no
   * such tag, a replacement inserts one. */
  private docSlot(owner: ts.Node, tagNames: ReadonlySet<string>, name: string | null): Slot {
    const doc = this.docOf(owner);
    if (doc !== null) {
      const tag = this.ownTags(doc).find(
        (t) => tagNames.has(t.tag) && (name === null || t.name === name),
      );
      if (tag !== undefined && tag.type !== null) return this.tagSlot(tag);
    }
    const tagName = [...tagNames][0]!;
    const named = name === null ? "" : ` ${name}`;
    if (doc !== null) {
      const at = doc.end - 2;
      const pad = /\s/.test(this.text[at - 1] ?? "") ? "" : " ";
      return {
        span: null,
        optional: false,
        insert: { at, prefix: `${pad}@${tagName} {`, suffix: `}${named} ` },
        jsdoc: true,
      };
    }
    return {
      span: null,
      optional: false,
      insert: { at: tokenStartOfNode(owner), prefix: `/** @${tagName} {`, suffix: `}${named} */ ` },
      jsdoc: true,
    };
  }

  resolve(sel: Selector): Step {
    let positions: JsPos[];
    if (sel.root === "export=") positions = this.exportEquals;
    else if (sel.root === "default") positions = this.exportDefault;
    else positions = this.roots.get(sel.root) ?? [];
    let problem: string | null = null;
    for (const seg of sel.segments) {
      const next: JsPos[] = [];
      for (const pos of positions) {
        const step = this.step(pos, seg);
        if (typeof step === "string") problem ??= step;
        else next.push(...step);
      }
      positions = next;
      if (positions.length === 0)
        return problem === null ? { slots: [] } : { problem: `'${sel.text}' ${problem}` };
    }
    const slots: Slot[] = [];
    for (const pos of positions) {
      const slot = this.slotOf(pos);
      if (typeof slot === "string") problem ??= slot;
      else if (slot !== null) slots.push(slot);
    }
    if (slots.length === 0 && problem !== null) return { problem: `'${sel.text}' ${problem}` };
    return { slots };
  }

  private slotOf(pos: JsPos): Slot | string | null {
    if (pos.kind === "slot") return pos.slot;
    if (pos.kind === "typedef") {
      const own = pos.comment.tags[pos.tagIndex]!;
      if (pos.prefix === "") {
        // A typedef's own type: only when it is not the `object` that
        // its @property tags describe.
        const typeTag = this.typedefTypeTag(pos);
        if (typeTag === null || /^object$/i.test(this.text.slice(typeTag.start, typeTag.end)))
          return "names a @typedef of an object; name one of its properties";
        return { span: typeTag, optional: false, insert: null, jsdoc: true };
      }
      void own;
      return null;
    }
    if (pos.fn !== null && pos.members === null)
      return "names a function; add '()' for its return type or '(name)' for a parameter";
    if (pos.members !== null && !ts.isObjectLiteralExpression(pos.members))
      return "names a class; name one of its members";
    return this.docSlot(pos.owner, new Set(["type"]), null);
  }

  private typedefTypeTag(pos: {
    comment: JsDocComment;
    tagIndex: number;
  }): { start: number; end: number } | null {
    const tags = pos.comment.tags;
    const own = tags[pos.tagIndex]!;
    if (own.type !== null) return own.type;
    for (let i = pos.tagIndex + 1; i < tags.length; i++) {
      const t = tags[i]!;
      if (t.tag === "type") return t.type;
      if (!PROPERTY_TAGS.has(t.tag)) break;
    }
    return null;
  }

  private step(pos: JsPos, seg: SelectorSegment): JsPos[] | string {
    // A JSDoc type is not navigated (a nested @property path continues
    // from its typedef position instead).
    if (pos.kind === "slot") return [];
    if (pos.kind === "typedef") {
      const tags = pos.comment.tags;
      const own = tags[pos.tagIndex]!;
      if (own.tag === "callback") {
        if (seg.kind !== "return" && seg.kind !== "param")
          return "has a member segment after a @callback";
        for (let i = pos.tagIndex + 1; i < tags.length; i++) {
          const t = tags[i]!;
          if (t.tag === "typedef" || t.tag === "callback") break;
          if (
            seg.kind === "return"
              ? RETURN_TAGS.has(t.tag)
              : t.tag === "param" && t.name === seg.name
          )
            return t.type === null ? [] : [{ kind: "slot", slot: this.tagSlot(t) }];
        }
        return [];
      }
      if (seg.kind !== "member") return "can only name properties of a @typedef";
      const name = pos.prefix === "" ? seg.name : `${pos.prefix}.${seg.name}`;
      for (let i = pos.tagIndex + 1; i < tags.length; i++) {
        const t = tags[i]!;
        if (t.tag === "typedef" || t.tag === "callback") break;
        if (!PROPERTY_TAGS.has(t.tag) && t.tag !== "type") break;
        if (PROPERTY_TAGS.has(t.tag) && t.name === name && t.type !== null) {
          // A nested property path continues from here.
          return [
            { kind: "slot", slot: this.tagSlot(t) },
            { ...pos, prefix: name },
          ];
        }
      }
      return [];
    }
    switch (seg.kind) {
      case "return":
        if (pos.fn === null) return "has '()' after a declaration that is not a function";
        return [{ kind: "slot", slot: this.docSlot(this.docOwner(pos), RETURN_TAGS, null) }];
      case "param": {
        if (pos.fn === null) return "has '(name)' after a declaration that is not a function";
        const fn = pos.fn as ts.FunctionExpression;
        if (!fn.parameters.nodes.some((p) => nameText(p.name) === seg.name)) return [];
        return [
          { kind: "slot", slot: this.docSlot(this.docOwner(pos), new Set(["param"]), seg.name) },
        ];
      }
      case "member": {
        if (pos.members === null) return [];
        return this.membersNamed(pos.members, seg.name);
      }
      default:
        return "navigates into a JSDoc type; name the declared type itself";
    }
  }

  /** The node whose leading comment documents a declaration. */
  private docOwner(pos: { owner: ts.Node }): ts.Node {
    return pos.owner;
  }

  private membersNamed(holder: ts.Node, name: string): JsPos[] {
    const out: JsPos[] = [];
    if (ts.isObjectLiteralExpression(holder)) {
      for (const p of holder.properties.nodes) {
        if (nameText((p as ts.PropertyAssignment).name) !== name) continue;
        if (ts.isPropertyAssignment(p)) out.push(this.declPos(p, p, p.initializer));
        else if (ts.isMethodDeclaration(p)) out.push(this.declPos(p, p, undefined));
        // `{ parse }`: the declaration of that name.
        else if (ts.isShorthandPropertyAssignment(p)) out.push(...(this.roots.get(name) ?? []));
      }
      return out;
    }
    const cls = holder as ts.ClassDeclaration;
    for (const m of cls.members.nodes) {
      if (ts.isConstructorDeclaration(m) && m.body !== undefined) {
        // `this.name = value` in the constructor, documented by its comment.
        for (const s of m.body.statements.nodes) {
          if (!ts.isExpressionStatement(s) || !ts.isBinaryExpression(s.expression)) continue;
          const e = s.expression;
          if (
            e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(e.left) &&
            e.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
            nameText(e.left.name) === name
          )
            out.push(this.declPos(s, s, e.right));
        }
        continue;
      }
      if (nameText((m as ts.MethodDeclaration).name) !== name) continue;
      if (ts.isMethodDeclaration(m)) out.push(this.declPos(m, m, undefined));
      else if (ts.isPropertyDeclaration(m)) out.push(this.declPos(m, m, m.initializer));
      else if (ts.isGetAccessor(m))
        out.push({ kind: "decl", node: m, owner: m, fn: m, members: null });
    }
    return out;
  }
}

/** `module.exports` → "export="; `exports.x` / `module.exports.x` → "x". */
function exportTarget(left: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(left)) return null;
  const obj = left.expression;
  const prop = nameText(left.name);
  if (prop === null) return null;
  if (ts.isIdentifier(obj) && obj.text === "module" && prop === "exports") return "export=";
  if (ts.isIdentifier(obj) && obj.text === "exports") return prop;
  if (
    ts.isPropertyAccessExpression(obj) &&
    ts.isIdentifier(obj.expression) &&
    obj.expression.text === "module" &&
    nameText(obj.name) === "exports"
  )
    return prop;
  return null;
}
