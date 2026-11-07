// A hole in a tuple-typed array literal is an absent element: `in` and the
// own-key probes report no property at that index, Object.keys and for-in
// skip it, and reads answer undefined.
const one: [string?] = [,];
const two: [number, number?] = [1, ,];
console.log(0 in one, one.length, one[0]);
console.log(1 in two, two.length, two[1]);
console.log(Object.keys(one).length, Object.keys(two).length);
console.log(Object.prototype.hasOwnProperty.call(one, "0"));
console.log(Object.prototype.propertyIsEnumerable.call(two, "1"));

function present(t: readonly unknown[]): number {
  let count = 0;
  for (let i = 0; i < t.length; i++) if (i in t) count++;
  return count;
}
console.log(present(one), present(two));

function keys(t: readonly unknown[]): string {
  let out = "";
  for (const key in t) out += key + ",";
  return out;
}
console.log(keys(one), keys(two));

// A trailing comma is not a hole, and a hole in a position typed without
// undefined is a source error.
const trailing: [number, number?] = [1, ,];
console.log(trailing.length, 1 in trailing);
console.log(JSON.stringify(one), JSON.stringify(two));

// A hole stays absent when the literal also spreads a fixed tuple, on both
// sides of the spread.
const before: [number, number?, number?] = [1, , ...([9] as [number])];
console.log(1 in before, before.length, before[1], JSON.stringify(before));
const after: [number, number?, number?] = [1, ...([2] as [number]), ,];
console.log(2 in after, after.length, after[2], Object.keys(after).join(","));
