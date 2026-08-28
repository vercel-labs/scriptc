// @dynamic
// A direct Object.keys call over a dynamic object has a checker-array type
// but a checked-dynamic value. Its predicate still cannot use void.
const pred: (n: string) => void = (n) => n;
console.log(Object.keys(JSON.parse('{"zero":0,"one":1}')).filter(pred).join(","));
// The callback's erased return makes this unsupported.
