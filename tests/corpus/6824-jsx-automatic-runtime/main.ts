// @tsc-jsx
// JSX with the automatic runtime: jsx/jsxs imports from jsxImportSource, keys, and per-file @jsxImportSource.
import { calls } from "#jsx/jsx-runtime";
import { viaPragma } from "./alt.js";
import { page } from "./page.js";
import { render } from "./render.js";

console.log(render(page(["ada", "lin"])));
console.log(calls.join(" "));
console.log(viaPragma.join(" | "));
