// Date ISO formatting: new Date(ms).toISOString() with Node's exact
// UTC formatting (expanded years, fractional-ms truncation, RangeError on
// invalid values), plus the Date.now() contract (values are wall-clock, so
// properties — not values — are compared).
console.log(new Date(0).toISOString());
console.log(new Date(1).toISOString(), new Date(-1).toISOString());
console.log(new Date(1.9).toISOString(), new Date(-1.9).toISOString());
console.log(new Date(1e12).toISOString(), new Date(-1e12).toISOString());
console.log(new Date(86400000).toISOString(), new Date(-86400000).toISOString());
console.log(new Date(951782400000).toISOString()); // 2000-02-29, a leap day
console.log(new Date(253402300799999).toISOString()); // the last 4-digit-year ms
console.log(new Date(253402300800000).toISOString()); // the first +010000 ms
console.log(new Date(-62198755200000).toISOString()); // a negative year
console.log(new Date(8640000000000000).toISOString()); // the range maximum
console.log(new Date(-8640000000000000).toISOString()); // the range minimum
console.log(new Date(123456789012345).toISOString());

// Invalid time values throw Node's catchable RangeError.
try {
  new Date(0 / 0).toISOString();
} catch (e) {
  if (e instanceof RangeError) console.log("nan:", e.message);
}
try {
  new Date(8640000000000001).toISOString();
} catch (e) {
  if (e instanceof RangeError) console.log("over:", e.message);
}

// Date.now(): an integer in a sane wall-clock window, monotone across the
// composed no-argument form (both read the same clock).
const t = Date.now();
console.log(Number.isInteger(t), t > 1700000000000, t < 4102444800000);
console.log(new Date().toISOString().length, new Date(t).toISOString().endsWith("Z"));
