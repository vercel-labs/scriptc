// Array.prototype methods called with .call on native arrays run the arrays' own
// methods, which mutate the array in place: copyWithin, fill, reverse,
// sort, push, pop, splice, and the read-only join, indexOf and includes.
const optional: (number | undefined)[] = [1, 2, 3, 4];
Array.prototype.copyWithin.call(optional, 0, 2, 4);
console.log(optional.join(","));
const nums: number[] = [5, 1, 4, 2, 3];
Array.prototype.fill.call(nums, 0, 0, 1);
console.log(nums.join(","));
console.log(Array.prototype.reverse.call(nums) === nums, nums.join(","));
Array.prototype.sort.call(nums, (a: number, b: number) => a - b);
console.log(nums.join(","));
console.log(Array.prototype.push.call(nums, 9, 10), nums.join(","));
console.log(Array.prototype.pop.call(nums), nums.length);
console.log(Array.prototype.splice.call(nums, 1, 2).join(","), nums.join(","));
console.log(Array.prototype.join.call(nums, "-"), Array.prototype.indexOf.call(nums, 4));
const words: string[] = ["c", "a", "b"];
Array.prototype.sort.call(words);
console.log(words.join(","), Array.prototype.includes.call(words, "a"));
const records: { id: number }[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
Array.prototype.copyWithin.call(records, 1, 0, 1);
console.log(records.map((r) => r.id).join(","), records[0] === records[1]);

// The callback methods bind `this` to their thisArg, for native arrays
// through .call and for dynamic arrays called directly.
type Scale = { k: number; seen: number[] };
const scale: Scale = { k: 10, seen: [] };
const values: number[] = [1, 2, 3, 4];
Array.prototype.forEach.call(values, function (this: Scale, v: number) {
  this.seen.push(v);
}, scale);
console.log(scale.seen.join(","));
console.log(Array.prototype.map.call(values, function (this: Scale, v: number) {
  return v * this.k;
}, scale).join(","));
console.log(Array.prototype.filter.call(values, function (this: Scale, v: number) {
  return v * this.k > 15;
}, scale).join(","));
console.log(
  Array.prototype.some.call(values, function (this: Scale, v: number) { return v === this.k / 5; }, scale),
  Array.prototype.every.call(values, function (this: Scale, v: number) { return v < this.k; }, scale),
  Array.prototype.find.call(values, function (this: Scale, v: number) { return v * this.k === 30; }, scale),
  Array.prototype.findIndex.call(values, function (this: Scale, v: number) { return v * this.k === 30; }, scale),
  Array.prototype.findLast.call(values, function (this: Scale, v: number) { return v * this.k < 30; }, scale),
  Array.prototype.findLastIndex.call(values, function (this: Scale, v: number) { return v * this.k < 30; }, scale),
);
console.log(Array.prototype.flatMap.call(values, function (this: unknown, v: number) {
  return [v, v * (this as Scale).k];
}, scale).join(","));
const parsed: any = JSON.parse("[1, 2, 3]");
const sum = { total: 0 };
parsed.forEach(function (this: { total: number }, v: number) {
  this.total += v;
}, sum);
console.log(sum.total, parsed.map(function (this: Scale, v: number) { return v * this.k; }, scale).join(","));
class Counter {
  total = 0;
  addAll(items: number[]): number {
    Array.prototype.forEach.call(items, (v: number) => {
      this.total += v;
    });
    return this.total;
  }
}
console.log(new Counter().addAll(values));
