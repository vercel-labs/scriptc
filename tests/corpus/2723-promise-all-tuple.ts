// Promise.all over a TUPLE of promises: heterogeneous element types ride
// the tuple's positional types, result order matches input order, and the
// empty tuple resolves to length 0. (`as const` gives the literal a tuple
// shape the lowering can see.)
export async function fetchCombined(): Promise<[string, number]> {
  const p1 = Promise.resolve("hello");
  const p2 = Promise.resolve(42);
  return await Promise.all([p1, p2] as const);
}
console.log(await fetchCombined());
console.log(await Promise.all([Promise.resolve("a"), Promise.resolve(1), Promise.resolve(false)] as const));
console.log((await Promise.all([] as const)).length);
