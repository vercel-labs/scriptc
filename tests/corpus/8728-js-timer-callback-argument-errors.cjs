// A timer whose callback is not a function throws Node's
// ERR_INVALID_ARG_TYPE where the call runs, for a literal as for an untyped
// value, and schedules nothing.
function shape(label, fn) {
  try {
    fn();
    console.log(label, "scheduled");
  } catch (e) {
    console.log(label, e instanceof TypeError, e.name, e.code, JSON.stringify(e.message));
  }
}
const untyped = (value) => value;

shape("setTimeout string", () => setTimeout("x"));
shape("setTimeout string with delay", () => setTimeout("x", 1));
shape("setTimeout number", () => setTimeout(5, 1));
shape("setTimeout undefined", () => setTimeout(undefined, 1));
shape("setTimeout null", () => setTimeout(null));
shape("setTimeout object", () => setTimeout({}, 1));
shape("setTimeout array with arguments", () => setTimeout([], 1, "a", "b"));
shape("setTimeout untyped string", () => setTimeout(untyped("x"), 1));
shape("setInterval string", () => setInterval("x", 10));
shape("setInterval boolean", () => setInterval(true, 10));
shape("setImmediate string", () => setImmediate("x"));
shape("setImmediate number with arguments", () => setImmediate(5, 1, 2));
shape("setImmediate undefined", () => setImmediate(undefined));

// The delay and the trailing arguments are evaluated before the check.
const order = [];
const note = (name, value) => {
  order.push(name);
  return value;
};
shape("order", () => setTimeout("x", note("delay", 1), note("argument", 2)));
console.log(order.join(","));

// Functions still schedule and run with their arguments. The immediate is
// created by the timer's callback: Node does not say which of a timer and an
// immediate created in the same turn runs first (a start that takes longer
// than the delay lets the timer come due before the loop's first turn).
shape("setTimeout function", () =>
  setTimeout(() => {
    console.log("timeout fired");
    shape("setImmediate function", () => setImmediate((a, b) => console.log("immediate fired", a, b), 1, 2));
  }, 2),
);
