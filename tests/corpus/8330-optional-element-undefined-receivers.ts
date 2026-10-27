// Optional element access on bindings whose type admits undefined: an
// undefined receiver short-circuits to undefined without evaluating the
// key, and a present receiver reads the element as a plain access does.

function first(kinds: string[] | undefined, i: number): string {
  const kind = kinds?.[i];
  return kind === undefined ? "none" : String(kind);
}
console.log(first(undefined, 0));
console.log(first(["a", "b"], 1));
console.log(first(["a"], 5));

function orDefault(values: number[] | undefined, i: number): number {
  return values?.[i] ?? -1;
}
console.log(orDefault(undefined, 0), orDefault([4, 5], 1), orDefault([4], 3));

function isMissing(flags: boolean[] | undefined, i: number): boolean {
  return flags?.[i] === undefined;
}
console.log(isMissing(undefined, 0), isMissing([true], 0), isMissing([false], 2));

function head(pair: [string, number] | undefined): string {
  return pair?.[0] ?? "empty";
}
console.log(head(undefined), head(["x", 1]));

function lookup(table: Record<string, number> | undefined, key: string): number | undefined {
  return table?.[key];
}
console.log(lookup(undefined, "a"), lookup({ a: 1 }, "a"), lookup({ a: 1 }, "b"));

function width(words: string[] | undefined, i: number): number {
  return words?.[i]?.length ?? 0;
}
console.log(width(undefined, 0), width(["abc"], 0), width(["abc"], 1));

// The key is not evaluated when the receiver is undefined.
let keys = 0;
function nextKey(): number {
  keys++;
  return 0;
}
function counted(items: string[] | undefined): string | undefined {
  return items?.[nextKey()];
}
console.log(counted(undefined), keys);
console.log(counted(["k"]), keys);

// Local bindings, including one reassigned between reads.
function maybe(present: boolean): number[] | undefined {
  return present ? [7, 8] : undefined;
}
let current = maybe(false);
console.log(current?.[0]);
current = maybe(true);
console.log(current?.[1]);
current = maybe(false);
console.log(current?.[1]);

function local(present: boolean): string {
  const items: string[] | undefined = present ? ["p", "q"] : undefined;
  const second = items?.[1];
  return second ?? "absent";
}
console.log(local(true), local(false));

// A sparse array reads its holes as undefined.
const sparse: number[] = [1];
sparse[3] = 4;
function at(values: number[] | undefined, i: number): string {
  const value = values?.[i];
  return value === undefined ? "hole" : String(value);
}
console.log(at(sparse, 1), at(sparse, 3), at(undefined, 3));
