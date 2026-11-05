// A destructuring declaration over an untyped source (the result of an
// untyped function, a parameter, a property of an untyped object) checks
// the source first: a null or undefined source throws Node's TypeError,
// which names the source and the first property, before any key is read.

function show(label, fn) {
  try {
    fn();
  } catch (error) {
    console.log(label, error instanceof TypeError, error.message);
  }
}

const table = { size: 3, entry: null, nested: { inner: undefined } };
function lookup(key) {
  return table[key];
}
function read(source) {
  const { size, name } = source;
  return [size, name];
}

show("call-null", () => {
  const { size } = lookup("entry");
  console.log("never", size);
});
show("call-undefined", () => {
  const { size, label } = lookup("missing");
  console.log("never", size, label);
});
show("parameter", () => {
  console.log("never", read(null));
});
show("property-chain", () => {
  const { value } = table.nested.inner;
  console.log("never", value);
});
show("renamed-and-default", () => {
  const { size: count = 0, rest } = lookup("entry");
  console.log("never", count, rest);
});
show("first-default", () => {
  const { size = 0 } = lookup("missing");
  console.log("never", size);
});
show("later-default", () => {
  const { size, name = "none" } = lookup("entry");
  console.log("never", size, name);
});
show("computed-key-default", () => {
  const key = "size";
  const { [key]: value = 0 } = lookup("entry");
  console.log("never", value);
});
show("string-key", () => {
  const { "two words": both } = lookup("missing");
  console.log("never", both);
});
show("rest-first", () => {
  const { ...all } = lookup("entry");
  console.log("never", all);
});

// Sources that hold a value bind as before, including primitives.
const { size } = lookup("size") === 3 ? table : null;
const { length } = lookup("missing") ?? "text";
console.log("bound", size, length, read({ size: 1, name: "one" }).join(","));
