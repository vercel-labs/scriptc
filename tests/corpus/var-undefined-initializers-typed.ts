// Function-scoped `var` bindings whose type is `undefined`: the binding holds
// undefined, as a `let` of the same type does.
function base(): string {
  var unset = void 0;
  var declared: undefined = undefined;
  let alsoUnset = void 0;
  return [typeof unset, typeof declared, typeof alsoUnset, String(unset === declared)].join(" ");
}
console.log(base());

function resolveAgainst(input: string): string {
  var root = void 0;
  try {
    return new URL(input, root).href;
  } catch {
    return "invalid: " + input;
  }
}
console.log(resolveAgainst("https://example.com/a/b"), resolveAgainst("relative"));

// `var x = undefined` is an evolving binding: later assignments widen it.
function evolving(n: number): string {
  var value = undefined;
  if (n > 0) value = n * 10;
  return String(value);
}
console.log(evolving(0), evolving(2));
