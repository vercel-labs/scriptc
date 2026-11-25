// A `.toFixed()` fractionDigits typed `any`: the number converts it with
// Node's ToIntegerOrInfinity, and an undefined value means the zero-digit
// form. A typed file kept the standard-library fence here and threw at run
// time where Node formats. The receiver still evaluates before the
// argument, and a written undefined is toFixed(0)'s exact decimal integer.
const value = 12.3456;

let digits: any = 2;
console.log(value.toFixed(digits));

let places: any;
function setPlaces() {
  places = 1;
}
setPlaces();
console.log(value.toFixed(places));

console.log(value.toFixed(undefined));
console.log(value.toFixed("3" as any));
try {
  console.log(value.toFixed(101 as any));
} catch (error) {
  console.log(error instanceof RangeError ? "RangeError" : "other");
}

// The receiver is evaluated before the argument, even when the argument's
// undefined value is discarded.
const order: string[] = [];
function receiveNumber(): number {
  order.push("receiver");
  return 1.2345;
}
function effectfulUndefined(): undefined {
  order.push("digits");
  return undefined;
}
console.log(receiveNumber().toFixed(effectfulUndefined()));
console.log(order.join(","));

// A written undefined argument means toFixed(0) with the exact decimal
// integer, not the shortest round-trip text of the omitted-digits fast path.
console.log((2 ** 60).toFixed(undefined));
console.log((123456789012345680000).toFixed(undefined));
console.log((1e21).toFixed(undefined));
