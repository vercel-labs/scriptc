// A declared optional member over an index signature (`alg?: string` beside
// `[key: string]: unknown`, the JsonWebKey shape) reads as a checked
// value the checker still types with an undefined arm. Storing it into a
// `(string | undefined)[]` keeps the present undefined in the slot's state
// for every element position: an array literal, an index write, push and
// unshift, splice and toSpliced, with and fill, and Array.of and the Array
// constructor.
interface WebKey {
  alg?: string;
  kty?: string;
  ext?: boolean;
  [key: string]: unknown;
}

const key: WebKey = { kty: "oct", ext: true };
const empty: WebKey = {};

console.log(JSON.stringify([key.alg, key.kty]));
console.log(JSON.stringify([empty.alg]));
console.log(JSON.stringify([empty.alg, empty.kty, empty.ext]));
console.log(JSON.stringify([empty.ext, key.ext]));

// An index write and the mutation methods store the same present undefined.
const written: (string | undefined)[] = [];
written[0] = empty.alg;
written[1] = key.kty;
console.log(JSON.stringify(written), written.length, written[0] === undefined);

const pushed: (string | undefined)[] = [];
console.log(pushed.push(empty.alg, key.kty), JSON.stringify(pushed));
const unshifted: (string | undefined)[] = ["z"];
console.log(unshifted.unshift(empty.alg), JSON.stringify(unshifted));

const spliced: (string | undefined)[] = ["a", "b"];
console.log(JSON.stringify(spliced.splice(1, 0, empty.alg, key.kty)), JSON.stringify(spliced));
console.log(JSON.stringify(spliced.toSpliced(0, 0, empty.alg)));

const replaced: (string | undefined)[] = ["a"];
console.log(JSON.stringify(replaced.with(0, empty.alg)), JSON.stringify(replaced));
const filled: (string | undefined)[] = ["a", "b"];
console.log(JSON.stringify(filled.fill(empty.alg)));

console.log(JSON.stringify(Array.of(empty.alg, key.kty)));
console.log(JSON.stringify(new Array(empty.alg, key.kty)));

// A boolean element over the same shape keeps its own payload.
const flags: (boolean | undefined)[] = [];
flags.push(empty.ext, true);
console.log(JSON.stringify(flags), flags[0] === undefined, flags[1]);
console.log(JSON.stringify([empty.ext, true]));
