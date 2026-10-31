// A package builds its segmenters at module load (pi-tui, grok-mermaid):
// a grapheme segmenter with a locale tag, one with empty options, and a
// word segmenter that only some paths use. Grapheme segmentation matches
// Node; the word segmenter constructs, and this program never segments
// with it.
import { columns, describe, plainColumns } from "text-width";

console.log(describe());
console.log(columns("éa👍🏽🇫🇷"), columns("abc"));
console.log(plainColumns("a\u0301b\u{1F44D}\u{1F3FD}"));
