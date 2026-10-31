/** Regex literals compiled to native matchers at build time.
 *
 * A regex literal whose pattern stays inside a common subset (literals,
 * classes and their escapes, `.`, anchors, word boundaries, greedy and lazy
 * quantifiers, alternation, capturing and non-capturing groups) gets a
 * specialized LLVM function next to its immortal template. The runtime calls
 * it in place of the bytecode engines for one-byte (ASCII) subjects; every
 * other subject, and every pattern outside the subset, keeps the interpreter.
 *
 * The generated code is a direct backtracking matcher over the pattern's
 * ECMAScript semantics: ordered alternation, RepeatMatcher's capture reset
 * at each iteration and its empty-iteration check, greedy-first and
 * lazy-first quantifiers. Choice points and the undo records of register
 * writes share one explicit stack; a failure pops the newest entry and
 * resumes there. Single-character loops count instead of pushing one entry
 * per character, and they push nothing when no continuation can start with
 * a character of their own class.
 *
 * Function contract (scr_runtime.h `ScrRegexMatcher`):
 * `i32 (ptr s, i32 len, i32 start, ptr capture)` searches the ASCII bytes
 * `s[0..len)` from `start` (one anchored attempt for sticky patterns) and,
 * on a match, stores `2 * ncap` pointers into `s` (NULL for unset captures)
 * and returns 1; it returns 0 when nothing matches. Called with a negative
 * `len`, it returns the capture count (whole match included) so the runtime
 * can check it against the compiled bytecode. */

import { InternalCompilerError } from "../../errors.js";

const ASCII = 128;
const INF = -1;
/** Larger patterns keep the interpreter (binary size). */
const MAX_NODES = 400;
const MAX_COUNT = 100000;

type CharSet = boolean[];

type AssertKind = "bol" | "bolm" | "eol" | "eolm" | "wordb" | "nwordb";

interface SetNode {
  kind: "set";
  set: CharSet;
}
interface SeqNode {
  kind: "seq";
  items: RxNode[];
}
interface AltNode {
  kind: "alt";
  alts: RxNode[];
}
interface CapNode {
  kind: "cap";
  index: number;
  body: RxNode;
}
interface RepNode {
  kind: "rep";
  body: RxNode;
  min: number;
  max: number;
  greedy: boolean;
  /** Capture groups inside the body: [capFirst, capEnd). */
  capFirst: number;
  capEnd: number;
}
interface AssertNode {
  kind: "assert";
  what: AssertKind;
}
type RxNode = SetNode | SeqNode | AltNode | CapNode | RepNode | AssertNode;

class RegexBail {
  constructor(readonly reason: string) {}
}

function bail(reason: string): never {
  throw new RegexBail(reason);
}

function emptySet(): CharSet {
  const s: CharSet = [];
  for (let c = 0; c < ASCII; c++) s.push(false);
  return s;
}

function addRange(s: CharSet, lo: number, hi: number): void {
  for (let c = lo < 0 ? 0 : lo; c <= hi && c < ASCII; c++) s[c] = true;
}

function unionInto(into: CharSet, from: CharSet): void {
  for (let c = 0; c < ASCII; c++) if (from[c]) into[c] = true;
}

function inverted(s: CharSet): CharSet {
  const out: CharSet = [];
  for (let c = 0; c < ASCII; c++) out.push(!s[c]);
  return out;
}

/** Canonicalize closure for ASCII members: with or without `u`, ASCII
 * letters fold only onto their other ASCII case. */
function caseClosed(s: CharSet): CharSet {
  const out = s.slice();
  for (let c = 65; c <= 90; c++) {
    if (s[c] || s[c + 32]) {
      out[c] = true;
      out[c + 32] = true;
    }
  }
  return out;
}

function sameSet(a: CharSet, b: CharSet): boolean {
  for (let c = 0; c < ASCII; c++) if (a[c] !== b[c]) return false;
  return true;
}

function setCount(s: CharSet): number {
  let n = 0;
  for (let c = 0; c < ASCII; c++) if (s[c]) n++;
  return n;
}

function disjoint(a: CharSet, b: CharSet): boolean {
  for (let c = 0; c < ASCII; c++) if (a[c] && b[c]) return false;
  return true;
}

function digitSet(): CharSet {
  const s = emptySet();
  addRange(s, 48, 57);
  return s;
}

function wordSet(): CharSet {
  const s = emptySet();
  addRange(s, 48, 57);
  addRange(s, 65, 90);
  addRange(s, 97, 122);
  s[95] = true;
  return s;
}

/** The ASCII members of WhiteSpace and LineTerminator. */
function spaceSet(): CharSet {
  const s = emptySet();
  addRange(s, 9, 13);
  s[32] = true;
  return s;
}

function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

const SYNTAX_CHARS = "^$\\.*+?()[]{}|/";

/** Parser for the supported subset. Anything else (lookaround, back
 * references, `\c`, `\p`, octal escapes, non-ASCII pattern text, Annex B
 * literal braces) bails, which keeps the interpreter for that literal. The
 * pattern already passed the TypeScript parser, and the runtime compiles
 * its bytecode (and reports its syntax errors) before any match runs. */
class RxParser {
  private i = 0;
  caps = 1;
  nodes = 0;

  constructor(
    private readonly src: string,
    private readonly unicode: boolean,
    private readonly fold: boolean,
    private readonly dotAll: boolean,
    private readonly multiline: boolean,
  ) {}

  parse(): RxNode {
    const node = this.disjunction();
    if (this.i !== this.src.length) bail("unbalanced");
    return node;
  }

  private code(): number {
    return this.i < this.src.length ? this.src.charCodeAt(this.i) : -1;
  }

  private ch(): string {
    return this.i < this.src.length ? this.src.charAt(this.i) : "";
  }

  private count(): void {
    if (++this.nodes > MAX_NODES) bail("too large");
  }

  private disjunction(): RxNode {
    const alts: RxNode[] = [this.alternative()];
    while (this.ch() === "|") {
      this.i++;
      alts.push(this.alternative());
    }
    this.count();
    return alts.length === 1 ? alts[0]! : { kind: "alt", alts };
  }

  private alternative(): RxNode {
    const items: RxNode[] = [];
    for (;;) {
      const c = this.ch();
      if (c === "" || c === "|" || c === ")") break;
      const assertion = this.assertion();
      if (assertion !== null) {
        if (this.quantifierAhead()) bail("quantified assertion");
        items.push(assertion);
        continue;
      }
      const capsBefore = this.caps;
      const atom = this.atom();
      const q = this.quantifier();
      if (q === null) {
        items.push(atom);
        continue;
      }
      this.count();
      items.push({
        kind: "rep",
        body: atom,
        min: q.min,
        max: q.max,
        greedy: q.greedy,
        capFirst: capsBefore,
        capEnd: this.caps,
      });
    }
    this.count();
    return items.length === 1 ? items[0]! : { kind: "seq", items };
  }

  private assertion(): AssertNode | null {
    const c = this.ch();
    let what: AssertKind | null = null;
    if (c === "^") {
      what = this.multiline ? "bolm" : "bol";
      this.i++;
    } else if (c === "$") {
      what = this.multiline ? "eolm" : "eol";
      this.i++;
    } else if (c === "\\" && this.i + 1 < this.src.length) {
      const n = this.src.charAt(this.i + 1);
      if (n === "b" || n === "B") {
        what = n === "b" ? "wordb" : "nwordb";
        this.i += 2;
      }
    }
    if (what === null) return null;
    this.count();
    return { kind: "assert", what };
  }

  private quantifierAhead(): boolean {
    const c = this.ch();
    return c === "*" || c === "+" || c === "?" || c === "{";
  }

  private number(): number {
    const start = this.i;
    let value = 0;
    while (isDigitCode(this.code())) {
      value = value * 10 + (this.code() - 48);
      if (value > MAX_COUNT) bail("large count");
      this.i++;
    }
    return this.i === start ? -1 : value;
  }

  private quantifier(): { min: number; max: number; greedy: boolean } | null {
    const c = this.ch();
    let min = 0;
    let max = INF;
    if (c === "*") {
      this.i++;
    } else if (c === "+") {
      min = 1;
      this.i++;
    } else if (c === "?") {
      max = 1;
      this.i++;
    } else if (c === "{") {
      const save = this.i;
      this.i++;
      const lo = this.number();
      if (lo < 0) {
        this.i = save;
        return null;
      }
      min = lo;
      max = lo;
      if (this.ch() === ",") {
        this.i++;
        if (this.ch() === "}") {
          max = INF;
        } else {
          const hi = this.number();
          if (hi < 0) {
            this.i = save;
            return null;
          }
          max = hi;
        }
      }
      if (this.ch() !== "}") {
        this.i = save;
        return null;
      }
      this.i++;
      if (max !== INF && min > max) bail("bad range");
    } else {
      return null;
    }
    let greedy = true;
    if (this.ch() === "?") {
      greedy = false;
      this.i++;
    }
    return { min, max, greedy };
  }

  private literal(code: number): SetNode {
    const set = emptySet();
    set[code] = true;
    return { kind: "set", set: this.fold ? caseClosed(set) : set };
  }

