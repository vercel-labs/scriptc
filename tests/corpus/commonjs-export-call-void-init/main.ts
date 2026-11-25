// A CommonJS module whose export is initialized with `void 0` and then
// assigned inside a conditional, and whose own functions call it through the
// exports object (`exports.now()`, as scheduler does). Node binds the call's
// `this` to the exports object; the assigned functions never read it, so the
// call compiles to the export's storage. The typed storage cannot hold the
// transient `undefined`, so the `void 0` preamble lowers to nothing when
// every path past it assigns the export.
import { now, later, since } from "clock-export";
import { now as earlyNow, later as earlyLater } from "clock-export-early";
import { a, b, describe } from "clock-export-chain";
import { later as effectLater, now as effectNow, calls } from "clock-export-effect";

console.log(typeof now, later(), String(since()));
console.log(typeof earlyNow, earlyLater(), String(earlyLater() === "number"));
console.log(describe(), a() + b());
console.log(effectLater(), effectNow(), calls());
