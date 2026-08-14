// @dynamic
// Object.keys over an unknown object returns the checked-dynamic array
// representation, not a static array. Its predicate still cannot use void.
const source: unknown = { zero: 0, one: 1 };
const values = Object.keys(source as object);
const pred: (n: string) => void = (n) => n;
console.log(values.filter(pred).join(","));
// The callback's erased return makes this unsupported.
