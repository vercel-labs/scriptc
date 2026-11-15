// A JavaScript guard that passes its argument to a Number predicate is
// compiled once per argument type. The instances for strings, booleans,
// bigints, arrays and objects answer false, as the predicates never coerce.

function isNumber(value) {
  return Number.isFinite(value);
}
function isWhole(value) {
  return Number.isInteger(value);
}
function isMissing(value) {
  return Number.isNaN(value);
}

console.log(isNumber(1), isNumber("1"), isNumber(true), isNumber(1n), isNumber([1]), isNumber({ n: 1 }));
console.log(isNumber(Infinity), isNumber(NaN), isNumber(null), isNumber(undefined));
console.log(isWhole(2), isWhole(2.5), isWhole("2"), isWhole(false));
console.log(isMissing(NaN), isMissing("NaN"), isMissing(0), isMissing(undefined));

function describe(value) {
  return isNumber(value) ? "number" : typeof value;
}
console.log(["a", 1, true, 2n, null].map(describe).join(","));
