// A TypeScript entry beside a JavaScript module whose comment names
// child_process, so the handle-property census walks it. Nothing writes a
// property onto a child and the program can never box one: it used to ask for
// the child handle wrapper install anyway, and that install trapped at startup
// with "dyn handle ops not installed".
import { label } from "./helper.js";

const totals: number[] = [label.length, label.length + 1];
console.log(totals.join(","));
