// `includes` and `indexOf` on a `string | string[]` value: JavaScript reads
// the method off the value it holds, so a string searches for a substring
// and an array searches for an element. The call dispatches on the arm the
// value holds; the needle is evaluated once, after the receiver.
// Differentially vs Node.

function pick(flag: boolean): string | string[] {
  return flag ? "alpha-beta" : ["alpha", "beta"];
}

function show(label: string, value: string | string[]): void {
  console.log(
    label,
    value.includes("alpha"),
    value.includes("gamma"),
    value.indexOf("beta"),
    value.indexOf("gamma"),
  );
}

show("string", pick(true));
show("array", pick(false));

// The needle evaluates once per call on either arm.
let calls = 0;
function needle(): string {
  calls += 1;
  return "alpha";
}
function once(value: string | string[]): void {
  const found = value.includes(needle());
  console.log("once", found, calls);
}
once(pick(true));
once(pick(false));

// Empty receivers: no substring, no element.
const emptyString: string | string[] = "";
console.log("empty string", emptyString.includes("x"), emptyString.indexOf("x"));
const emptyArray: string | string[] = [];
console.log("empty array", emptyArray.includes("x"), emptyArray.indexOf("x"));

// Through an interface field and a loop binding.
interface Holder {
  value: string | string[];
}
const holders: Holder[] = [{ value: "x|y" }, { value: ["x", "y"] }];
for (const holder of holders) {
  console.log("held", holder.value.includes("y"), holder.value.indexOf("y"));
}

// A parameter keeps the union for every arm.
function found(list: string | string[]): number {
  return list.indexOf("b") >= 0 ? 1 : 0;
}
console.log("found", found("abc"), found(["a"]), found("a"), found(["b"]));
