// Number.parseInt without a radix parses as the global parseInt does: radix
// 10, or 16 after a 0x prefix, after leading whitespace and a sign, stopping
// at the first character that is not a digit.
const inputs = ["42", "  17px", "0x1F", "-0x10", "0X0a", "08", "010", "1e3", "", "  ", "abc", "  -0", "+12", "9007199254740993", "0b11", "0o17", "\t\n 99 bottles", "١٢", "-", "0x"];
for (const text of inputs) {
  const parsed = Number.parseInt(text);
  console.log(JSON.stringify(text), Object.is(parsed, -0) ? "-0" : String(parsed), parsed === parseInt(text));
}

function depth(arg: string | undefined): number {
  return Math.max(6, Number.parseInt(arg ?? "10"));
}
console.log("depth", depth(process.argv[2]), depth("21"), depth("3"));

const sizes = "640x480".split("x").map((part) => Number.parseInt(part));
console.log("sizes", sizes[0]! * sizes[1]!);
