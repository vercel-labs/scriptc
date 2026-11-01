// Destructuring a unit-typed source: `[a] = null`, `let { a } = undefined`
// and their forms. The IR has no standalone unit value, so the hidden source
// temp takes the checked-dynamic form; the pattern then throws Node's exact
// TypeError before any binding or target assignment. V8 spells the source by
// form: a bare `null` array source reads "null is not iterable" while a
// parenthesized one gets the generic runtime wording, a null-typed binding
// spells its name, and object patterns read "null" / "undefined" / the name.
// Everything below throws, so every line reports the error it caught.

const results = [];
function attempt(label, run) {
  try {
    const value = run();
    results.push(label + ": no throw (" + String(value) + ")");
  } catch (error) {
    results.push(label + ": " + error.constructor.name + ": " + error.message);
  }
}

attempt("let [a] = null", () => {
  let [a] = null;
  return a;
});
attempt("let [a] = (null)", () => {
  let [a] = (null);
  return a;
});
attempt("let [a] = undefined", () => {
  let [a] = undefined;
  return a;
});
attempt("let [] = null", () => {
  let [] = null;
  return "empty";
});
attempt("let [a = 1] = null", () => {
  let [a = 1] = null;
  return a;
});
attempt("let { a } = null", () => {
  let { a } = null;
  return a;
});
attempt("let { a } = (null)", () => {
  let { a } = (null);
  return a;
});
attempt("let { a } = undefined", () => {
  let { a } = undefined;
  return a;
});
attempt("let {} = null", () => {
  let {} = null;
  return "empty";
});
attempt("let { a = 1 } = null", () => {
  let { a = 1 } = null;
  return a;
});
attempt("let [{ a }] = null", () => {
  let [{ a }] = null;
  return a;
});
attempt("let { a: { b } } = null", () => {
  let { a: { b } } = null;
  return b;
});

attempt("[a] = null", () => {
  let a;
  [a] = null;
  return a;
});
attempt("[] = null", () => {
  [] = null;
  return "empty";
});
attempt("[a] = undefined", () => {
  let a;
  [a] = undefined;
  return a;
});
attempt("({ a } = null)", () => {
  let a;
  ({ a } = null);
  return a;
});
attempt("({ a } = (null))", () => {
  let a;
  ({ a } = (null));
  return a;
});
attempt("({} = null)", () => {
  ({} = null);
  return "empty";
});
attempt("({ a } = undefined)", () => {
  let a;
  ({ a } = undefined);
  return a;
});
attempt("({ a: b } = null)", () => {
  let b;
  ({ a: b } = null);
  return b;
});

const nullBinding = null;
attempt("let [a] = nullBinding", () => {
  let [a] = nullBinding;
  return a;
});
attempt("let { a } = nullBinding", () => {
  let { a } = nullBinding;
  return a;
});
const undefinedBinding = undefined;
attempt("let [a] = undefinedBinding", () => {
  let [a] = undefinedBinding;
  return a;
});
attempt("let { a } = undefinedBinding", () => {
  let { a } = undefinedBinding;
  return a;
});
attempt("[a] = nullBinding", () => {
  let a;
  [a] = nullBinding;
  return a;
});
attempt("({ a } = undefinedBinding)", () => {
  let a;
  ({ a } = undefinedBinding);
  return a;
});

console.log(results.join("\n"));
