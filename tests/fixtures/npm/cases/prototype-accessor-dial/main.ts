// A package whose functions get their members from one shared prototype
// object: an accessor read makes the next function and remembers it on the
// function it was read from, and the package's class answers such a
// function from its constructor, so `new` yields a callable.
import dial from "dial";

const kilograms = new dial.Scale({ unit: "kg", places: 1 });
const whole = new dial.Scale();

console.log(dial(7), dial.double(7), dial.half.floor(7), dial.negate.double.half(7));
console.log(kilograms(2), kilograms.half(2.5), kilograms.double.negate(0.75), kilograms.unit);
console.log(whole.floor(9.99), whole.unit === "", typeof kilograms, typeof whole.half);
console.log(kilograms.half === kilograms.half, kilograms.half === whole.half, kilograms.double.double(1.25));
console.log([1, 2.5, 10].map((amount) => kilograms.double(amount)).join(" | "));
