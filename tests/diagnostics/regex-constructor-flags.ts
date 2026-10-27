// new RegExp with a literal d flag refuses like the regex literal form;
// computed flags reach the runtime, which names the same gap.
const indices = new RegExp("cat", "dg");
