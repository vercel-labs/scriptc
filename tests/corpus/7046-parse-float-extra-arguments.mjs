// parseFloat reads one argument; Node ignores any others.
const radix = 10;
const inputs = ["3.25", "  -0.5e2xyz", "0x10", "Infinityx", ".5", "-.e1", "", "1_000"];
console.log(inputs.map((text) => parseFloat(text, 10)));
console.log(inputs.map((text) => parseFloat(text, radix, "ignored")));
const fromJson = JSON.parse('{"value":"12.5kg","n":7}');
console.log(parseFloat(fromJson.value, 10), parseFloat(fromJson.n, radix), Object.is(parseFloat("-0", 10), -0));
const values = ["1.5", "2.25"].map((text) => parseFloat(text.replace(/_/g, ""), 10));
console.log(values, values[0] + values[1]);
