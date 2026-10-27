/* Terminal rendering: file:line:col, a hand-rolled code frame with ±1 line
 * of context and a ^~~~ underline sized to the span, optional hint line,
 * and the optional attributed profile-note line after it. A source line
 * longer than FRAME_MAX_WIDTH (minified sources) shows a window of that
 * width around the diagnostic's column, with "…" where text is cut.
 */
import { isTypePatchCode, type ScrDiagnostic } from "./diagnostic.js";

export interface RenderOptions {
  color?: boolean;
}

interface SourceLookup {
  /** Full text of the file the diagnostic points into. */
  text: string;
  /** The text's lines and their start offsets; computed from `text` when
   * absent. renderDiagnostics computes them once per file. */
  index?: LineIndex;
}

interface LineIndex {
  lines: string[];
  lineStarts: number[];
}

/** Frame lines longer than this many characters show a window of it. */
const FRAME_MAX_WIDTH = 400;
/** Characters a windowed frame keeps before the diagnostic's column. */
const FRAME_LEAD = 120;

function lineIndex(text: string): LineIndex {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  return { lines: text.split("\n"), lineStarts };
}

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function renderDiagnostic(
  diag: ScrDiagnostic,
  source: SourceLookup | undefined,
  opts: RenderOptions = {},
): string {
  const c = (code: string, s: string) => (opts.color ? code + s + RESET : s);
  const out: string[] = [];

  let lineNum = 1;
  let colNum = 1;
  const frame: string[] = [];

  if (source) {
    const { lines, lineStarts } = source.index ?? lineIndex(source.text);
    // the last line starting at or before the diagnostic
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= diag.loc.start) lo = mid;
      else hi = mid - 1;
    }
    lineNum = lo + 1;
    colNum = diag.loc.start - lineStarts[lo]! + 1;

    const lineText = lines[lineNum - 1] ?? "";
    // The window every frame line shows: the whole line, or for a long
    // line FRAME_MAX_WIDTH characters starting FRAME_LEAD before the column.
    const windowStart =
      lineText.length > FRAME_MAX_WIDTH
        ? Math.max(0, Math.min(colNum - 1 - FRAME_LEAD, lineText.length - FRAME_MAX_WIDTH))
        : 0;
    const shown = (text: string): string => {
      if (windowStart === 0 && text.length <= FRAME_MAX_WIDTH) return text;
      const end = windowStart + FRAME_MAX_WIDTH;
      return (
        (windowStart > 0 ? "…" : "") + text.slice(windowStart, end) + (text.length > end ? "…" : "")
      );
    };
    const gutterWidth = String(Math.min(lineNum + 1, lines.length)).length;
    const emitLine = (n: number) => {
      const text = lines[n - 1];
      if (text === undefined) return;
      frame.push(c(DIM, `  ${String(n).padStart(gutterWidth)} | `) + shown(text));
    };
    emitLine(lineNum - 1);
    emitLine(lineNum);
    const caretCol = colNum - 1 - windowStart + (windowStart > 0 ? 1 : 0);
    const visibleEnd =
      windowStart === 0 && lineText.length <= FRAME_MAX_WIDTH
        ? lineText.length
        : Math.min(lineText.length, windowStart + FRAME_MAX_WIDTH);
    const spanOnLine = Math.max(
      1,
      Math.min(diag.loc.end - diag.loc.start, visibleEnd - (colNum - 1)),
    );
    frame.push(
      c(DIM, `  ${" ".repeat(gutterWidth)} | `) +
        " ".repeat(caretCol) +
        c(isWarningCode(diag.code) ? YELLOW : RED, "^" + "~".repeat(spanOnLine - 1)),
    );
    emitLine(lineNum + 1);
  }

  const warning = isWarningCode(diag.code);
  out.push(
    `${c(BOLD, `${diag.loc.file}:${lineNum}:${colNum}`)} - ${warning ? c(YELLOW, "warning") : c(RED, "error")} ${c(BOLD, diag.code)}: ${diag.message}`,
  );
  if (frame.length) {
    out.push("", ...frame);
  }
  if (diag.hint) {
    out.push("", `  ${c(CYAN, "hint:")} ${diag.hint}`);
  }
  if (diag.note) {
    // Embedder-authored teaching text: its own attributed trailing line
    // (the text itself begins "from the '<profile>' profile:"), so the
    // tool's message and hint stay visibly the tool's.
    if (!diag.hint) out.push("");
    out.push(`  ${c(CYAN, "note:")} ${diag.note}`);
  }
  return out.join("\n");
}

export function renderDiagnostics(
  diags: ScrDiagnostic[],
  sourceTextByFile: Map<string, string>,
  opts: RenderOptions = {},
): string {
  const sorted = [...diags].sort(
    (a, b) => a.loc.file.localeCompare(b.loc.file) || a.loc.start - b.loc.start,
  );
  const indexes = new Map<string, LineIndex>();
  return sorted
    .map((d) => {
      const text = sourceTextByFile.get(d.loc.file);
      if (text === undefined) return renderDiagnostic(d, undefined, opts);
      let index = indexes.get(d.loc.file);
      if (index === undefined) {
        index = lineIndex(text);
        indexes.set(d.loc.file, index);
      }
      return renderDiagnostic(d, { text, index }, opts);
    })
    .join("\n\n");
}

/** Divergence warnings after a successful build: the rendered sites plus a
 * one-line count, on stderr. */
/** The warning severities: the divergence band (SC6xxx), where the program
 * compiles and the site can behave differently from Node, and unknown
 * settings in the project's scriptc configuration (SC8004), which builds do
 * not use. */
export function isWarningCode(code: string): boolean {
  return /^SC6\d{3}$/.test(code) || code === "SC8004" || isTypePatchCode(code);
}

/** A build's type patch warnings (SC8030–SC8033). */
export function renderTypePatchWarnings(
  diags: readonly ScrDiagnostic[],
  sourceTextByFile: Map<string, string>,
  opts: RenderOptions = {},
): string {
  const n = diags.length;
  return (
    renderDiagnostics([...diags], sourceTextByFile, opts) +
    `\n\n${n} warning${n === 1 ? "" : "s"}: ${n === 1 ? "this type patch" : "these type patches"} did not apply as written; the build uses the package's own declarations there.`
  );
}

/** A build's SC8004 warnings: the unknown scriptc settings it ignored. */
export function renderConfigWarnings(
  diags: readonly ScrDiagnostic[],
  sourceTextByFile: Map<string, string>,
  opts: RenderOptions = {},
): string {
  const n = diags.length;
  return (
    renderDiagnostics([...diags], sourceTextByFile, opts) +
    `\n\n${n} warning${n === 1 ? "" : "s"}: the build does not use ${n === 1 ? "this setting" : "these settings"}; scriptc coverage reports Node islands once they are valid.`
  );
}

export function renderWarnings(
  diags: readonly ScrDiagnostic[],
  sourceTextByFile: Map<string, string>,
  opts: RenderOptions = {},
): string {
  const n = diags.length;
  return (
    renderDiagnostics([...diags], sourceTextByFile, opts) +
    `\n\n${n} warning${n === 1 ? "" : "s"}: the program compiled, but ${n === 1 ? "this site" : "these sites"} can behave differently from Node.`
  );
}
