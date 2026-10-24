// A package builds its segmenters at module load (pi-tui, grok-mermaid):
// a grapheme segmenter with a locale tag, and a word segmenter that only
// some paths use. Grapheme segmentation matches Node; the word segmenter
// constructs, and this program never segments with it.
import { columns, describe } from "text-width";

console.log(describe());
console.log(columns("éa👍🏽🇫🇷"), columns("abc"));