  private atom(): RxNode {
    this.count();
    const c = this.ch();
    const code = this.code();
    if (c === ".") {
      this.i++;
      const set = emptySet();
      addRange(set, 0, ASCII - 1);
      if (!this.dotAll) {
        set[10] = false;
        set[13] = false;
      }
      return { kind: "set", set };
    }
    if (c === "(") {
      this.i++;
      let index = -1;
      if (this.ch() === "?") {
        const n = this.i + 1 < this.src.length ? this.src.charAt(this.i + 1) : "";
        if (n === ":") {
          this.i += 2;
        } else if (n === "<") {
          const m = this.i + 2 < this.src.length ? this.src.charAt(this.i + 2) : "";
          if (m === "=" || m === "!") bail("lookbehind");
          this.i += 2;
          const nameStart = this.i;
          while (/[A-Za-z0-9_$]/.test(this.ch())) this.i++;
          if (this.i === nameStart || this.ch() !== ">") bail("group name");
          this.i++;
          index = this.caps++;
        } else {
          bail("group modifier or lookahead");
        }
      } else {
        index = this.caps++;
      }
      const body = this.disjunction();
      if (this.ch() !== ")") bail("unclosed group");
      this.i++;
      return index < 0 ? body : { kind: "cap", index, body };
    }
    if (c === "[") return this.charClass();
    if (c === "\\") return this.atomEscape();
    if (code < 0 || code >= ASCII) bail("non-ASCII pattern text");
    if ("*+?{".includes(c)) bail("nothing to repeat or literal brace");
    if (c === "}" || c === "]") bail("lone bracket");
    this.i++;
    return this.literal(code);
  }

  private classEscapeSet(c: string): CharSet | null {
    switch (c) {
      case "d":
        return digitSet();
      case "D":
        return inverted(digitSet());
      case "w":
        return wordSet();
      case "W":
        return inverted(wordSet());
      case "s":
        return spaceSet();
      case "S":
        return inverted(spaceSet());
      default:
        return null;
    }
  }

  /** The code unit of a character escape after `\` (the `\` consumed), or
   * bails. `inClass` admits `\b` (backspace) and `\-`. */
  private characterEscape(inClass: boolean): number {
    const c = this.ch();
    const code = this.code();
    this.i++;
    switch (c) {
      case "t":
        return 9;
      case "n":
        return 10;
      case "v":
        return 11;
      case "f":
        return 12;
      case "r":
        return 13;
      case "0":
        if (isDigitCode(this.code())) bail("octal escape");
        return 0;
      case "x": {
        const a = hexValue(this.code());
        const b = this.i + 1 < this.src.length ? hexValue(this.src.charCodeAt(this.i + 1)) : -1;
        if (a < 0 || b < 0) bail("Annex B \\x");
        this.i += 2;
        return a * 16 + b;
      }
      case "u": {
        let value = 0;
        for (let k = 0; k < 4; k++) {
          const h = this.i + k < this.src.length ? hexValue(this.src.charCodeAt(this.i + k)) : -1;
          if (h < 0) bail("\\u form");
          value = value * 16 + h;
        }
        this.i += 4;
        return value;
      }
      case "b":
        if (inClass) return 8;
        bail("unreachable \\b");
      case "-":
        if (inClass || !this.unicode) return 45;
        bail("\\- outside a class");
      default:
        break;
    }
    if (code < 0 || code >= ASCII) bail("non-ASCII escape");
    if (/[A-Za-z0-9_]/.test(c)) bail("escape letter or digit");
    if (this.unicode && !SYNTAX_CHARS.includes(c)) bail("u-mode identity escape");
    return code;
  }

  private atomEscape(): RxNode {
    this.i++;
    const set = this.classEscapeSet(this.ch());
    if (set !== null) {
      this.i++;
      return { kind: "set", set };
    }
    const code = this.characterEscape(false);
    if (code >= ASCII) bail("non-ASCII escape");
    return this.literal(code);
  }

  private charClass(): SetNode {
    this.i++;
    let negate = false;
    if (this.ch() === "^") {
      negate = true;
      this.i++;
    }
    const set = emptySet();
    for (;;) {
      const c = this.ch();
      if (c === "") bail("unclosed class");
      if (c === "]") {
        this.i++;
        break;
      }
      const first = this.classAtom();
      if (
        this.ch() === "-" &&
        this.i + 1 < this.src.length &&
        this.src.charAt(this.i + 1) !== "]"
      ) {
        this.i++;
        const second = this.classAtom();
        if (typeof first !== "number" || typeof second !== "number") bail("class escape range");
        if (first > second) bail("bad class range");
        if (this.fold && second >= ASCII) bail("non-ASCII folded range");
        addRange(set, first, second);
        continue;
      }
      if (typeof first === "number") {
        if (first < ASCII) set[first] = true;
        else if (this.fold) bail("non-ASCII folded member");
      } else {
        unionInto(set, first);
      }
    }
    const closed = this.fold ? caseClosed(set) : set;
    return { kind: "set", set: negate ? inverted(closed) : closed };
  }

  /** A class member: a code unit, or the set of a class escape. Non-ASCII
   * code units can only come from `\x`/`\u` escapes here. */
  private classAtom(): number | CharSet {
    const c = this.ch();
    const code = this.code();
    if (c !== "\\") {
      if (code < 0 || code >= ASCII) bail("non-ASCII class member");
      this.i++;
      return code;
    }
    this.i++;
    const set = this.classEscapeSet(this.ch());
    if (set !== null) {
      this.i++;
      return set;
    }
    if (this.ch() === "c") bail("\\c");
    return this.characterEscape(true);
  }
}

/** What can start a match from a point of the pattern. */
interface FirstInfo {
  set: CharSet;
  /** Some path reaches the end without consuming a character. */
  nullable: boolean;
  /** Some path passes a non-multiline `^` (matches only at 0). */
  bol: boolean;
  /** Some path reaches the end without consuming and without any
   * assertion or empty-iteration check that could fail. */
  uncond: boolean;
}

function firstOf(node: RxNode): FirstInfo {
  switch (node.kind) {
    case "set":
      return { set: node.set, nullable: false, bol: false, uncond: false };
    case "seq": {
      const acc: FirstInfo = { set: emptySet(), nullable: true, bol: false, uncond: true };
      for (const item of node.items) {
        const f = firstOf(item);
        unionInto(acc.set, f.set);
        if (f.bol) acc.bol = true;
        if (!f.nullable) {
          acc.nullable = false;
          acc.uncond = false;
          break;
        }
        if (!f.uncond) acc.uncond = false;
      }
      return acc;
    }
    case "alt": {
      const acc: FirstInfo = { set: emptySet(), nullable: false, bol: false, uncond: false };
      for (const alt of node.alts) {
        const f = firstOf(alt);
        unionInto(acc.set, f.set);
        if (f.nullable) acc.nullable = true;
        if (f.bol) acc.bol = true;
        if (f.uncond) acc.uncond = true;
      }
      return acc;
    }
    case "cap":
      return firstOf(node.body);
    case "rep": {
      if (node.max === 0) return { set: emptySet(), nullable: true, bol: false, uncond: true };
      const f = firstOf(node.body);
      return {
        set: f.set,
        nullable: node.min === 0 || f.nullable,
        bol: f.bol,
        uncond: node.min === 0 || f.uncond,
      };
    }
    case "assert":
      return node.what === "bol"
        ? { set: emptySet(), nullable: false, bol: true, uncond: false }
        : { set: emptySet(), nullable: true, bol: false, uncond: false };
  }
}

/** Positions the start filter tests and alternatives it keeps. */
const PREFIX_LENGTH = 8;
const PREFIX_ALTERNATIVES = 8;

/** The character sets a match's first characters must belong to: every
 * match of the node begins with the characters of some entry of `alts`,
 * one set per character. `complete` means every match is exactly as long as
 * its entry (so a following node continues the sequences). Null when the
 * node gives no usable condition (an alternative that can start with
 * anything, or too many alternatives). Assertions add no characters: the
 * result stays a necessary condition. */
interface Prefix {
  alts: CharSet[][];
  complete: boolean;
}

/** Each head followed by each tail, cut to PREFIX_LENGTH sets; null past
 * PREFIX_ALTERNATIVES entries. */
function crossPrefixes(heads: CharSet[][], tails: CharSet[][]): CharSet[][] | null {
  if (heads.length * tails.length > PREFIX_ALTERNATIVES) return null;
  const out: CharSet[][] = [];
  for (const head of heads)
    for (const tail of tails) out.push([...head, ...tail].slice(0, PREFIX_LENGTH));
  return out;
}

/** Whether no entry was cut at PREFIX_LENGTH. */
function uncut(alts: CharSet[][]): boolean {
  return alts.every((alt) => alt.length < PREFIX_LENGTH);
}

function prefixOf(node: RxNode): Prefix | null {
  switch (node.kind) {
    case "set":
      return { alts: [[node.set]], complete: true };
    case "assert":
      return { alts: [[]], complete: true };
    case "cap":
      return prefixOf(node.body);
    case "alt": {
      const alts: CharSet[][] = [];
      let complete = true;
      for (const alt of node.alts) {
        const p = prefixOf(alt);
        if (p === null) return null;
        alts.push(...p.alts);
        complete &&= p.complete;
      }
      return alts.length <= PREFIX_ALTERNATIVES ? { alts, complete } : null;
    }
    case "seq": {
      let alts: CharSet[][] = [[]];
      for (const item of node.items) {
        const p = prefixOf(item);
        if (p === null) return { alts, complete: false };
        const joined = crossPrefixes(alts, p.alts);
        if (joined === null) return { alts, complete: false };
        alts = joined;
        if (!p.complete || !uncut(alts)) return { alts, complete: false };
      }
      return { alts, complete: true };
    }
    case "rep": {
      if (node.max === 0) return { alts: [[]], complete: true };
      if (node.min === 0) return { alts: [[]], complete: false };
      const body = prefixOf(node.body);
      if (body === null) return null;
      // The first `min` iterations are required; they extend the sequences
      // while the body has a fixed length.
      let alts = body.alts;
      let covered = 1;
      while (covered < node.min && body.complete && uncut(alts)) {
        const joined = crossPrefixes(alts, body.alts);
        if (joined === null) break;
        alts = joined;
        covered++;
      }
      const complete =
        body.complete && covered === node.min && node.min === node.max && uncut(alts);
      return { alts, complete };
    }
  }
}

