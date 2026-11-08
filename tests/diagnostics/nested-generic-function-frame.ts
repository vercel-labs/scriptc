// A nested generic `function` declaration that captures a value whose TYPE
// is the enclosing function's own type parameter cannot share one compiled
// instance: each instantiation of the enclosing function would need a
// different capture type, which a trailing parameter cannot carry. The form
// is refused by name.
function outer<T>(value: T): string {
  function show<U>(other: U): string {
    return `${String(value)}:${String(other)}`;
  }
  return show(1);
}
console.log(outer("x"));
