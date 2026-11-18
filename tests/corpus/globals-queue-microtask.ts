// queueMicrotask: callbacks enter the same FIFO promise continuations ride
// (source order against Promise.then), a callback runs with no arguments,
// and a non-function argument throws Node's synchronous
// ERR_INVALID_ARG_TYPE, whose message names what arrived. The non-function
// cases arrive through an `unknown` binding, so they lower through the
// checked-dynamic entry the runtime validates.
function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "no throw");
  } catch (error) {
    const e = error as Error & { code?: string; name?: string };
    console.log(label, e.name, e.code, e.message);
  }
}

const order: string[] = [];
queueMicrotask(() => order.push("first"));
order.push("sync");
Promise.resolve().then(() => order.push("promise"));
queueMicrotask(() => order.push("second"));
queueMicrotask(() => {
  order.push("outer");
  queueMicrotask(() => order.push("inner"));
});

const numberValue: unknown = 1;
const objectValue: unknown = {};
const missingValue: unknown = undefined;
attempt("number", () => queueMicrotask(numberValue as never));
attempt("object", () => queueMicrotask(objectValue as never));
attempt("undefined", () => queueMicrotask(missingValue as never));

setTimeout(() => {
  console.log(order.join(","));
}, 0);
