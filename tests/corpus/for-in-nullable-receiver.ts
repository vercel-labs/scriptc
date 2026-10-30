// for-in over a value that may be null or undefined runs zero times for
// either and walks a present record, array or index-signature record. The
// receiver is evaluated once.
function keys(value: { a: number } | null | undefined): string {
  let result = "";
  for (const key in value) result += key;
  return result;
}
console.log("[" + keys(null) + "] [" + keys(undefined) + "] [" + keys({ a: 1 }) + "]");

function maybeNull(value: { a: number; b: string } | null): string[] {
  const out: string[] = [];
  for (const key in value) out.push(key);
  return out;
}
console.log(maybeNull(null), maybeNull({ a: 1, b: "x" }));

function indexes(values: string[] | undefined): string {
  let result = "";
  for (const index in values) result += index;
  return result;
}
console.log(indexes(undefined), indexes(["p", "q", "r"]));

function dictionary(map: Record<string, number> | undefined): string {
  const seen: string[] = [];
  for (const key in map) seen.push(`${key}=${map![key]}`);
  return seen.join(",");
}
console.log(dictionary(undefined), dictionary({ x: 1, y: 2 }));

let reads = 0;
function source(present: boolean): { a: number; b: number } | undefined {
  reads++;
  return present ? { a: 1, b: 2 } : undefined;
}
const visited: string[] = [];
for (const key in source(true)) visited.push(key);
for (const key in source(false)) visited.push(key);
console.log(visited, reads);

outer: for (const round of [1, 2]) {
  for (const key in round === 1 ? { a: 1, b: 2, c: 3 } : null) {
    if (key === "b") continue outer;
    console.log(round, key);
  }
  console.log("after", round);
}
