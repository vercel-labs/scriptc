import { createHash } from "node:crypto";
import { extname } from "node:path";
import ts from "typescript5";

interface SemanticToken {
  kind: "token" | "comment";
  text: string;
  lineBreakBefore: boolean;
  start: number;
  end: number;
}

const TOKEN_PATTERN = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\/|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(?:(?:[$_\p{ID_Start}]|\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\}))(?:(?:[$_\u200C\u200D\p{ID_Continue}]|\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})))*)|(?:===|!==|>>>|>>=|<<=|\*\*=|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\*\*|<<|>>>|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)|[^\s])/guy;

const LINE_BREAK_PATTERN = /[\r\n\u2028\u2029]/;

function commentCanAffectCompilation(path: string, text: string): boolean {
  const extension = extname(path).toLowerCase();
  // JavaScript's checker surface is JSDoc-driven, so every comment remains
  // semantic there. JSON and unknown source spellings stay conservative too.
  if (extension !== ".ts" && extension !== ".mts" && extension !== ".cts") return true;
  // TypeScript comments are ordinary trivia except for compiler directives,
  // triple-slash references, and the pure annotations consumed by lowering.
  return text.startsWith("///") || text.includes("@") || text.includes("#");
}

function semanticTokens(path: string, source: string): SemanticToken[] | null {
  // Slash is context-sensitive in JavaScript: after `else`, for example,
  // `/[//a]/` is one regex token even though a standalone scanner can see
  // the inner `//` as a comment. Use TypeScript's parser as the authority for
  // both syntax validity (including a shebang's byte-zero requirement) and
  // exact regular-expression spans, then keep the cheap scanner for trivia
  // equivalence and location mapping.
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics: readonly ts.Diagnostic[];
  }).parseDiagnostics;
  if (parseDiagnostics.length > 0) return null;
  const regexEnds = new Map<number, number>();
  const collectRegex = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) regexEnds.set(node.getStart(sourceFile), node.end);
    ts.forEachChild(node, collectRegex);
  };
  collectRegex(sourceFile);

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
      if (LINE_BREAK_PATTERN.test(text)) lineBreakBefore = true;
      continue;
    }
    const regexEnd = regexEnds.get(start);
    if (regexEnd !== undefined) {
      end = regexEnd;
      text = source.slice(start, end);
      TOKEN_PATTERN.lastIndex = end;
      tokens.push({ kind: "token", text, lineBreakBefore, start, end });
      lineBreakBefore = false;
      continue;
    }
    const comment = text.startsWith("//") || text.startsWith("/*");
    if (comment) {
      if (!commentCanAffectCompilation(path, text)) {
        if (LINE_BREAK_PATTERN.test(text)) lineBreakBefore = true;
        continue;
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
  const tokens = semanticTokens(path, source);
  if (tokens === null) return hash.update("invalid\0").update(source).digest("hex");
  for (const token of tokens) {
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
  const left = semanticTokens(path, previous);
  const right = semanticTokens(path, current);
  return left !== null && right !== null && tokensEqual(left, right);
}

interface OffsetMapper {
  start(offset: number): number;
  end(offset: number): number;
}

function offsetMapper(path: string, previous: string, current: string): OffsetMapper {
  const oldTokens = semanticTokens(path, previous);
  const newTokens = semanticTokens(path, current);
  if (oldTokens === null || newTokens === null || !tokensEqual(oldTokens, newTokens)) {
    return { start: (offset) => offset, end: (offset) => offset };
  }
  const map = (offset: number, bias: "start" | "end"): number => {
    if (offset <= 0) return 0;
    if (offset >= previous.length) return current.length;
    let lo = 0;
    let hi = oldTokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const token = oldTokens[mid]!;
      if (bias === "start" ? offset < token.start : offset <= token.start) hi = mid - 1;
      else if (bias === "start" ? offset >= token.end : offset > token.end) lo = mid + 1;
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
  return {
    start: (offset) => map(offset, "start"),
    end: (offset) => map(offset, "end"),
  };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let offset = 0; offset < source.length; offset++) {
    if (source[offset] === "\n") starts.push(offset + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Build a cheap old-line to current-line mapper for semantically identical
 * sources. C emission records only a location's line, not its byte offset, so
 * representative semantic tokens anchor each old line across trivia edits. */
export function createSourceLineRebaser(
  path: string,
  previous: string,
  current: string,
): (line: number) => number {
  const oldTokens = semanticTokens(path, previous);
  const newTokens = semanticTokens(path, current);
  if (oldTokens === null || newTokens === null || !tokensEqual(oldTokens, newTokens)) {
    return (line) => line;
  }
  const oldStarts = lineStarts(previous);
  const newStarts = lineStarts(current);
  const firstTokenByLine = new Map<number, number>();
  for (let index = 0; index < oldTokens.length; index++) {
    const line = lineAt(oldStarts, oldTokens[index]!.start);
    if (!firstTokenByLine.has(line)) firstTokenByLine.set(line, index);
  }
  const mapper = offsetMapper(path, previous, current);
  return (line): number => {
    if (!Number.isSafeInteger(line) || line < 1 || line > oldStarts.length) return line;
    const tokenIndex = firstTokenByLine.get(line);
    const offset = tokenIndex === undefined
      ? mapper.start(oldStarts[line - 1]!)
      : newTokens[tokenIndex]!.start;
    return lineAt(newStarts, offset);
  };
}

/** True when every existing source line keeps its physical line number. This
 * is the safe subset for reusing a C TU whose annotations retain line numbers
 * but not enough provenance to distinguish synthetic byte-zero locations. */
export function sourceLineRebaseIsIdentity(
  path: string,
  previous: string,
  current: string,
): boolean {
  const rebase = createSourceLineRebaser(path, previous, current);
  let line = 1;
  if (rebase(line) !== line) return false;
  for (let offset = 0; offset < previous.length; offset++) {
    if (previous[offset] !== "\n") continue;
    line++;
    if (rebase(line) !== line) return false;
  }
  return true;
}

/** Rebase every SrcLoc-shaped object in a deserialized cache payload. */
export function rebaseSourceLocations<T>(
  value: T,
  previousSources: ReadonlyMap<string, string>,
  currentSources: ReadonlyMap<string, string>,
): T {
  const mappers = new Map<string, OffsetMapper>();
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
        const start = record["start"];
        const end = record["end"];
        record["start"] = map.start(start);
        record["end"] = start === end ? record["start"] : map.end(end);
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
