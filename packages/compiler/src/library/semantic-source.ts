import { createHash } from "node:crypto";
import { extname } from "node:path";

interface SemanticToken {
  kind: "token" | "comment";
  text: string;
  lineBreakBefore: boolean;
  start: number;
  end: number;
}

const TOKEN_PATTERN = /(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(?:[A-Za-z_$][A-Za-z0-9_$]*)|(?:===|!==|>>>|>>=|<<=|\*\*=|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\*\*|<<|>>>|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)|[^\s])/gy;

const REGEX_PRECEDERS = new Set([
  "(", "[", "{", ",", ";", ":", "=", "==", "===", "!=", "!==", "!", "?", "=>",
  "+", "-", "*", "%", "&", "|", "^", "~", "<", ">", "<=", ">=", "&&", "||", "??",
  "return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await",
]);

function regexLiteralEnd(source: string, start: number): number | null {
  let inClass = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]!;
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index++;
      while (/[A-Za-z]/.test(source[index] ?? "")) index++;
      return index;
    }
    if (char === "\n" || char === "\r") return null;
  }
  return null;
}

function commentCanAffectCompilation(path: string, text: string): boolean {
  const extension = extname(path).toLowerCase();
  // JavaScript's checker surface is JSDoc-driven, so every comment remains
  // semantic there. JSON and unknown source spellings stay conservative too.
  if (extension !== ".ts" && extension !== ".mts" && extension !== ".cts") return true;
  // TypeScript comments are ordinary trivia except for compiler directives,
  // triple-slash references, and the pure annotations consumed by lowering.
  return text.startsWith("///") || text.includes("@") || text.includes("#");
}

function semanticTokens(path: string, source: string): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  let lineBreakBefore = false;
  TOKEN_PATTERN.lastIndex = 0;
  while (TOKEN_PATTERN.lastIndex < source.length) {
    const match = TOKEN_PATTERN.exec(source);
    if (match === null) throw new Error(`semantic scanner stopped at ${TOKEN_PATTERN.lastIndex}`);
    let text = match[0]!;
    const start = match.index;
    let end = start + text.length;
    if (/^\s+$/.test(text)) {
      if (/\r|\n/.test(text)) lineBreakBefore = true;
      continue;
    }
    const comment = text.startsWith("//") || text.startsWith("/*");
    if (comment) {
      if (!commentCanAffectCompilation(path, text)) {
        if (/\r|\n/.test(text)) lineBreakBefore = true;
        continue;
      }
    }
    if (
      text === "/" &&
      (tokens.length === 0 || REGEX_PRECEDERS.has(tokens[tokens.length - 1]!.text))
    ) {
      const regexEnd = regexLiteralEnd(source, start);
      if (regexEnd !== null) {
        end = regexEnd;
        text = source.slice(start, end);
        TOKEN_PATTERN.lastIndex = end;
      }
    }
    tokens.push({ kind: comment ? "comment" : "token", text, lineBreakBefore, start, end });
    lineBreakBefore = false;
  }
  return tokens;
}

function tokensEqual(left: readonly SemanticToken[], right: readonly SemanticToken[]): boolean {
  return left.length === right.length && left.every((token, index) => {
    const other = right[index]!;
    return token.kind === other.kind &&
      token.text === other.text &&
      (index === 0 || token.lineBreakBefore === other.lineBreakBefore);
  });
}

/** Content identity after discarding TypeScript comments proven to be trivia. */
export function semanticSourceDigest(path: string, source: string): string {
  const hash = createHash("sha256").update("scriptc-semantic-source-v1\0");
  for (const token of semanticTokens(path, source)) {
    hash.update(String(token.kind)).update("\0")
      .update(token.lineBreakBefore ? "nl" : "same-line").update("\0")
      .update(token.text).update("\0");
  }
  return hash.digest("hex");
}

export function semanticallyEqualSource(
  path: string,
  previous: string,
  current: string,
): boolean {
  return tokensEqual(semanticTokens(path, previous), semanticTokens(path, current));
}

function offsetMapper(path: string, previous: string, current: string): (offset: number) => number {
  const oldTokens = semanticTokens(path, previous);
  const newTokens = semanticTokens(path, current);
  if (!tokensEqual(oldTokens, newTokens)) return (offset) => offset;
  return (offset) => {
    if (offset <= 0) return 0;
    if (offset >= previous.length) return current.length;
    let lo = 0;
    let hi = oldTokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const token = oldTokens[mid]!;
      if (offset < token.start) hi = mid - 1;
      else if (offset > token.end) lo = mid + 1;
      else return newTokens[mid]!.start + Math.min(offset - token.start, token.end - token.start);
    }
    const before = hi >= 0 ? oldTokens[hi] : undefined;
    const after = lo < oldTokens.length ? oldTokens[lo] : undefined;
    if (before === undefined) {
      return Math.max(0, newTokens[lo]!.start - (after!.start - offset));
    }
    if (after === undefined) {
      return Math.min(current.length, newTokens[hi]!.end + (offset - before.end));
    }
    const oldGap = after.start - before.end;
    const newBefore = newTokens[hi]!;
    const newAfter = newTokens[lo]!;
    if (oldGap <= 0) return newBefore.end;
    const fraction = (offset - before.end) / oldGap;
    return Math.round(newBefore.end + fraction * (newAfter.start - newBefore.end));
  };
}

/** Rebase every SrcLoc-shaped object in a deserialized cache payload. */
export function rebaseSourceLocations<T>(
  value: T,
  previousSources: ReadonlyMap<string, string>,
  currentSources: ReadonlyMap<string, string>,
): T {
  const mappers = new Map<string, (offset: number) => number>();
  for (const [path, previous] of previousSources) {
    const current = currentSources.get(path);
    if (current !== undefined) mappers.set(path, offsetMapper(path, previous, current));
  }
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (
      typeof record["file"] === "string" &&
      typeof record["start"] === "number" &&
      typeof record["end"] === "number"
    ) {
      const map = mappers.get(record["file"]);
      if (map !== undefined) {
        record["start"] = map(record["start"]);
        record["end"] = map(record["end"]);
      }
      return;
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(value);
  return value;
}
