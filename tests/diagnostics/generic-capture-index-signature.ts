// A captured value's type can name an enclosing function's type parameter
// without the parameter being a type argument: `{ [key: string]: T }` names
// it in an index signature, so the captured object varies with the
// instantiation even though the walk sees no property to follow. A copy of
// it in the shared instance would then lose the writes made through it.

function outer<T>(seed: T): string {
  const table: { [key: string]: T } = {};
  const inner = <U>(x: U): string => `${String(x)}${String(table["k"])}`;
  return inner(3);
}
console.log(outer<number>(1));
