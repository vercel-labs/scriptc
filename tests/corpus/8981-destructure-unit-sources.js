// Destructuring reads its source before any element runs: an object pattern
// goes through RequireObjectCoercible, an array pattern through GetIterator.
// A source whose JavaScript type is already null or undefined therefore
// throws V8's TypeError with no compiled element code behind it, and the
// pattern's own text decides the message: V8 names the initializer (an
// identifier, a literal in canonical form, a call's callee, ".for" for a
// for-of head) and otherwise describes the runtime value ("object null").
// A number, boolean, bigint or symbol source throws the same way, and a
// string source is iterable and does not throw. Node is the oracle: every
// case prints the thrown error's name and message.
function report(label, fn) {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    console.log(label, e.name + ": " + e.message);
  }
}

report("decl-array-null", () => {
  const [a] = null;
});
report("decl-array-undefined", () => {
  const [a] = undefined;
});
report("decl-array-identifier", () => {
  const v = null;
  const [a] = v;
});
report("decl-array-false", () => {
  const [a] = false;
});
report("decl-array-number", () => {
  const [a] = 5;
});
report("decl-array-negative", () => {
  const [a] = -1.5;
});
report("decl-array-hex", () => {
  const [a] = 0x10;
});
report("decl-array-rest", () => {
  const [...r] = null;
});
report("decl-array-call", () => {
  const f = () => null;
  const [a] = f();
});
report("decl-array-property", () => {
  const o = { x: null };
  const [a] = o.x;
});
report("decl-array-string", () => {
  const [a] = "str";
  console.log("decl-array-string element:", a);
});
report("decl-object-empty", () => {
  const {} = null;
});
report("decl-object-empty-ident", () => {
  const v = null;
  const {} = v;
});
report("decl-object-undefined-ident", () => {
  const v = undefined;
  const {} = v;
});
report("decl-object-key", () => {
  const { x } = null;
});
report("decl-object-key-undefined", () => {
  const { x } = undefined;
});
report("decl-object-default", () => {
  const { x = 1 } = null;
});
report("decl-object-computed", () => {
  const k = "a";
  const { [k]: y } = null;
});
report("decl-object-nested-key", () => {
  const { x: { y } } = null;
});
report("decl-object-call", () => {
  const f = () => null;
  const { x } = f();
});
report("decl-object-property", () => {
  const o = { y: null };
  const { x } = o.y;
});
report("assign-object-property", () => {
  const o = { y: null };
  let x;
  ({ x } = o.y);
});
report("assign-array", () => {
  let a;
  [a] = null;
});
report("assign-array-ident", () => {
  const v = undefined;
  let a;
  [a] = v;
});
report("assign-array-rest", () => {
  let r;
  [...r] = undefined;
});
report("assign-object", () => {
  let x;
  ({ x } = null);
});
report("assign-object-empty", () => {
  ({} = null);
});
report("assign-object-default", () => {
  let x;
  ({ x = 1 } = null);
});
report("assign-object-rest", () => {
  let r;
  ({ ...r } = null);
});
report("nested-object", () => {
  const [{ a }] = [null];
});
report("for-of-decl-array", () => {
  for (const [a] of [null]) {
  }
});
report("for-of-decl-object", () => {
  for (const { a } of [null]) {
  }
});
report("for-of-decl-object-default", () => {
  for (const { a = 1 } of [null]) {
  }
});
report("for-of-assign-array", () => {
  let a;
  for ([a] of [null]) {
  }
});
report("for-of-assign-object", () => {
  let a;
  for ({ a } of [null]) {
  }
});
