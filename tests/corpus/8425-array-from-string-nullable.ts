// Array.from over a string the checker narrowed through a guard, and over
// code points (surrogate pairs stay whole), each a fresh array.
const values: (string | undefined)[] = ["abc", undefined, "a\u{1F600}b"];
for (const value of values) {
  if (value === undefined) {
    console.log("skip");
    continue;
  }
  const chars = Array.from(value);
  console.log(chars.length, chars.join("|"));
}
const maybe: string | undefined = "xy";
if (maybe !== undefined) console.log(Array.from(maybe).length);
const plain: string = "q";
console.log(Array.from(plain), Array.from(plain).length);
function guarded(v: string | undefined): boolean {
  return v !== undefined && Array.from(v).length > 1;
}
console.log(guarded("ab"), guarded("a"), guarded(undefined));
