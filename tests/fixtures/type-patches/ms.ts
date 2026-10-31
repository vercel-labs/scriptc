// ms's JSDoc says parse() returns a Number and ms() a String or Number;
// for text it cannot parse both return undefined.
import ms from "ms";

for (const text of ["2 hours", "not a duration", "1".repeat(101), "-1.5d"]) {
  const value = ms(text);
  console.log(value === undefined ? "invalid" : value);
}
console.log(ms(90_000), ms(90_000, { long: true }));
