// URLSearchParams crossing an implicit ToString: a template span, string
// concatenation, String() and an explicit toString() all serialize the
// pair list in insertion order, percent-encoded exactly as Node does. The
// record init accepts shorthand members (`{ model }`) like `{ model: model }`.
const model = "m 1";
const sp = new URLSearchParams({ model, autoload: "false", q: "a&b" });
console.log(`${sp}`);
console.log("prefix:" + sp);
console.log(String(sp));
console.log(sp.toString());
console.log(sp.get("model"), sp.get("q"), sp.get("missing"));
const empty = new URLSearchParams({});
console.log(`[${empty}]`, JSON.stringify(empty.toString()));
const pairs = [...sp];
console.log(pairs.length, pairs[0]![0], pairs[0]![1]);