/** Whether a node can match without consuming (assertions included). */
function canMatchEmpty(node: RxNode): boolean {
  switch (node.kind) {
    case "set":
      return false;
    case "seq":
      return node.items.every(canMatchEmpty);
    case "alt":
      return node.alts.some(canMatchEmpty);
    case "cap":
      return canMatchEmpty(node.body);
    case "rep":
      return node.min === 0 || node.max === 0 || canMatchEmpty(node.body);
    case "assert":
      return true;
  }
}

/** `first` followed by `follow`. */
function thenFollow(first: FirstInfo, follow: FirstInfo): FirstInfo {
  if (!first.nullable) return { set: first.set, nullable: false, bol: first.bol, uncond: false };
  const set = first.set.slice();
  unionInto(set, follow.set);
  return {
    set,
    nullable: follow.nullable,
    bol: first.bol || follow.bol,
    uncond: first.uncond && follow.uncond,
  };
}

/** Inclusive code ranges of a set. */
function intervals(s: CharSet): number[][] {
  const out: number[][] = [];
  for (let c = 0; c < ASCII; c++) {
    if (!s[c]) continue;
    let e = c;
    while (e + 1 < ASCII && s[e + 1]) e++;
    out.push([c, e]);
    c = e;
  }
  return out;
}

/** Vector tests use at most this many range compares. */
const VECTOR_RANGES = 6;

function splat16(n: number): string {
  const parts: string[] = [];
  for (let k = 0; k < 16; k++) parts.push(`i8 ${n}`);
  return `<${parts.join(", ")}>`;
}

class RxGen {
  readonly body: string[] = [];
  private nTmp = 0;
  private nLabel = 0;
  /** Resume label of each stack entry kind, by id. */
  private readonly resumes: string[] = [];
  private readonly undoIds = new Map<number, number>();
  /** Register count: 2 * ncap capture slots, then loop registers. */
  regs: number;
  private readonly tables: CharSet[] = [];
  readonly globals: string[] = [];

  constructor(
    readonly sym: string,
    readonly ncap: number,
    /** 16-byte vector scans for long character runs. */
    readonly vector: boolean,
  ) {
    this.regs = 2 * ncap;
  }

  /** The compares of a vector membership test: the set's ranges, or its
   * complement's then negated (bytes >= 128 never occur), or null. */
  vectorPlan(set: CharSet): { ranges: number[][]; negate: boolean } | null {
    if (!this.vector) return null;
    const n = setCount(set);
    if (n === 0 || n === ASCII) return null;
    const direct = intervals(set),
      complement = intervals(inverted(set));
    if (direct.length <= complement.length && direct.length <= VECTOR_RANGES)
      return { ranges: direct, negate: false };
    if (complement.length <= VECTOR_RANGES) return { ranges: complement, negate: true };
    return null;
  }

  /** Membership of 16 code units at s[index..index+16): an i16 mask, bit
   * k set when s[index + k] is in the set. */
  testVector(plan: { ranges: number[][]; negate: boolean }, index: string): string {
    const wide = this.tmp(),
      at = this.tmp(),
      v = this.tmp();
    this.line(`${wide} = sext i32 ${index} to i64`);
    this.line(`${at} = getelementptr inbounds i8, ptr %s, i64 ${wide}`);
    this.line(`${v} = load <16 x i8>, ptr ${at}, align 1`);
    let acc = "";
    for (const [lo, hi] of plan.ranges) {
      const hit = this.tmp();
      if (lo === hi) {
        this.line(`${hit} = icmp eq <16 x i8> ${v}, ${splat16(lo!)}`);
      } else {
        const d = this.tmp();
        this.line(`${d} = sub <16 x i8> ${v}, ${splat16(lo!)}`);
        this.line(`${hit} = icmp ule <16 x i8> ${d}, ${splat16(hi! - lo!)}`);
      }
      if (acc === "") {
        acc = hit;
      } else {
        const both = this.tmp();
        this.line(`${both} = or <16 x i1> ${acc}, ${hit}`);
        acc = both;
      }
    }
    const bits = this.tmp();
    this.line(`${bits} = bitcast <16 x i1> ${acc} to i16`);
    if (!plan.negate) return bits;
    const flipped = this.tmp();
    this.line(`${flipped} = xor i16 ${bits}, -1`);
    return flipped;
  }

  /** Index of the lowest set bit of a nonzero i16 mask, as i32. */
  lowestBit(mask: string): string {
    const tz = this.tmp(),
      wide = this.tmp();
    this.line(`${tz} = call i16 @llvm.cttz.i16(i16 ${mask}, i1 true)`);
    this.line(`${wide} = zext i16 ${tz} to i32`);
    return wide;
  }

  /** The vector plans of a start filter (prefixOf): per alternative, the
   * plans of its first sets up to the first set without one. Null unless
   * every alternative keeps at least two positions, where the filter is
   * more selective than the first character alone. */
  prefixPlans(prefix: Prefix | null): { ranges: number[][]; negate: boolean }[][] | null {
    if (prefix === null || !this.vector) return null;
    const plans: { ranges: number[][]; negate: boolean }[][] = [];
    for (const alt of prefix.alts) {
      const row: { ranges: number[][]; negate: boolean }[] = [];
      for (const set of alt) {
        const plan = this.vectorPlan(set);
        if (plan === null) break;
        row.push(plan);
      }
      if (row.length < 2) return null;
      plans.push(row);
    }
    return plans.length === 0 ? null : plans;
  }

  /** Start positions s[index..index+16) where some alternative of the
   * filter matches its first sets: an i16 mask. */
  testPrefix(plans: { ranges: number[][]; negate: boolean }[][], index: string): string {
    let any = "";
    for (const row of plans) {
      let all = "";
      for (let k = 0; k < row.length; k++) {
        let at = index;
        if (k > 0) {
          at = this.tmp();
          this.line(`${at} = add i32 ${index}, ${k}`);
        }
        const bits = this.testVector(row[k]!, at);
        if (all === "") all = bits;
        else {
          const both = this.tmp();
          this.line(`${both} = and i16 ${all}, ${bits}`);
          all = both;
        }
      }
      if (any === "") any = all;
      else {
        const either = this.tmp();
        this.line(`${either} = or i16 ${any}, ${all}`);
        any = either;
      }
    }
    return any;
  }

  /** The first-character search: from %at, store the next position whose
   * character is in `set` and branch to %attempt, or branch to %nomatch.
   * With a start filter (`prefix`), the vector loop tests the filter's
   * first sets of each alternative at 16 start positions at once and stops
   * only where one of them matches all of its sets; a match can start
   * nowhere else, so the attempts that remain are the ones that can
   * succeed, in the same order. */
  emitSeek(set: CharSet, prefix: Prefix | null = null): void {
    this.block("seek");
    const a = this.tmp();
    this.line(`${a} = load i32, ptr %at`);
    const filter = this.prefixPlans(prefix);
    const plan = this.vectorPlan(set);
    // The filter reads s[i + reach + 15] at its farthest.
    const reach = filter === null ? 0 : Math.max(...filter.map((row) => row.length)) - 1;
    let from = "seek",
      start = a;
    if (plan !== null || filter !== null) {
      const head = this.label("vsh"),
        load = this.label("vsl"),
        next = this.label("vsn"),
        hit = this.label("vsx"),
        tail = this.label("vst");
      this.line(`br label %${head}`);
      this.block(head);
      const i = this.tmp(),
        i16 = this.tmp(),
        rest = this.tmp(),
        fits = this.tmp();
      this.line(`${i} = phi i32 [ ${a}, %seek ], [ ${i16}, %${next} ]`);
      // The characters left (0 <= i <= len, so this cannot wrap; i + 16
      // can for subjects near 2^31 characters).
      this.line(`${rest} = sub i32 %len, ${i}`);
      this.line(`${fits} = icmp sge i32 ${rest}, ${16 + reach}`);
      this.line(`br i1 ${fits}, label %${load}, label %${tail}`);
      this.block(load);
      const mask = filter !== null ? this.testPrefix(filter, i) : this.testVector(plan!, i),
        any = this.tmp();
      this.line(`${any} = icmp ne i16 ${mask}, 0`);
      this.line(`br i1 ${any}, label %${hit}, label %${next}`);
      this.block(next);
      this.line(`${i16} = add i32 ${i}, 16`);
      this.line(`br label %${head}`);
      this.block(hit);
      const k = this.lowestBit(mask),
        found = this.tmp();
      this.line(`${found} = add i32 ${i}, ${k}`);
      this.line(`store i32 ${found}, ptr %at`);
      this.line(`br label %attempt`);
      this.block(tail);
      from = tail;
      start = i;
    }
    const head = this.label("ssh"),
      probe = this.label("sst"),
      next = this.label("ssn"),
      found = this.label("ssf");
    this.line(`br label %${head}`);
    this.block(head);
    const j = this.tmp(),
      j1 = this.tmp(),
      inb = this.tmp();
    this.line(`${j} = phi i32 [ ${start}, %${from} ], [ ${j1}, %${next} ]`);
    this.line(`${inb} = icmp slt i32 ${j}, %len`);
    this.line(`br i1 ${inb}, label %${probe}, label %nomatch`);
    this.block(probe);
    const hit = this.test(set, this.loadChar(j));
    this.line(`br i1 ${hit}, label %${found}, label %${next}`);
    this.block(next);
    this.line(`${j1} = add i32 ${j}, 1`);
    this.line(`br label %${head}`);
    this.block(found);
    this.line(`store i32 ${j}, ptr %at`);
    this.line(`br label %attempt`);
  }

