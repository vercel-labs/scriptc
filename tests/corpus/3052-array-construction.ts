// Array construction, iteration, holes, and mapper mutations.
const numeric = new Array<number>(4);
console.log("count", numeric.length, 0 in numeric, numeric[0] === undefined);
numeric[1] = 12;
console.log("count-write", numeric.length, 1 in numeric, 2 in numeric, numeric[1]);

const words = new Array<string>(2);
console.log("word-holes", words.length, 0 in words, words[0] === undefined);
console.log("elements", new Array(5, 6).join("|"), new Array("5").join("|"));
const called: number[] = Array(3);
console.log("called", called.length, 0 in called);
console.log("called-elements", Array(5, 6).join("|"), Array("5").join("|"));
function mixedArgument(value: number | string): void {
  const made = new Array<number | string>(value);
  console.log("mixed", made.length, 0 in made, made[0]);
}
mixedArgument(3);
mixedArgument("three");
try {
  mixedArgument(-1);
} catch (error) {
  if (error instanceof Error) console.log("mixed-invalid", error.name, error.message);
}
console.log("of", Array.of(5).join("|"), Array.of(1, 2, 3).join("|"), Array.of<string>().length);
const spread = [8, 9];
console.log("of-spread", Array.of(7, ...spread, 10).join("|"));
const sparseSpread: number[] = [];
sparseSpread.length = 2;
sparseSpread[1] = 4;
const spreadWithHole = Array.of(...sparseSpread);
console.log("of-hole", spreadWithHole.length, 0 in spreadWithHole, spreadWithHole[0] === undefined, spreadWithHole[1]);

function invalidLength(length: number): void {
  try {
    new Array<number>(length);
  } catch (error) {
    if (error instanceof Error) console.log("invalid", length, error.name, error.message);
  }
}
invalidLength(-1);
invalidLength(2.5);
invalidLength(4294967296);

const sparse: number[] = [];
sparse.length = 3;
sparse[1] = 7;
const copy = Array.from(sparse);
console.log("copy", copy.length, 0 in copy, 1 in copy, 2 in copy, copy[0] === undefined, copy[1]);
console.log("source", 0 in sparse, 1 in sparse, 2 in sparse);

const mapped = Array.from(sparse, (value, index) => `${index}:${value === undefined ? "missing" : value}`);
console.log("mapped", mapped.join("|"));

const records = [{ id: 1 }, { id: 2 }];
const shallow = Array.from(records);
console.log("identity", shallow !== records, shallow[0] === records[0], shallow[1] === records[1]);
const singleton = Array.of(records[0]!);
console.log("of-reference", singleton[0] === records[0]);
console.log("set", Array.from(new Set([3, 1, 3, 2])).join("|"));
console.log("string-map", Array.from("A💫B", (character, index) => `${index}:${character}`).join("|"));

const growing = [2, 3];
const grown = Array.from(growing, (value, index) => {
  if (index === 0) growing.push(4);
  return value * 10 + index;
});
console.log("grow", grown.join("|"), growing.length);

const shrinking = [2, 3, 4];
const shrunk = Array.from(shrinking, (value, index) => {
  if (index === 0) shrinking.length = 1;
  return value;
});
console.log("shrink", shrunk.join("|"), shrinking.length);
