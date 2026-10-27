// A one-line minified ES module. Its module-level var statement spreads
// earlier declarators into later ones, its tokenizer reads regexes through
// an untyped rules table (search, match and replace with callbacks), and
// one function receives both typed and untyped link objects.
import { render } from "gtminimark";

const doc = [
  "# Title \\*one\\*",
  "## Sub",
  '[a](/x "T\\*")',
  "[b](/y)",
  '[r]: /ref "Ref"',
  "[n]: /none",
  "[R]",
  "[n]",
  "[z]",
  "\tcode *em* line",
  "   three spaces *x* and *y*",
  "plain words here",
].join("\n");
console.log(render(doc));
console.log(render(doc, { pedantic: true }));
