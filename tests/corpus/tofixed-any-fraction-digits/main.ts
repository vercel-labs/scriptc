// A `.toFixed()` fractionDigits typed `any`: the number converts it with
// Node's ToIntegerOrInfinity, and an undefined value means the zero-digit
// form. A typed file kept the standard-library fence here and threw at run
// time where Node formats.
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
