import type { SrcLoc } from "../ir/ir.js";

export interface SourcePosition {
  file: string;
  line: number;
  column: number;
}

/** The UTF-16 offsets at which each line of `text` starts. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13 && text.charCodeAt(i + 1) === 10) i++;
    if (ch === 10 || ch === 13 || ch === 0x2028 || ch === 0x2029) starts.push(i + 1);
  }
  return starts;
}

/** Resolve IR's UTF-16 offsets against the exact sources used by the frontend.
 * A build from a lowered program that carries no text for a file (an IR
 * artifact) reads the file a location names, through `load`, the first time a
 * position asks for it. */
export class SourceLocations {
  /** null: the file has no text, so its locations have no position. */
  private readonly starts = new Map<string, number[] | null>();

  constructor(
    sources: ReadonlyMap<string, string>,
    private readonly load: ((file: string) => string | undefined) | undefined = undefined,
  ) {
    for (const [file, text] of sources) this.starts.set(file, lineStarts(text));
  }

  private startsOf(file: string): number[] | null {
    let starts = this.starts.get(file);
    if (starts === undefined) {
      const text = this.load?.(file);
      starts = text === undefined ? null : lineStarts(text);
      this.starts.set(file, starts);
    }
    return starts;
  }

  position(loc: SrcLoc): SourcePosition | null {
    if (loc.start < 0) return null;
    const starts = this.startsOf(loc.file);
    if (starts === null) return null;
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid]! <= loc.start) lo = mid;
      else hi = mid - 1;
    }
    return { file: loc.file, line: lo + 1, column: loc.start - starts[lo]! + 1 };
  }
}
