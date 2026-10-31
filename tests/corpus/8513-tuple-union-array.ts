// A union that holds an array arm beside tuple arms, flowing into that array
// type: Node has one array either way, so both arms answer as arrays instead
// of the tuple arm trapping in the checked extraction.
type Mixed = ["one"] | string[];
function pick(flag: boolean): Mixed {
  return flag ? ["one"] : ["two", "three"];
}
function take(value: string[]): string {
  return `${value.length}:${value.join(",")}`;
}
for (const flag of [true, false]) {
  const m = pick(flag);
  const arr: string[] = m;
  console.log(flag, arr.length, arr.join(","), take(m), arr[0]);
}
type Readonly = readonly ["a"] | readonly string[];
const r: Readonly = ["b", "c"];
const plain: readonly string[] = r;
console.log("readonly", plain.length, plain.join(","));
const narrow: ["one"] = ["one"];
const one: string[] = narrow;
console.log("single", one.length, one.join(","));
const optional: string[] | undefined = ["x"];
const lifted: string[] = optional!;
console.log("optional", lifted.length);
