// A destructuring declaration whose source is one object or array type or
// null/undefined (`s.match(re)`, `items.find(...)`) throws Node's TypeError
// when the source is null or undefined, with V8's message for the source
// spelling, and binds normally otherwise.

function show(label, fn) {
  try {
    fn();
  } catch (error) {
    console.log(label, error instanceof TypeError, error.message);
  }
}

const text = "abc";
show("object-call", () => {
  const { index } = text.match(/z/);
  console.log("never", index);
});
show("object-empty", () => {
  const {} = text.match(/z/);
  console.log("never");
});
show("object-identifier", () => {
  const found = "abc".match(/z/);
  const { index, input } = found;
  console.log("never", index, input);
});
show("object-string-key", () => {
  const found = "abc".match(/z/);
  const { "index": at } = found;
  console.log("never", at);
});
show("array-method-call", () => {
  const [whole] = "abc".match(/z/);
  console.log("never", whole);
});
show("array-identifier", () => {
  const found = "abc".match(/z/);
  const [whole, group] = found;
  console.log("never", whole, group);
});

const items = [
  { name: "a", size: 1 },
  { name: "b", size: 2 },
];
show("object-undefined", () => {
  const { name } = items.find((item) => item.size > 5);
  console.log("never", name);
});
function firstMatch(text) {
  return text.match(/q/);
}
show("array-function-call", () => {
  const [first] = firstMatch("abc");
  console.log("never", first);
});

// A source that may be null or undefined, and data arms holding a
// generator, which has no untyped form.
function* count() {
  yield 1;
  yield 2;
}
function pick(kind) {
  if (kind === 0) return null;
  if (kind === 1) return undefined;
  return { counter: count(), label: "picked" };
}
function counters(present) {
  return present ? [count(), count()] : null;
}
show("object-null-arm", () => {
  const { counter } = pick(0);
  console.log("never", counter);
});
show("object-undefined-arm", () => {
  const { label } = pick(1);
  console.log("never", label);
});
show("array-generator-elements", () => {
  const [first] = counters(false);
  console.log("never", first);
});
const { counter, label } = pick(2);
const [left, right] = counters(true);
console.log(label, [...counter].join(","), [...left, ...right].join(","));

// Sources that hold a value bind as before.
const { index } = "abc".match(/b/);
const [whole] = "abc".match(/c/);
const { name, size } = items.find((item) => item.size > 1);
console.log("bound", index, whole, name, size);