  tmp(): string {
    return `%t${this.nTmp++}`;
  }

  label(prefix: string): string {
    return `${prefix}${this.nLabel++}`;
  }

  block(label: string): void {
    this.body.push(`${label}:`);
  }

  line(text: string): void {
    this.body.push(`  ${text}`);
  }

  newReg(): number {
    return this.regs++;
  }

  newResume(label: string): number {
    this.resumes.push(label);
    return this.resumes.length - 1;
  }

  loadPos(): string {
    const p = this.tmp();
    this.line(`${p} = load i32, ptr %pos`);
    return p;
  }

  storePos(v: string): void {
    this.line(`store i32 ${v}, ptr %pos`);
  }

  loadReg(r: number): string {
    const v = this.tmp();
    this.line(`${v} = load i32, ptr %r${r}`);
    return v;
  }

  loadChar(index: string): string {
    const wide = this.tmp(),
      at = this.tmp(),
      c = this.tmp();
    this.line(`${wide} = sext i32 ${index} to i64`);
    this.line(`${at} = getelementptr inbounds i8, ptr %s, i64 ${wide}`);
    this.line(`${c} = load i8, ptr ${at}`);
    return c;
  }

  /** Straight-line membership test of an i8 ASCII code unit. */
  test(set: CharSet, c: string): string {
    const n = setCount(set);
    if (n === ASCII) return "true";
    if (n === 0) return "false";
    const ranges = intervals(set);
    if (ranges.length <= 3) {
      const c32 = this.tmp();
      this.line(`${c32} = zext i8 ${c} to i32`);
      let acc = "";
      for (const [lo, hi] of ranges) {
        const hit = this.tmp();
        if (lo === hi) {
          this.line(`${hit} = icmp eq i32 ${c32}, ${lo!}`);
        } else {
          const d = this.tmp();
          this.line(`${d} = sub i32 ${c32}, ${lo!}`);
          this.line(`${hit} = icmp ule i32 ${d}, ${hi! - lo!}`);
        }
        if (acc === "") {
          acc = hit;
        } else {
          const both = this.tmp();
          this.line(`${both} = or i1 ${acc}, ${hit}`);
          acc = both;
        }
      }
      return acc;
    }
    const table = this.table(set),
      masked = this.tmp(),
      wide = this.tmp(),
      slot = this.tmp(),
      v = this.tmp(),
      hit = this.tmp();
    this.line(`${masked} = and i8 ${c}, 127`);
    this.line(`${wide} = zext i8 ${masked} to i64`);
    this.line(`${slot} = getelementptr inbounds [128 x i8], ptr ${table}, i64 0, i64 ${wide}`);
    this.line(`${v} = load i8, ptr ${slot}`);
    this.line(`${hit} = icmp ne i8 ${v}, 0`);
    return hit;
  }

  private table(set: CharSet): string {
    for (let k = 0; k < this.tables.length; k++)
      if (sameSet(this.tables[k]!, set)) return `@${this.sym}_t${k}`;
    const k = this.tables.length;
    this.tables.push(set);
    let bytes = "";
    for (let c = 0; c < ASCII; c++) bytes += set[c] ? "\\01" : "\\00";
    this.globals.push(`@${this.sym}_t${k} = private unnamed_addr constant [128 x i8] c"${bytes}"`);
    return `@${this.sym}_t${k}`;
  }

  /** Push data words and an entry id; may split the current block. */
  push(values: string[], id: number): void {
    const n = values.length + 1;
    const sp = this.tmp(),
      need = this.tmp(),
      cap = this.tmp(),
      full = this.tmp();
    const grow = this.label("grow"),
      put = this.label("put");
    this.line(`${sp} = load i32, ptr %sp`);
    this.line(`${need} = add i32 ${sp}, ${n}`);
    this.line(`${cap} = load i32, ptr %scap`);
    this.line(`${full} = icmp sgt i32 ${need}, ${cap}`);
    this.line(`br i1 ${full}, label %${grow}, label %${put}`);
    this.block(grow);
    this.line(`call void @scr_regex_stack_grow(ptr %stk, ptr %scap, ptr %sbuf, i32 ${need})`);
    this.line(`br label %${put}`);
    this.block(put);
    const base = this.tmp();
    this.line(`${base} = load ptr, ptr %stk`);
    const words = values.concat([String(id)]);
    for (let k = 0; k < words.length; k++) {
      const idx = this.tmp(),
        wide = this.tmp(),
        slot = this.tmp();
      this.line(`${idx} = add i32 ${sp}, ${k}`);
      this.line(`${wide} = sext i32 ${idx} to i64`);
      this.line(`${slot} = getelementptr inbounds i32, ptr ${base}, i64 ${wide}`);
      this.line(`store i32 ${words[k]!}, ptr ${slot}`);
    }
    this.line(`store i32 ${need}, ptr %sp`);
  }

  /** Pop `n` data words in push order (the dispatcher popped the id). */
  pop(n: number): string[] {
    const sp = this.tmp(),
      base = this.tmp(),
      rest = this.tmp();
    this.line(`${sp} = load i32, ptr %sp`);
    this.line(`${base} = load ptr, ptr %stk`);
    const out: string[] = [];
    for (let k = 0; k < n; k++) {
      const idx = this.tmp(),
        wide = this.tmp(),
        slot = this.tmp(),
        v = this.tmp();
      this.line(`${idx} = sub i32 ${sp}, ${n - k}`);
      this.line(`${wide} = sext i32 ${idx} to i64`);
      this.line(`${slot} = getelementptr inbounds i32, ptr ${base}, i64 ${wide}`);
      this.line(`${v} = load i32, ptr ${slot}`);
      out.push(v);
    }
    this.line(`${rest} = sub i32 ${sp}, ${n}`);
    this.line(`store i32 ${rest}, ptr %sp`);
    return out;
  }

  /** Register write that a backtrack restores. With an empty stack no
   * resume can observe the old value (the attempt fails outright and the
   * next attempt reinitializes), so no undo record is pushed. */
  setReg(r: number, value: string): void {
    let id = this.undoIds.get(r);
    if (id === undefined) {
      id = this.newResume(`undo${r}`);
      this.undoIds.set(r, id);
    }
    const sp = this.tmp(),
      live = this.tmp();
    const save = this.label("save"),
      set = this.label("set");
    this.line(`${sp} = load i32, ptr %sp`);
    this.line(`${live} = icmp ne i32 ${sp}, 0`);
    this.line(`br i1 ${live}, label %${save}, label %${set}`);
    this.block(save);
    const old = this.loadReg(r);
    this.push([old], id);
    this.line(`br label %${set}`);
    this.block(set);
    this.line(`store i32 ${value}, ptr %r${r}`);
  }

  resetCaps(first: number, end: number): void {
    for (let g = first; g < end; g++) {
      this.setReg(2 * g, "-1");
      this.setReg(2 * g + 1, "-1");
    }
  }

  emit(node: RxNode, succ: string, follow: FirstInfo): string {
    switch (node.kind) {
      case "set":
        return this.emitRun([node.set], succ);
      case "seq":
        return this.emitSeq(node.items, succ, follow);
      case "alt":
        return this.emitAlt(node.alts, succ, follow);
      case "cap":
        return this.emitCap(node, succ, follow);
      case "rep":
        return this.emitRep(node, succ, follow);
      case "assert":
        return this.emitAssert(node.what, succ);
    }
  }

  /** Consecutive single characters: one bounds check, then each test. */
  private emitRun(sets: CharSet[], succ: string): string {
    const entry = this.label("run"),
      check = this.label("chk");
    this.block(entry);
    const p = this.loadPos(),
      rest = this.tmp(),
      inb = this.tmp();
    this.line(`${rest} = sub i32 %len, ${p}`);
    this.line(`${inb} = icmp sge i32 ${rest}, ${sets.length}`);
    this.line(`br i1 ${inb}, label %${check}, label %fail`);
    this.block(check);
    let acc = "";
    for (let k = 0; k < sets.length; k++) {
      let at = p;
      if (k > 0) {
        at = this.tmp();
        this.line(`${at} = add i32 ${p}, ${k}`);
      }
      const hit = this.test(sets[k]!, this.loadChar(at));
      if (acc === "") {
        acc = hit;
      } else {
        const both = this.tmp();
        this.line(`${both} = and i1 ${acc}, ${hit}`);
        acc = both;
      }
    }
    const end = this.tmp();
    this.line(`${end} = add i32 ${p}, ${sets.length}`);
    // Storing before the branch is safe: every resume sets the position.
    this.storePos(end);
    this.line(`br i1 ${acc}, label %${succ}, label %fail`);
    return entry;
  }

  private emitSeq(items: RxNode[], succ: string, follow: FirstInfo): string {
    // Group consecutive single characters into runs.
    const parts: (RxNode | CharSet[])[] = [];
    for (const item of items) {
      const last = parts.length > 0 ? parts[parts.length - 1]! : null;
      if (item.kind === "set" && Array.isArray(last) && last.length < 16) {
        last.push(item.set);
      } else if (item.kind === "set") {
        parts.push([item.set]);
      } else {
        parts.push(item);
      }
    }
    let next = succ;
    let after = follow;
    for (let k = parts.length - 1; k >= 0; k--) {
      const part = parts[k]!;
      if (Array.isArray(part)) {
        next = this.emitRun(part, next);
        after = { set: part[0]!, nullable: false, bol: false, uncond: false };
      } else {
        next = this.emit(part, next, after);
        after = thenFollow(firstOf(part), after);
      }
    }
    if (parts.length === 0) {
      const entry = this.label("empty");
      this.block(entry);
      this.line(`br label %${succ}`);
      return entry;
    }
    return next;
  }

