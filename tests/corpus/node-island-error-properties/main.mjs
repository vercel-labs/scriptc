// @requires-libnode
// A program error inside a Node island is one V8 Error of the error's own
// class whose own properties are the program error's: an error made
// without a message has no own `message`, `cause` and `errors` are own and
// not enumerable, a property the program added is own and enumerable, in
// the program's order, and the error is the same object each time it
// crosses and when it comes back.
import { readFileSync } from "node:fs";
import { view, keep, same, giveBack, make, islandValue } from "err-view";

function row(label, e) {
  console.log(view(label, e));
  keep(label, e);
  console.log(label, "identity =", same(label, e), giveBack(e) === e);
}

row("bare", new Error());
row("message", new Error("m"));
row("empty message", new Error(""));
row("cause error", new Error("m", { cause: new RangeError("inner") }));
row("cause string", new Error("m", { cause: "why" }));
row("cause undefined", new Error("m", { cause: undefined }));
row("cause island object", new Error("m", { cause: islandValue() }));
row("cause island error", new Error("m", { cause: make("type") }));
row("properties", Object.assign(new Error("m"), { code: "E_X", detail: { n: 1 } }));
row("more properties", Object.assign(new Error("m"), { list: [1, 2], flag: true, n: 3, nothing: null }));
const coded = new Error("m");
coded.code = 42;
row("number code", coded);
const named = new Error("m");
named.name = "Custom";
row("name set", named);
const late = new Error();
late.message = "late";
row("message set", late);
row("TypeError", new TypeError("t"));
row("RangeError", new RangeError("r"));
row("SyntaxError", new SyntaxError("s"));
row("ReferenceError", new ReferenceError("ref"));
row("EvalError", new EvalError("ev"));
row("URIError", new URIError("u"));
row("AggregateError", new AggregateError([new Error("e1"), new TypeError("e2")], "many"));
row("empty AggregateError", new AggregateError([]));
row("DOMException", new DOMException("gone", "AbortError"));
try {
  JSON.parse("{");
} catch (e) {
  row("JSON.parse", e);
}
try {
  readFileSync("/nonexistent/file");
} catch (e) {
  row("readFileSync", e);
}
