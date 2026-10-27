// Promise.all over a generic array instantiated with a union of a value and
// a promise, with an element read of its result: the call is refused by name.
async function f<V>(xs: V[]): Promise<void> {
  const values = await Promise.all(xs);
  values[0];
}
f<string | Promise<number>>(["x"]);
export {};