  private emitAlt(alts: RxNode[], succ: string, follow: FirstInfo): string {
    const entries: string[] = [];
    for (const alt of alts) entries.push(this.emit(alt, succ, follow));
    const resumeLabels: string[] = [];
    const ids: number[] = [];
    for (let k = 1; k < alts.length; k++) {
      const l = this.label("alt");
      resumeLabels.push(l);
      ids.push(this.newResume(l));
    }
    const entry = this.label("alts");
    this.block(entry);
    const p = this.loadPos();
    this.push([p], ids[0]!);
    this.line(`br label %${entries[0]!}`);
    for (let k = 1; k < alts.length; k++) {
      this.block(resumeLabels[k - 1]!);
      const [q] = this.pop(1);
      this.storePos(q!);
      if (k + 1 < alts.length) this.push([q!], ids[k]!);
      this.line(`br label %${entries[k]!}`);
    }
    return entry;
  }

  private emitCap(node: CapNode, succ: string, follow: FirstInfo): string {
    const close = this.label("close");
    this.block(close);
    const end = this.loadPos();
    this.setReg(2 * node.index + 1, end);
    this.line(`br label %${succ}`);
    const body = this.emit(node.body, close, follow);
    const open = this.label("open");
    this.block(open);
    const start = this.loadPos();
    this.setReg(2 * node.index, start);
    this.line(`br label %${body}`);
    return open;
  }

  private emitAssert(what: AssertKind, succ: string): string {
    const entry = this.label("as");
    this.block(entry);
    const p = this.loadPos();
    if (what === "bol" || what === "eol") {
      const hit = this.tmp();
      this.line(`${hit} = icmp eq i32 ${p}, ${what === "bol" ? "0" : "%len"}`);
      this.line(`br i1 ${hit}, label %${succ}, label %fail`);
      return entry;
    }
    if (what === "bolm" || what === "eolm") {
      const edge = this.tmp(),
        look = this.label("nl");
      this.line(`${edge} = icmp eq i32 ${p}, ${what === "bolm" ? "0" : "%len"}`);
      this.line(`br i1 ${edge}, label %${succ}, label %${look}`);
      this.block(look);
      let at = p;
      if (what === "bolm") {
        at = this.tmp();
        this.line(`${at} = sub i32 ${p}, 1`);
      }
      const nl = emptySet();
      nl[10] = true;
      nl[13] = true;
      const hit = this.test(nl, this.loadChar(at));
      this.line(`br i1 ${hit}, label %${succ}, label %fail`);
      return entry;
    }
    const word = wordSet();
    const prev = this.label("wp"),
      noPrev = this.label("wq"),
      mid = this.label("wm"),
      next = this.label("wn"),
      noNext = this.label("wo"),
      done = this.label("wd");
    const hasPrev = this.tmp();
    this.line(`${hasPrev} = icmp sgt i32 ${p}, 0`);
    this.line(`br i1 ${hasPrev}, label %${prev}, label %${noPrev}`);
    this.block(prev);
    const pm = this.tmp();
    this.line(`${pm} = sub i32 ${p}, 1`);
    const w1 = this.test(word, this.loadChar(pm));
    this.line(`br label %${mid}`);
    this.block(noPrev);
    this.line(`br label %${mid}`);
    this.block(mid);
    const a = this.tmp(),
      hasNext = this.tmp();
    this.line(`${a} = phi i1 [ ${w1}, %${prev} ], [ false, %${noPrev} ]`);
    this.line(`${hasNext} = icmp slt i32 ${p}, %len`);
    this.line(`br i1 ${hasNext}, label %${next}, label %${noNext}`);
    this.block(next);
    const w2 = this.test(word, this.loadChar(p));
    this.line(`br label %${done}`);
    this.block(noNext);
    this.line(`br label %${done}`);
    this.block(done);
    const b = this.tmp(),
      edge = this.tmp();
    this.line(`${b} = phi i1 [ ${w2}, %${next} ], [ false, %${noNext} ]`);
    this.line(`${edge} = xor i1 ${a}, ${b}`);
    const yes = what === "wordb" ? succ : "fail",
      no = what === "wordb" ? "fail" : succ;
    this.line(`br i1 ${edge}, label %${yes}, label %${no}`);
    return entry;
  }

  private emitRep(node: RepNode, succ: string, follow: FirstInfo): string {
    if (node.max === 0) {
      const entry = this.label("none");
      this.block(entry);
      this.line(`br label %${succ}`);
      return entry;
    }
    if (node.body.kind === "set") {
      return node.greedy
        ? this.emitGreedyChars(node.body.set, node.min, node.max, succ, follow)
        : this.emitLazyChars(node.body.set, node.min, node.max, succ);
    }
    if (node.min === 1 && node.max === 1) return this.emit(node.body, succ, follow);
    return this.emitLoop(node, succ, follow);
  }

  /** `x*`, `x+`, `x{n,m}` over one character: count the run, then give
   * characters back one at a time on backtrack (skipping positions where
   * the continuation cannot start). Possessive when giving back can never
   * succeed. */
  private emitGreedyChars(
    set: CharSet,
    min: number,
    max: number,
    succ: string,
    follow: FirstInfo,
  ): string {
    const entry = this.label("gl"),
      head = this.label("glh"),
      probe = this.label("glt"),
      step = this.label("glb"),
      done = this.label("gld"),
      ok = this.label("glo");
    this.block(entry);
    const p = this.loadPos(),
      rem = this.tmp();
    this.line(`${rem} = sub i32 %len, ${p}`);
    let lim = rem;
    if (max !== INF) {
      const small = this.tmp();
      lim = this.tmp();
      this.line(`${small} = icmp slt i32 ${rem}, ${max}`);
      this.line(`${lim} = select i1 ${small}, i32 ${rem}, i32 ${max}`);
    }
    // Long runs: 16 characters per step while a whole chunk fits.
    const plan = max === INF || max >= 32 ? this.vectorPlan(set) : null;
    let from = entry,
      start = "0",
      vectorExit = "";
    if (plan !== null) {
      const vhead = this.label("gvh"),
        vload = this.label("gvl"),
        vnext = this.label("gvn"),
        vexit = this.label("gvx"),
        tail = this.label("gvt");
      this.line(`br label %${vhead}`);
      this.block(vhead);
      const kv = this.tmp(),
        kv16 = this.tmp(),
        left = this.tmp(),
        fits = this.tmp();
      this.line(`${kv} = phi i32 [ 0, %${entry} ], [ ${kv16}, %${vnext} ]`);
      this.line(`${left} = sub i32 ${lim}, ${kv}`);
      this.line(`${fits} = icmp sge i32 ${left}, 16`);
      this.line(`br i1 ${fits}, label %${vload}, label %${tail}`);
      this.block(vload);
      const vat = this.tmp();
      this.line(`${vat} = add i32 ${p}, ${kv}`);
      const mask = this.testVector(plan, vat),
        all = this.tmp();
      this.line(`${all} = icmp eq i16 ${mask}, -1`);
      this.line(`br i1 ${all}, label %${vnext}, label %${vexit}`);
      this.block(vnext);
      this.line(`${kv16} = add i32 ${kv}, 16`);
      this.line(`br label %${vhead}`);
      this.block(vexit);
      const missing = this.tmp();
      this.line(`${missing} = xor i16 ${mask}, -1`);
      const off = this.lowestBit(missing),
        kx = this.tmp();
      this.line(`${kx} = add i32 ${kv}, ${off}`);
      this.line(`br label %${done}`);
      vectorExit = `, [ ${kx}, %${vexit} ]`;
      this.block(tail);
      from = tail;
      start = kv;
    }
    this.line(`br label %${head}`);
    this.block(head);
    const k = this.tmp(),
      k1 = this.tmp(),
      more = this.tmp();
    this.line(`${k} = phi i32 [ ${start}, %${from} ], [ ${k1}, %${step} ]`);
    this.line(`${more} = icmp slt i32 ${k}, ${lim}`);
    this.line(`br i1 ${more}, label %${probe}, label %${done}`);
    this.block(probe);
    const at = this.tmp();
    this.line(`${at} = add i32 ${p}, ${k}`);
    const hit = this.test(set, this.loadChar(at));
    this.line(`br i1 ${hit}, label %${step}, label %${done}`);
    this.block(step);
    this.line(`${k1} = add i32 ${k}, 1`);
    this.line(`br label %${head}`);
    this.block(done);
    const kf = this.tmp(),
      low = this.tmp();
    this.line(`${kf} = phi i32 [ ${k}, %${head} ], [ ${k}, %${probe} ]${vectorExit}`);
    this.line(`${low} = icmp slt i32 ${kf}, ${min}`);
    this.line(`br i1 ${low}, label %fail, label %${ok}`);
    this.block(ok);
    const np = this.tmp();
    this.line(`${np} = add i32 ${p}, ${kf}`);
    this.storePos(np);
    const possessive =
      follow.uncond || (!follow.nullable && !follow.bol && disjoint(set, follow.set));
    if (possessive || min === max) {
      this.line(`br label %${succ}`);
      return entry;
    }
    const give = this.label("gv");
    const id = this.newResume(give);
    const keep = this.label("glp");
    const more2 = this.tmp();
    this.line(`${more2} = icmp sgt i32 ${kf}, ${min}`);
    this.line(`br i1 ${more2}, label %${keep}, label %${succ}`);
    this.block(keep);
    this.push([p, kf], id);
    this.line(`br label %${succ}`);

    this.block(give);
    const [base, count] = this.pop(2);
    const back = this.tmp();
    this.line(`${back} = sub i32 ${count!}, 1`);
    let kk = back;
    if (!follow.nullable && !follow.bol) {
      // The continuation must consume a character of follow.set first.
      const scan = this.label("gs"),
        look = this.label("gst"),
        down = this.label("gsd"),
        found = this.label("gsf");
      const from = this.label("gse");
      this.line(`br label %${from}`);
      this.block(from);
      this.line(`br label %${scan}`);
      this.block(scan);
      const cur = this.tmp(),
        dec = this.tmp(),
        under = this.tmp();
      this.line(`${cur} = phi i32 [ ${back}, %${from} ], [ ${dec}, %${down} ]`);
      this.line(`${under} = icmp slt i32 ${cur}, ${min}`);
      this.line(`br i1 ${under}, label %fail, label %${look}`);
      this.block(look);
      const at2 = this.tmp();
      this.line(`${at2} = add i32 ${base!}, ${cur}`);
      const can = this.test(follow.set, this.loadChar(at2));
      this.line(`br i1 ${can}, label %${found}, label %${down}`);
      this.block(down);
      this.line(`${dec} = sub i32 ${cur}, 1`);
      this.line(`br label %${scan}`);
      this.block(found);
      kk = cur;
    }
    const again = this.label("gva"),
      resume = this.label("gvr");
    const repush = this.tmp();
    this.line(`${repush} = icmp sgt i32 ${kk}, ${min}`);
    this.line(`br i1 ${repush}, label %${again}, label %${resume}`);
    this.block(again);
    this.push([base!, kk], id);
    this.line(`br label %${resume}`);
    this.block(resume);
    const rp = this.tmp();
    this.line(`${rp} = add i32 ${base!}, ${kk}`);
    this.storePos(rp);
    this.line(`br label %${succ}`);
    return entry;
  }

