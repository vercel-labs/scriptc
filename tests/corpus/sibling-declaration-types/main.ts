// A relative `.js` import resolves to the sibling `.d.ts` for types, as
// tsc does, while the compiled module is the JavaScript Node loads. The
// call below passes `{}` for a parameter the declaration makes optional and
// the JavaScript's inferred shape makes required: it compiles because the
// declaration types it, and it runs because the JavaScript is what runs.
import { greet } from "./greet.js";
import { label } from "./label.mjs";
import { triple } from "./math.cjs";
import format from "./format.js";
import { Widget } from "./widget.cjs";
import * as panels from "./panel.js";
import { wave } from "./link.js";
import { wave as spreadWave } from "./spread.js";
import { tripled } from "./table.cjs";

console.log(greet({}));
console.log(greet({ name: "ada" }));
console.log(label(3));
console.log(triple(4));
console.log(format("x"));
// A declaration bridge beside a CommonJS copy (the shape a vendored
// dependency takes): its declared optional prop is what types `Widget({})`.
console.log(Widget({}));
console.log(Widget({ label: "w" }));
// The same bridge read through a namespace, and an implementation that
// re-exports the function its declaration names.
console.log(panels.Panel({}));
console.log(wave());
// An implementation that star-re-exports its declarations, and a CommonJS
// table export whose sibling declaration types it.
console.log(spreadWave());
console.log(tripled(3));
