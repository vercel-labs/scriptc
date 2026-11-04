// Array.prototype's methods read off an array literal: the read answers the
// function Array.prototype holds, so borrowing one through call or apply runs
// the generic algorithm over strings, typed arrays and plain array-likes. A
// dynamic receiver reads the same functions, generic methods included.

function report(label, fn) {
  try {
    console.log(label, String(fn()));
  } catch (error) {
    console.log(label, error.name);
  }
}

console.log(typeof [].slice);
console.log([].slice === Array.prototype.slice);
console.log([].slice === [].slice);
console.log([].slice.length, [].slice.name);
console.log(typeof [].sort, typeof [].join, typeof [].indexOf, typeof [].includes);
console.log(typeof [].toString, [].toString());

const bytes = new Uint8Array([1, 2, 3]);
const copy = [].slice.call(bytes);
console.log(copy.length, copy[0], copy[2]);
console.log(Array.isArray(copy));
console.log([].join.call([1, 2, 3], "-"));
console.log([].slice.call("abcd", 1, 3).join(""));
console.log([].slice.apply({ 0: "a", 1: "b", 2: "c", length: 3 }, [1]).join(""));
console.log([].indexOf.call("abc", "c"));
console.log([].includes.call(bytes, 3));

const dynamic = JSON.parse("[4, 5, 6]");
console.log(typeof dynamic.map, typeof dynamic.forEach);
console.log(dynamic.map === Array.prototype.map);
console.log(dynamic.map((value) => value * 2).join(","));
console.log(dynamic.filter((value) => value > 4).join(","));
console.log(dynamic.reduce((sum, value) => sum + value, 0));

const own = JSON.parse('{"slice": "own"}');
console.log(own.slice);

report("slice-null", () => [].slice.call(null));
report("byte-length", () => [].slice.call(bytes, 1).length);
