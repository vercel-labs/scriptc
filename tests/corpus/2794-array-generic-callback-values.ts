// Generic callback values remain generic until each HOF call supplies a
// concrete signature. The optional-array prepass must not ask the generic
// parameter for a monomorphic ABI too early.
const identity = <T>(value: T): T => value;
const pair = <A, B>(left: A, right: B): string => `${left}|${right}`;
const numberIdentity = identity<number | undefined>;

console.log([1, 2, 3].map(numberIdentity).join("+"));
console.log([1, 2, 3].filter((value) => value > 1).join(","));
console.log([1, 2, 3].reduce((sum, value) => sum + value, 0));
console.log(pair(7, "seven"));

const f: (value: number) => number = identity;
console.log(f(41));
