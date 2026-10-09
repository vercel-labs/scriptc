// Number.parseFloat and Number.parseInt are the global parsers; over
// string arguments they compile to the same static parse.
const inputs = ["12.5px", "  -0", "Infinity", "", "1e3", ".5", "0x1A", "007", "1_000", "-12.9", "abc"];
for (const s of inputs) {
  console.log(JSON.stringify(s), Number.parseFloat(s), Number.parseInt(s, 10), parseFloat(s));
}
console.log(Number.parseInt("ff", 16), Number.parseInt("0x1A", 16), Number.parseInt("z", 36), Number.parseInt("12", 2));
console.log(Object.is(Number.parseFloat("-0"), -0), Number.isNaN(Number.parseInt("", 10)));
