// @tsc-jsx
// JSX in .tsx modules with the classic runtime: jsxFactory, jsxFragmentFactory and per-file pragmas.
import { render } from "./html.js";
import { List } from "./list.js";
import { Page } from "./page.js";
import { viaPragma } from "./pragma.js";

const items = [
  { id: 1, name: "write <tests>", done: true },
  { id: 2, name: "ship", done: false },
];
console.log(render(Page("Today", items)));
console.log(render(Page("Empty", [])));
console.log(viaPragma);
console.log(List());
