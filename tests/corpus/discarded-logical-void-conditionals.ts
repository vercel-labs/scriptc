// A logical expression whose result is discarded and whose right operand is
// a conditional of void calls (`skip || (flag ? warnA() : warnB())`) runs as
// a branch: the left operand decides whether the conditional runs, and the
// conditional runs one arm.
const order: string[] = [];
function check(label: string, value: boolean): boolean {
  order.push(label);
  return value;
}
function emit(label: string): void {
  order.push(label);
}

for (const left of [false, true]) {
  for (const flag of [false, true]) {
    check("and", left) && (check("flag", flag) ? emit("and:yes") : emit("and:no"));
    check("or", left) || (check("flag", flag) ? emit("or:yes") : emit("or:no"));
    left || (flag && (check("inner", !flag) ? emit("nested:yes") : emit("nested:no")));
    left || (order.push("comma"), flag ? emit("comma:yes") : emit("comma:no"));
    !left && (flag ? (left ? emit("deep:a") : emit("deep:b")) : emit("deep:c"));
  }
}
console.log(order.join(" "));
order.length = 0;

// A for loop's initializer and update discard their results too.
let steps = 0;
for (
  check("init", false) || (check("init flag", true) ? emit("init:yes") : emit("init:no"));
  steps < 2;
  check("update", true) && (steps > 1 ? emit("update:last") : emit("update:next"))
) {
  steps++;
}
console.log(steps, order.join(" "));
order.length = 0;

// The left operand narrows the conditional.
function describe(value: string | number): void {
  typeof value === "string" && (value.length > 2 ? emit(value.toUpperCase()) : emit(value));
  typeof value === "number" || (value === "" ? emit("empty") : emit(`text:${value}`));
}
describe("abc");
describe("ab");
describe("");
describe(7);
console.log(order.join(" "));
order.length = 0;

// A generic callback: the conditional's type is T, void for the first two
// calls and number for the last.
function choose<T>(skip: boolean, flag: boolean, a: () => T, b: () => T): void {
  skip || (flag ? a() : b());
}
choose(false, true, () => emit("generic:a"), () => emit("generic:b"));
choose(false, false, () => emit("generic:a"), () => emit("generic:b"));
choose(true, true, () => emit("generic:skipped"), () => emit("generic:skipped"));
choose(false, true, () => order.push("number:a"), () => order.push("number:b"));
console.log(order.join(" "));
order.length = 0;

// A throw from the chosen arm propagates.
try {
  choose(false, false, () => emit("unused"), () => {
    throw new Error("from b");
  });
} catch (error) {
  console.log((error as Error).message);
}
