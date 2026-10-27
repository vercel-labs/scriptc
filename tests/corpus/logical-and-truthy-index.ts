// `&&` whose left operand is an array, object or function value: every
// object is truthy, so the result is the right operand, here an element
// read that may be undefined at run time.
const list = [3, 1, 2];
const head = list && list[0];
console.log(head);
const words: string[] = ["x"];
console.log(words && words[0], words && words[5]);
const empty: number[] = [];
console.log(empty && empty[0]);
function first(xs: (string | number)[]): string | number {
  return xs && xs[0];
}
console.log(first([1]), first(["s"]));
type Item = { n: number } | string;
const items: Item[] = [{ n: 1 }, "z"];
console.log(items && items[0], items && items[1]);
const nested: number[][] = [[1]];
console.log(nested && nested[0]);
const flags: boolean[] = [false];
console.log(flags && flags[0]);
const maybe: (number | null)[] = [null];
console.log(maybe && maybe[0]);
const holes: (number | undefined)[] = [undefined, 4];
console.log(holes && holes[0], holes && holes[1]);
const box = { k: [1, 2] };
console.log(box.k && box.k[1]);
// The left operand still evaluates exactly once.
let reads = 0;
const source = (): number[] => {
  reads++;
  return [7, 8];
};
console.log(source() && source()[1], reads);
const table: Record<string, number[]> = { a: [5] };
const pick = (key: string): number | undefined => table[key] && table[key][0];
console.log(pick("a"), reads);
class Holder {
  xs = [1, 2];
  second(): number | undefined {
    return this.xs && this.xs[1];
  }
}
console.log(new Holder().second());