  /** `x*?`, `x+?`, `x{n,m}?` over one character: take the minimum, then
   * one more character per backtrack. */
  private emitLazyChars(set: CharSet, min: number, max: number, succ: string): string {
    const entry = this.label("ll"),
      head = this.label("llh"),
      probe = this.label("llt"),
      step = this.label("llb"),
      ok = this.label("llo"),
      start = this.label("lls");
    this.block(entry);
    const p = this.loadPos(),
      rem = this.tmp(),
      enough = this.tmp();
    this.line(`${rem} = sub i32 %len, ${p}`);
    this.line(`${enough} = icmp sge i32 ${rem}, ${min}`);
    this.line(`br i1 ${enough}, label %${start}, label %fail`);
    this.block(start);
    this.line(`br label %${head}`);
    this.block(head);
    const k = this.tmp(),
      k1 = this.tmp(),
      reached = this.tmp();
    this.line(`${k} = phi i32 [ 0, %${start} ], [ ${k1}, %${step} ]`);
    this.line(`${reached} = icmp sge i32 ${k}, ${min}`);
    this.line(`br i1 ${reached}, label %${ok}, label %${probe}`);
    this.block(probe);
    const at = this.tmp();
    this.line(`${at} = add i32 ${p}, ${k}`);
    const hit = this.test(set, this.loadChar(at));
    this.line(`br i1 ${hit}, label %${step}, label %fail`);
    this.block(step);
    this.line(`${k1} = add i32 ${k}, 1`);
    this.line(`br label %${head}`);
    this.block(ok);
    const np = this.tmp();
    this.line(`${np} = add i32 ${p}, ${min}`);
    this.storePos(np);
    if (max !== INF && max <= min) {
      this.line(`br label %${succ}`);
      return entry;
    }
    const extend = this.label("lx");
    const id = this.newResume(extend);
    this.push([p, String(min)], id);
    this.line(`br label %${succ}`);

    this.block(extend);
    const [base, count] = this.pop(2);
    const pos = this.tmp(),
      inb = this.tmp(),
      look = this.label("lxt"),
      take = this.label("lxy");
    this.line(`${pos} = add i32 ${base!}, ${count!}`);
    this.line(`${inb} = icmp slt i32 ${pos}, %len`);
    this.line(`br i1 ${inb}, label %${look}, label %fail`);
    this.block(look);
    const can = this.test(set, this.loadChar(pos));
    this.line(`br i1 ${can}, label %${take}, label %fail`);
    this.block(take);
    const c1 = this.tmp(),
      np2 = this.tmp();
    this.line(`${c1} = add i32 ${count!}, 1`);
    this.line(`${np2} = add i32 ${pos}, 1`);
    this.storePos(np2);
    const again = this.label("lxa");
    if (max !== INF) {
      const below = this.tmp();
      this.line(`${below} = icmp slt i32 ${c1}, ${max}`);
      this.line(`br i1 ${below}, label %${again}, label %${succ}`);
    } else {
      this.line(`br label %${again}`);
    }
    this.block(again);
    this.push([base!, c1], id);
    this.line(`br label %${succ}`);
    return entry;
  }

  /** RepeatMatcher over a general atom: captures inside reset at each
   * iteration; an optional iteration that matched empty fails. */
  private emitLoop(node: RepNode, succ: string, follow: FirstInfo): string {
    const bodyFirst = firstOf(node.body);
    const emptyCheck = canMatchEmpty(node.body);
    const startReg = emptyCheck ? this.newReg() : -1;
    // After the body: another iteration or the continuation. An empty
    // check may fail in between, so nothing after the body is
    // unconditional.
    const bodyFollow: FirstInfo = {
      set: follow.set.slice(),
      nullable: follow.nullable,
      bol: follow.bol || (node.max !== 1 && bodyFirst.bol),
      uncond: false,
    };
    if (node.max !== 1) {
      unionInto(bodyFollow.set, bodyFirst.set);
      if (bodyFirst.nullable) bodyFollow.nullable = true;
    }

    if (node.min === 0 && node.max === 1) {
      const iter = this.label("oi"),
        after = this.label("oa");
      this.block(after);
      if (emptyCheck) {
        const p = this.loadPos(),
          r = this.loadReg(startReg),
          same = this.tmp();
        this.line(`${same} = icmp eq i32 ${p}, ${r}`);
        this.line(`br i1 ${same}, label %fail, label %${succ}`);
      } else {
        this.line(`br label %${succ}`);
      }
      const bodyEntry = this.emit(node.body, after, bodyFollow);
      this.block(iter);
      const p = this.loadPos();
      if (emptyCheck) this.setReg(startReg, p);
      this.resetCaps(node.capFirst, node.capEnd);
      this.line(`br label %${bodyEntry}`);
      const entry = this.label("opt");
      if (node.greedy) {
        const skip = this.label("os");
        const id = this.newResume(skip);
        this.block(entry);
        const q = this.loadPos();
        this.push([q], id);
        this.line(`br label %${iter}`);
        this.block(skip);
        const [r] = this.pop(1);
        this.storePos(r!);
        this.line(`br label %${succ}`);
      } else {
        const take = this.label("ot");
        const id = this.newResume(take);
        this.block(entry);
        const q = this.loadPos();
        this.push([q], id);
        this.line(`br label %${succ}`);
        this.block(take);
        const [r] = this.pop(1);
        this.storePos(r!);
        this.line(`br label %${iter}`);
      }
      return entry;
    }

    const counted = !(node.min === 0 && node.max === INF);
    const cnt = counted ? this.newReg() : -1;
    const entry = this.label("lp"),
      head = this.label("lph"),
      iter = this.label("lpi"),
      after = this.label("lpa");
    // after: the empty check, then count the iteration.
    this.block(after);
    if (emptyCheck) {
      const p = this.loadPos(),
        r = this.loadReg(startReg);
      let same = this.tmp();
      this.line(`${same} = icmp eq i32 ${p}, ${r}`);
      if (counted && node.min > 0) {
        const c = this.loadReg(cnt),
          optional = this.tmp(),
          both = this.tmp();
        this.line(`${optional} = icmp sge i32 ${c}, ${node.min}`);
        this.line(`${both} = and i1 ${same}, ${optional}`);
        same = both;
      }
      const count = this.label("lpc");
      this.line(`br i1 ${same}, label %fail, label %${count}`);
      this.block(count);
    }
    if (counted) {
      const c = this.loadReg(cnt),
        c1 = this.tmp();
      this.line(`${c1} = add i32 ${c}, 1`);
      this.setReg(cnt, c1);
    }
    this.line(`br label %${head}`);
    const bodyEntry = this.emit(node.body, after, bodyFollow);

    this.block(entry);
    if (counted) this.setReg(cnt, "0");
    this.line(`br label %${head}`);

    this.block(head);
    if (counted) {
      const c = this.loadReg(cnt);
      if (node.min > 0) {
        const req = this.tmp(),
          next = this.label("lpm");
        this.line(`${req} = icmp slt i32 ${c}, ${node.min}`);
        this.line(`br i1 ${req}, label %${iter}, label %${next}`);
        this.block(next);
      }
      if (node.max !== INF) {
        const full = this.tmp(),
          next = this.label("lpx");
        this.line(`${full} = icmp eq i32 ${c}, ${node.max}`);
        this.line(`br i1 ${full}, label %${succ}, label %${next}`);
        this.block(next);
      }
    }
    const q = this.loadPos();
    if (node.greedy) {
      const exit = this.label("lpe");
      const id = this.newResume(exit);
      this.push([q], id);
      this.line(`br label %${iter}`);
      this.block(exit);
      const [r] = this.pop(1);
      this.storePos(r!);
      this.line(`br label %${succ}`);
    } else {
      const more = this.label("lpn");
      const id = this.newResume(more);
      this.push([q], id);
      this.line(`br label %${succ}`);
      this.block(more);
      const [r] = this.pop(1);
      this.storePos(r!);
      this.line(`br label %${iter}`);
    }

    this.block(iter);
    const p = this.loadPos();
    if (emptyCheck) this.setReg(startReg, p);
    this.resetCaps(node.capFirst, node.capEnd);
    this.line(`br label %${bodyEntry}`);
    return entry;
  }

