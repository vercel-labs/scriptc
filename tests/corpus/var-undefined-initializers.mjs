// Function-scoped `var` bindings initialized with `void 0` or `undefined`,
// read as is or reassigned later, the way generated module glue declares
// them.
async function load(options) {
  var fail = (message, error) => {
    throw error;
  },
    base = void 0,
    prefix = "";
  try {
    prefix = new URL(".", base).href;
  } catch {}
  console.log(base, JSON.stringify(prefix), typeof base, base === undefined);
  return [base, options.name];
}
load({ name: "glue" }).then((value) => console.log(value));

function later(n) {
  var result = void 0;
  var label = undefined;
  if (n > 1) {
    result = n * 2;
    label = "n=" + n;
  }
  return [result, label, typeof result, typeof label];
}
console.log(later(1), later(2));

function rebuilt(n) {
  var items = void 0;
  items = [n];
  items.push(n + 1);
  return items.length + items[1];
}
console.log(rebuilt(5));

function letForms(flag) {
  let pending = void 0;
  let held = undefined;
  if (flag) {
    pending = { ready: true };
    held = 3;
  }
  return [pending, held];
}
console.log(letForms(false), letForms(true));

// A closure created before the declaration reads the hoisted binding.
function hoisted() {
  const read = () => value;
  const before = read();
  var value = void 0;
  value = "set";
  return [before, read()];
}
console.log(hoisted());

// A declaration in a loop assigns the one binding on every pass.
function loop() {
  const seen = [];
  for (let i = 0; i < 3; i++) {
    var slot = void 0;
    seen.push(slot);
    slot = i;
    seen.push(slot);
  }
  return seen;
}
console.log(loop());

function discarded() {
  var unused = void 0;
  return 1;
}
console.log(discarded());

// Reads after a later assignment hold the stored value wherever they go: a
// push, an array or object literal, an argument, a logical operator.
function show(value) {
  return typeof value + ":" + String(value);
}
function consumers(flag) {
  let slot = void 0;
  var other = void 0;
  const seen = [];
  seen.push(slot, other);
  if (flag) {
    slot = 4;
    other = "o";
  }
  seen.push(slot, other);
  const pair = [slot, other];
  const record = { slot, other, both: slot && other };
  console.log(seen, pair, record);
  console.log(show(slot), show(other), `${slot}-${other}`, slot ?? "unset", other || "none");
}
consumers(false);
consumers(true);
