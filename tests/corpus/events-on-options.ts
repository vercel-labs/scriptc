// events.on's argument ladders, Node-exact: the options bag must be a plain
// object, options.signal must carry `aborted` (a pre-aborted signal throws
// AbortError with the signal's reason as its cause), both watermark
// spellings validate through validateInteger with the modern name in the
// message, a nullish primary falls through to the lowercase alias, and the
// receiver must offer on() or addEventListener().
import { on } from "node:events";

type Thrown = Error & { code?: string; cause?: { message?: string } };

function fail(label: string, fn: () => unknown): void {
  try {
    fn();
    console.log(label, "no throw");
  } catch (err) {
    const e = err as Thrown;
    console.log(label, e.name, e.code, e.message, e.cause?.message ?? "-");
  }
}

const target = new EventTarget();

// validateObject: null, arrays, functions and primitives are refused, a
// class instance is an object like any other.
fail("options-null", () => on(target, "x", null as any));
fail("options-array", () => on(target, "x", [] as any));
fail("options-fn", () => on(target, "x", (() => {}) as any));
fail("options-string", () => on(target, "x", "s" as any));
fail("options-number", () => on(target, "x", 5 as any));
fail("options-date", () => on(target, "x", new Date() as any));

// validateAbortSignal: anything without an `aborted` property.
fail("signal-number", () => on(target, "x", { signal: 5 as any }));
fail("signal-object", () => on(target, "x", { signal: {} as any }));
fail("signal-null", () => on(target, "x", { signal: null as any }));

// The pre-aborted arm: AbortError whose cause is the reason.
const pre = new AbortController();
pre.abort(new Error("why"));
fail("signal-aborted", () => on(target, "x", { signal: pre.signal }));
const preReasonless = new AbortController();
preReasonless.abort();
fail("signal-aborted-empty", () => on(target, "x", { signal: preReasonless.signal }));

// validateInteger(value, "options.highWaterMark", 1).
fail("high-0", () => on(target, "x", { highWaterMark: 0 }));
fail("high-negative", () => on(target, "x", { highWaterMark: -1 }));
fail("high-fraction", () => on(target, "x", { highWaterMark: 1.5 }));
fail("high-nan", () => on(target, "x", { highWaterMark: NaN }));
fail("high-infinity", () => on(target, "x", { highWaterMark: Infinity }));
fail("high-string", () => on(target, "x", { highWaterMark: "2" as any }));
fail("high-alias-0", () => on(target, "x", { highWatermark: 0 }));

// validateInteger(value, "options.lowWaterMark", 1), after the high mark.
fail("low-0", () => on(target, "x", { lowWaterMark: 0 }));
fail("low-fraction", () => on(target, "x", { lowWaterMark: 2.5 }));
fail("low-string", () => on(target, "x", { lowWaterMark: "a" as any }));
fail("low-alias-0", () => on(target, "x", { lowWatermark: 0 }));

// The receiver ladder: null/undefined fail on the member read, anything
// else without on()/addEventListener() is the emitter argument.
fail("recv-null", () => on(null as any, "x"));
fail("recv-undefined", () => on(undefined as any, "x"));
fail("recv-number", () => on(5 as any, "x"));
fail("recv-object", () => on({} as any, "x"));
fail("recv-fn", () => on((() => {}) as any, "x"));

// The EventTarget protocol has no symbol form.
fail("target-symbol", () => on(target, Symbol("s")));

// Valid forms: the alias reaches the watermark data, and the nullish
// primary falls through to it.
const aliased = on(target, "a", { highWatermark: 3, lowWatermark: 2 });
const marks = (aliased as any)[Symbol.for("nodejs.watermarkData")];
console.log("alias", marks.size, marks.low, marks.high, marks.isPaused);
void aliased.return();
const fallthrough = on(target, "b", {
  highWaterMark: null as any,
  highWatermark: 5,
  lowWaterMark: null as any,
  lowWatermark: 4,
});
const marks2 = (fallthrough as any)[Symbol.for("nodejs.watermarkData")];
console.log("nullish", marks2.low, marks2.high);
void fallthrough.return();
const explicit = on(target, "c", { highWaterMark: 7, highWatermark: 9 });
const marks3 = (explicit as any)[Symbol.for("nodejs.watermarkData")];
console.log("explicit", marks3.high);
void explicit.return();

// An explicit undefined options value is the plain form.
const plain = on(target, "d", undefined);
void plain.return();
console.log("plain ok");