  /** The failure dispatcher and the undo resumes. */
  emitTail(): void {
    for (const [r, id] of this.undoIds) {
      this.block(this.resumes[id]!);
      const [old] = this.pop(1);
      this.line(`store i32 ${old!}, ptr %r${r}`);
      this.line(`br label %fail`);
    }
    this.block("fail");
    const sp = this.tmp(),
      empty = this.tmp();
    this.line(`${sp} = load i32, ptr %sp`);
    this.line(`${empty} = icmp eq i32 ${sp}, 0`);
    this.line(`br i1 ${empty}, label %attempt_fail, label %pop`);
    this.block("pop");
    const top = this.tmp(),
      base = this.tmp(),
      wide = this.tmp(),
      slot = this.tmp(),
      id = this.tmp();
    this.line(`${top} = sub i32 ${sp}, 1`);
    this.line(`${base} = load ptr, ptr %stk`);
    this.line(`${wide} = sext i32 ${top} to i64`);
    this.line(`${slot} = getelementptr inbounds i32, ptr ${base}, i64 ${wide}`);
    this.line(`${id} = load i32, ptr ${slot}`);
    this.line(`store i32 ${top}, ptr %sp`);
    const cases = this.resumes.map((l, k) => `i32 ${k}, label %${l}`).join(" ");
    this.line(`switch i32 ${id}, label %bad [ ${cases} ]`);
    this.block("bad");
    this.line(`unreachable`);
  }
}

export interface RegexMatcherCode {
  /** Module-level lines: tables and the function definition. */
  lines: string[];
  /** External declarations the function uses. */
  decls: string[];
}

export const REGEX_MATCHER_DECLS = [
  `declare void @scr_regex_stack_grow(ptr, ptr, ptr, i32)`,
  `declare void @scr_regex_stack_free(ptr)`,
];

/** Parse a literal's pattern into the compiled subset, or null. */
function parseSubset(pattern: string, flags: string): { root: RxNode; ncap: number } | null {
  for (const f of flags) if (!"gimsuy".includes(f)) return null;
  if (pattern.length > 2000) return null;
  const parser = new RxParser(
    pattern,
    flags.includes("u"),
    flags.includes("i"),
    flags.includes("s"),
    flags.includes("m"),
  );
  try {
    return { root: parser.parse(), ncap: parser.caps };
  } catch (e) {
    if (e instanceof RegexBail) return null;
    throw e;
  }
}

/** The capture count of a regex literal (the whole match included) and,
 * per capture, whether every match sets it: no alternation of several
 * branches and no repetition that can run zero times encloses it. Null
 * when the pattern is outside the parsed subset. */
export function regexLiteralCaptures(
  pattern: string,
  flags: string,
): { count: number; always: boolean[] } | null {
  const parsed = parseSubset(pattern, flags);
  if (!parsed) return null;
  const always = Array.from({ length: parsed.ncap }, (_, i) => i === 0);
  const walk = (node: RxNode, sure: boolean): void => {
    switch (node.kind) {
      case "cap":
        always[node.index] = sure;
        walk(node.body, sure);
        return;
      case "seq":
        for (const item of node.items) walk(item, sure);
        return;
      case "alt":
        for (const alt of node.alts) walk(alt, sure && node.alts.length === 1);
        return;
      case "rep":
        walk(node.body, sure && node.min > 0);
        return;
      default:
        return;
    }
  };
  walk(parsed.root, true);
  return { count: parsed.ncap, always };
}

/** Whether a literal compiles to a native matcher (tests and size caps). */
export function regexLiteralCompiles(pattern: string, flags: string): boolean {
  return parseSubset(pattern, flags) !== null;
}

/** Why a literal keeps the interpreter ("" when it compiles). */
export function regexLiteralBailReason(pattern: string, flags: string): string {
  try {
    new RxParser(
      pattern,
      flags.includes("u"),
      flags.includes("i"),
      flags.includes("s"),
      flags.includes("m"),
    ).parse();
    return "";
  } catch (e) {
    if (e instanceof RegexBail) return e.reason;
    throw e;
  }
}

/** The native matcher `@sym` of a regex literal, or null when the pattern
 * is outside the compiled subset. */
export function compileRegexMatcher(
  sym: string,
  pattern: string,
  flags: string,
  sizeType: string,
  vector: boolean,
  replacement: string | null = null,
): RegexMatcherCode | null {
  const parsed = parseSubset(pattern, flags);
  if (parsed === null) return null;
  const sticky = flags.includes("y");
  if (replacement !== null && !canReplaceWith(pattern, flags, replacement))
    throw new InternalCompilerError(`llvm emitter bug: no replacer for /${pattern}/${flags}`);
  const { root, ncap } = parsed;
  const gen = new RxGen(sym, ncap, vector);
  const end: FirstInfo = { set: emptySet(), nullable: true, bol: false, uncond: true };
  const start = gen.emit(root, "match", end);
  const first = thenFollow(firstOf(root), end);

  const fn: string[] = [];
  fn.push(`define internal i32 @${sym}(ptr %s, i32 %len, i32 %start, ptr %out) #0 {`);
  fn.push(`entry:`);
  fn.push(`  %pos = alloca i32`);
  fn.push(`  %at = alloca i32`);
  fn.push(`  %sp = alloca i32`);
  fn.push(`  %scap = alloca i32`);
  fn.push(`  %stk = alloca ptr`);
  fn.push(`  %sbuf = alloca [64 x i32]`);
  for (let r = 0; r < gen.regs; r++) fn.push(`  %r${r} = alloca i32`);
  if (replacement !== null) {
    fn.push(`  %next = alloca i32`);
    fn.push(`  %nfound = alloca i32`);
    fn.push(`  store i32 0, ptr %next`);
    fn.push(`  store i32 0, ptr %nfound`);
  }
  fn.push(`  store ptr %sbuf, ptr %stk`);
  fn.push(`  store i32 64, ptr %scap`);
  fn.push(`  store i32 %start, ptr %at`);
  fn.push(`  %query = icmp slt i32 %len, 0`);
  fn.push(`  br i1 %query, label %count, label %range`);
  fn.push(`count:`);
  fn.push(`  ret i32 ${ncap}`);
  fn.push(`range:`);
  fn.push(`  %past = icmp sgt i32 %start, %len`);
  fn.push(`  br i1 %past, label %nomatch, label %scan`);

  // scan: the next position at or after %at where a match can begin.
  fn.push(`scan:`);
  fn.push(`  %a = load i32, ptr %at`);
  const firstCount = setCount(first.set);
  if (sticky || first.nullable) {
    fn.push(`  br label %attempt`);
  } else if (first.bol && firstCount === 0) {
    fn.push(`  %a0 = icmp eq i32 %a, 0`);
    fn.push(`  br i1 %a0, label %attempt, label %nomatch`);
  } else {
    if (first.bol) {
      fn.push(`  %a0 = icmp eq i32 %a, 0`);
      fn.push(`  br i1 %a0, label %attempt, label %seek`);
    } else {
      fn.push(`  br label %seek`);
    }
    // A replacer seeks again after every match, often a few bytes on: the
    // 16-byte scan avoids a memchr call per match.
    if (firstCount === 1 && replacement === null) {
      fn.push(`seek:`);
      const byte = intervals(first.set)[0]![0]!;
      fn.push(`  %rest = sub i32 %len, %a`);
      if (sizeType === "i32") fn.push(`  %rest.w = add i32 %rest, 0`);
      else fn.push(`  %rest.w = zext i32 %rest to ${sizeType}`);
      fn.push(`  %a.w = sext i32 %a to i64`);
      fn.push(`  %from = getelementptr inbounds i8, ptr %s, i64 %a.w`);
      fn.push(`  %hit = call ptr @memchr(ptr %from, i32 ${byte}, ${sizeType} %rest.w)`);
      fn.push(`  %none = icmp eq ptr %hit, null`);
      fn.push(`  br i1 %none, label %nomatch, label %found`);
      fn.push(`found:`);
      fn.push(`  %hit.i = ptrtoint ptr %hit to i64`);
      fn.push(`  %s.i = ptrtoint ptr %s to i64`);
      fn.push(`  %off = sub i64 %hit.i, %s.i`);
      fn.push(`  %off.n = trunc i64 %off to i32`);
      fn.push(`  store i32 %off.n, ptr %at`);
      fn.push(`  br label %attempt`);
    } else {
      // A start filter over the first few characters (a single first byte
      // keeps memchr).
      const prefix = prefixOf(root);
      gen.emitSeek(first.set, gen.prefixPlans(prefix) === null ? null : prefix);
    }
  }

  fn.push(`attempt:`);
  fn.push(`  %b = load i32, ptr %at`);
  fn.push(`  store i32 %b, ptr %pos`);
  fn.push(`  store i32 0, ptr %sp`);
  for (let r = 2; r < 2 * ncap; r++) fn.push(`  store i32 -1, ptr %r${r}`);
  fn.push(`  br label %${start}`);

  fn.push(`attempt_fail:`);
  if (sticky) {
    fn.push(`  br label %nomatch`);
  } else {
    fn.push(`  %c = load i32, ptr %at`);
    fn.push(`  %c1 = add i32 %c, 1`);
    fn.push(`  store i32 %c1, ptr %at`);
    fn.push(`  %over = icmp sgt i32 %c1, %len`);
    fn.push(`  br i1 %over, label %nomatch, label %scan`);
  }

  if (replacement !== null) {
    emitReplaceMatch(fn, sym, replacement, vector);
  } else {
    emitReturnMatch(fn, ncap);
  }

  const result = replacement !== null ? "%n.found" : "0";
  fn.push(`nomatch:`);
  if (replacement !== null) {
    fn.push(`  %n.next = load i32, ptr %next`);
    fn.push(`  %n.nextp = getelementptr inbounds i8, ptr %out, i64 16`);
    fn.push(`  %n.nextw = sext i32 %n.next to i64`);
    fn.push(`  store i64 %n.nextw, ptr %n.nextp`);
    fn.push(`  %n.found = load i32, ptr %nfound`);
  }
  fn.push(`  %n.stk = load ptr, ptr %stk`);
  fn.push(`  %n.heap = icmp ne ptr %n.stk, %sbuf`);
  fn.push(`  br i1 %n.heap, label %n.free, label %n.ret`);
  fn.push(`n.free:`);
  fn.push(`  call void @scr_regex_stack_free(ptr %n.stk)`);
  fn.push(`  br label %n.ret`);
  fn.push(`n.ret:`);
  fn.push(`  ret i32 ${result}`);

  gen.emitTail();
  for (const l of gen.body) fn.push(l);
  fn.push(`}`);

  const decls = REGEX_MATCHER_DECLS.slice();
  if (gen.body.some((l) => l.includes("@llvm.cttz.i16")))
    decls.push(`declare i16 @llvm.cttz.i16(i16, i1 immarg)`);
  if (!sticky && !first.nullable && firstCount === 1 && replacement === null)
    decls.push(`declare ptr @memchr(ptr, i32, ${sizeType})`);
  if (replacement !== null) {
    decls.push(`declare void @scr_re_replace_out_reserve(ptr, i64)`);
    decls.push(`declare void @llvm.memcpy.p0.p0.i64(ptr, ptr, i64, i1 immarg)`);
  }
  const globals = [...gen.globals];
  if (replacement !== null && replacement.length > 0)
    globals.push(
      `@${sym}.rep = private unnamed_addr constant [${replacement.length} x i8] c"${llvmBytes(replacement)}"`,
    );
  return { lines: [...globals, ...fn], decls };
}

