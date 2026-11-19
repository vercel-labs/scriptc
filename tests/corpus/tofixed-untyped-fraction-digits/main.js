// A `.toFixed()` fractionDigits value the checker leaves untyped (a `var` a
// function assigns, an `any`-typed field): the number converts it with Node's
// ToIntegerOrInfinity, and an undefined or absent value means the zero-digit
// form. Before, the call kept the standard-library fence and threw at run
// time where Node formats.
const value = 12.3456;

var digits;
function setDigits() {
  digits = 2;
}
setDigits();
console.log(value.toFixed(digits));

class Hud {
  constructor() {
    /** @type {any} */
    this.precision = 1;
  }
}
const hud = new Hud();
console.log(value.toFixed(hud.precision));
hud.precision = "3";
console.log(value.toFixed(hud.precision));

console.log(value.toFixed(2));
console.log(value.toFixed());
console.log(value.toFixed(undefined));
console.log(value.toFixed(null));
console.log(value.toFixed(true));

for (const places of [0, 1, 5]) console.log(value.toFixed(places));

try {
  console.log(value.toFixed(/** @type {any} */ (101)));
} catch (error) {
  console.log(error.constructor.name);
}
try {
  console.log(value.toFixed(/** @type {any} */ (Number.NaN)));
} catch (error) {
  console.log(error.constructor.name);
}
try {
  console.log(value.toFixed(/** @type {any} */ (Symbol("places"))));
} catch (error) {
  console.log(error.constructor.name);
}
