// A union-typed spread source beside a property whose key is decided at
// run time. No arm's field list names that key, so the literal is not
// built per arm: it takes the copy Node makes, keys in the order written,
// also when the key names a field of the other arm.
type Source = { a: number } | { b: string };
function before(source: Source, key: string) {
  return { [key]: 1, ...source };
}
function after(source: Source, key: string) {
  return { ...source, [key]: 1 };
}
for (const source of [{ a: 1 }, { b: "2" }] as Source[]) {
  for (const key of ["x", "a"]) {
    console.log(JSON.stringify(before(source, key)), JSON.stringify(after(source, key)));
  }
}