/** Whether a substitution can run through a build-time replacer: a global,
 * non-sticky pattern that is not plain text (the runtime searches those as
 * strings) and an ASCII replacement without `$` patterns. */
export function canReplaceWith(pattern: string, flags: string, replacement: string): boolean {
  if (!flags.includes("g") || flags.includes("y") || isPlainTextPattern(pattern, flags))
    return false;
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement.charCodeAt(i);
    if (c >= ASCII || c === 0x24) return false;
  }
  return true;
}

/** scr_regex_plain_text's rule: a pattern of literal characters and escaped
 * metacharacters (no letters under `i`) that the runtime searches as text. */
function isPlainTextPattern(pattern: string, flags: string): boolean {
  const fold = flags.includes("i");
  if (pattern.length === 0 || pattern.length > 256) return false;
  for (let i = 0; i < pattern.length; i++) {
    let c = pattern[i]!;
    if (c === "\\") {
      if (i + 1 >= pattern.length) return false;
      c = pattern[++i]!;
      if (!"^$\\.*+?()[]{}|/".includes(c)) return false;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code >= 0x7f || "^$.*+?()[]{}|".includes(c)) return false;
    }
    if (fold && /[a-z]/i.test(c)) return false;
  }
  return true;
}

function llvmBytes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out +=
      c >= 0x20 && c < 0x7f && c !== 0x22 && c !== 0x5c
        ? text[i]
        : `\\${c.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The match block of a matcher: store the capture pointers, return 1. */
function emitReturnMatch(fn: string[], ncap: number): void {
  fn.push(`match:`);
  fn.push(`  %m.end = load i32, ptr %pos`);
  fn.push(`  %m.start = load i32, ptr %at`);
  for (let slot = 0; slot < 2 * ncap; slot++) {
    const v = slot === 0 ? "%m.start" : slot === 1 ? "%m.end" : `%m.v${slot}`;
    if (slot >= 2) fn.push(`  ${v} = load i32, ptr %r${slot}`);
    fn.push(`  %m.w${slot} = sext i32 ${v} to i64`);
    fn.push(`  %m.p${slot} = getelementptr inbounds i8, ptr %s, i64 %m.w${slot}`);
    let value = `%m.p${slot}`;
    if (slot >= 2) {
      fn.push(`  %m.u${slot} = icmp slt i32 ${v}, 0`);
      fn.push(`  %m.q${slot} = select i1 %m.u${slot}, ptr null, ptr %m.p${slot}`);
      value = `%m.q${slot}`;
    }
    fn.push(`  %m.o${slot} = getelementptr inbounds ptr, ptr %out, i64 ${slot}`);
    fn.push(`  store ptr ${value}, ptr %m.o${slot}`);
  }
  fn.push(`  %m.stk = load ptr, ptr %stk`);
  fn.push(`  %m.heap = icmp ne ptr %m.stk, %sbuf`);
  fn.push(`  br i1 %m.heap, label %m.free, label %m.ret`);
  fn.push(`m.free:`);
  fn.push(`  call void @scr_regex_stack_free(ptr %m.stk)`);
  fn.push(`  br label %m.ret`);
  fn.push(`m.ret:`);
  fn.push(`  ret i32 1`);
}

/** The match block of a replacer: append the gap since the previous match
 * and the replacement to the output (ScrReReplaceOut: len, cap, next at
 * 0, 8 and 16, then data), and continue the search at the match end, or one past it for an
 * empty match, as the runtime's replace loop does. */
function emitReplaceMatch(fn: string[], sym: string, replacement: string, vector: boolean): void {
  const n = replacement.length;
  fn.push(`match:`);
  fn.push(`  %m.end = load i32, ptr %pos`);
  fn.push(`  %m.start = load i32, ptr %at`);
  fn.push(`  %m.next = load i32, ptr %next`);
  fn.push(`  %m.gap = sub i32 %m.start, %m.next`);
  fn.push(`  %m.gapw = zext i32 %m.gap to i64`);
  fn.push(`  %m.lenp = getelementptr inbounds i8, ptr %out, i64 0`);
  fn.push(`  %m.capp = getelementptr inbounds i8, ptr %out, i64 8`);
  fn.push(`  %m.datap = getelementptr inbounds i8, ptr %out, i64 24`);
  fn.push(`  %m.len0 = load i64, ptr %m.lenp`);
  fn.push(`  %m.cap = load i64, ptr %m.capp`);
  fn.push(`  %m.room = sub i64 %m.cap, %m.len0`);
  // 16 bytes of slack past the gap and the replacement for the 16-byte copy.
  fn.push(`  %m.need = add i64 %m.gapw, ${n + 32}`);
  fn.push(`  %m.fits = icmp uge i64 %m.room, %m.need`);
  fn.push(`  br i1 %m.fits, label %m.put, label %m.grow`);
  fn.push(`m.grow:`);
  fn.push(`  call void @scr_re_replace_out_reserve(ptr %out, i64 %m.need)`);
  fn.push(`  br label %m.put`);
  fn.push(`m.put:`);
  fn.push(`  %m.data = load ptr, ptr %m.datap`);
  fn.push(`  %m.len = load i64, ptr %m.lenp`);
  fn.push(`  %m.dst = getelementptr inbounds i8, ptr %m.data, i64 %m.len`);
  fn.push(`  %m.nextw = sext i32 %m.next to i64`);
  fn.push(`  %m.src = getelementptr inbounds i8, ptr %s, i64 %m.nextw`);
  if (vector) {
    // A gap of at most 16 bytes with 16 readable subject bytes is one
    // unaligned 16-byte copy.
    fn.push(`  %m.small = icmp ule i32 %m.gap, 16`);
    fn.push(`  %m.rest = sub i32 %len, %m.next`);
    fn.push(`  %m.readable = icmp sge i32 %m.rest, 16`);
    fn.push(`  %m.fast = and i1 %m.small, %m.readable`);
    fn.push(`  br i1 %m.fast, label %m.copy16, label %m.copy`);
    fn.push(`m.copy16:`);
    fn.push(`  %m.v = load <16 x i8>, ptr %m.src, align 1`);
    fn.push(`  store <16 x i8> %m.v, ptr %m.dst, align 1`);
    fn.push(`  br label %m.rep`);
  } else {
    fn.push(`  br label %m.copy`);
  }
  fn.push(`m.copy:`);
  fn.push(`  call void @llvm.memcpy.p0.p0.i64(ptr %m.dst, ptr %m.src, i64 %m.gapw, i1 false)`);
  fn.push(`  br label %m.rep`);
  fn.push(`m.rep:`);
  fn.push(`  %m.rdst = getelementptr inbounds i8, ptr %m.dst, i64 %m.gapw`);
  if (n > 0)
    fn.push(`  call void @llvm.memcpy.p0.p0.i64(ptr %m.rdst, ptr @${sym}.rep, i64 ${n}, i1 false)`);
  fn.push(`  %m.len1 = add i64 %m.len, %m.gapw`);
  fn.push(`  %m.len2 = add i64 %m.len1, ${n}`);
  fn.push(`  store i64 %m.len2, ptr %m.lenp`);
  fn.push(`  store i32 %m.end, ptr %next`);
  fn.push(`  %m.found0 = load i32, ptr %nfound`);
  fn.push(`  %m.found1 = add i32 %m.found0, 1`);
  fn.push(`  store i32 %m.found1, ptr %nfound`);
  fn.push(`  %m.empty = icmp eq i32 %m.end, %m.start`);
  fn.push(`  %m.after = add i32 %m.end, 1`);
  fn.push(`  %m.at = select i1 %m.empty, i32 %m.after, i32 %m.end`);
  fn.push(`  store i32 %m.at, ptr %at`);
  fn.push(`  %m.past = icmp sgt i32 %m.at, %len`);
  fn.push(`  br i1 %m.past, label %nomatch, label %scan`);
}
