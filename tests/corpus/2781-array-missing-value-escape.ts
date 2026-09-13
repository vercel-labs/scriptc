// With unchecked indexed access, TypeScript's annotation is not a proof
// that a JavaScript array read produced a value.
function inspectNumber(value: number): string {
  return `${typeof value}:${value}:${value + 1}`;
}

function readNumber(values: number[], index: number): number {
  return values[index];
}

function forwardNumber(value: number): number {
  return value;
}

function describeForwarded(value: number): string {
  return inspectNumber(forwardNumber(value));
}

const values: number[] = [8];
const missing = values[3];
console.log("local", typeof missing, missing, missing + 1);
console.log("argument", inspectNumber(missing));
console.log("return", inspectNumber(readNumber(values, 3)));
console.log("forwarded", describeForwarded(missing));
const box: { value: number } = { value: missing };
console.log("field", inspectNumber(box.value));

function shorten(input: number[]): void {
  input.pop();
}

if (values.length > 0) {
  shorten(values);
  console.log("after-alias-mutation", inspectNumber(values[0]));
}
