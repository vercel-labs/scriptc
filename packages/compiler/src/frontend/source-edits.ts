/* A source text rewritten by span replacements, with the map from the
 * rewritten text's offsets back to the original's. Copied text keeps its
 * offsets; replacement text stands for the start of the span it replaces. */

export interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

export interface EditedSource {
  text: string;
  /** A rewritten-text offset as an offset of the original text. */
  originalPosition(pos: number): number;
}

interface Segment {
  rewritten: number;
  original: number;
  /** The copied length, 0 for replacement text. */
  copied: number;
}

/** Applies non-overlapping edits (any order); an edit whose text equals the
 * span it replaces is dropped. */
export function applySourceEdits(source: string, edits: readonly SourceEdit[]): EditedSource {
  const sorted = edits
    .filter((e) => source.slice(e.start, e.end) !== e.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const pieces: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  let length = 0;
  const copy = (end: number): void => {
    if (end <= cursor) return;
    segments.push({ rewritten: length, original: cursor, copied: end - cursor });
    pieces.push(source.slice(cursor, end));
    length += end - cursor;
    cursor = end;
  };
  for (const edit of sorted) {
    if (edit.start < cursor) throw new Error(`overlapping source edits at ${edit.start}`);
    copy(edit.start);
    segments.push({ rewritten: length, original: edit.start, copied: 0 });
    pieces.push(edit.text);
    length += edit.text.length;
    cursor = edit.end;
  }
  copy(source.length);
  /** The last segment starting at or before `pos` in the rewritten text. */
  const find = (pos: number): Segment | undefined => {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (segments[mid]!.rewritten <= pos) low = mid;
      else high = mid - 1;
    }
    return segments[low];
  };
  return {
    text: pieces.join(""),
    originalPosition: (pos) => {
      const segment = find(pos);
      if (segment === undefined) return pos;
      return segment.copied > 0
        ? segment.original + Math.min(pos - segment.rewritten, segment.copied)
        : segment.original;
    },
  };
}
