// Typed code that builds, throws, catches and reads plain errors stays out
// of the dynamic object model: the release executable of this program
// defines no dynamic-tier runtime symbol
// (tests/harness/typed-error-dynamic-tier.test.ts).
export {};

function digit(text: string, offset: number): number {
  if (offset >= text.length) throw new RangeError(`end of input at ${offset}`);
  const code = text.charCodeAt(offset) - 48;
  if (code < 0 || code > 9) throw new SyntaxError(`not a digit: ${text[offset]}`);
  return code;
}
function parse(text: string): number {
  if (text === "abort") throw new Error();
  if (text.length === 0) throw new RangeError("empty input");
  if (text.length > 6) throw new Error("too long: " + text);
  if (text === "type") throw new TypeError();
  if (text === "call") throw Error("called without new");
  if (text === "uri") throw new URIError("uri");
  if (text === "eval") throw new EvalError("eval");
  if (text === "ref") throw new ReferenceError("ref");
  let value = 0;
  for (let offset = 0; offset < 3; offset++) value = value * 10 + digit(text, offset);
  return value;
}

const inputs = ["123", "12", "1x3", "", "1234567", "abort", "type", "call", "uri", "eval", "ref"];
for (const text of inputs) {
  try {
    console.log("value", parse(text));
  } catch (error) {
    if (error instanceof RangeError) console.log("range", error.name, error.message);
    else if (error instanceof SyntaxError) console.log("syntax", error.name, error.message);
    else if (error instanceof TypeError) console.log("type", error.name, error.message.length);
    else if (error instanceof Error) {
      console.log("error", error.name, error.message, error instanceof URIError);
      console.log((error.stack ?? "").split("\n")[0]);
    }
  }
}

let failures = 0;
for (let round = 0; round < 1000; round++) {
  try {
    parse(round % 3 === 0 ? "9x" : "7");
  } catch (error) {
    if (error instanceof SyntaxError && error.message.length > 0) failures += 2;
    else if (error instanceof Error) failures++;
  }
}
console.log("failures", failures);
