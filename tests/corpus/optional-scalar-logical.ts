// `&&` and `||` over optional scalars (`boolean | undefined` and
// `number | undefined`) yield the deciding operand itself: a falsy left
// value keeps its exact tag and payload, and the right operand runs only
// when it decides the result.

let rightRuns = 0;

function rightBool(): boolean | undefined {
  rightRuns++;
  return true;
}

function rightNumber(value: number): number | undefined {
  rightRuns++;
  return value;
}

const flags: boolean[] = [true, false];
const emptyFlags: (boolean | undefined)[] = [];
const numbers: number[] = [7, 0, -0, NaN];
const emptyNumbers: (number | undefined)[] = [];

function showBool(value: boolean | undefined): string {
  if (value === true) return "true";
  if (value === false) return "false";
  return "undefined";
}

function showNumber(value: number | undefined): string {
  if (value === undefined) return "undefined";
  if (value !== value) return "NaN";
  if (value === 0 && Object.is(value, -0)) return "-0";
  return String(value);
}

console.log("and=true", showBool(flags[0] && rightBool()), rightRuns);
console.log("and=false", showBool(flags[1] && rightBool()), rightRuns);
console.log("and=undefined", showBool(emptyFlags[0] && rightBool()), rightRuns);
console.log("or=true", showBool(flags[0] || rightBool()), rightRuns);
console.log("or=false", showBool(flags[1] || rightBool()), rightRuns);
console.log("or=undefined", showBool(emptyFlags[0] || rightBool()), rightRuns);

console.log("num-and=7", showNumber(numbers[0] && rightNumber(3)), rightRuns);
console.log("num-and=0", showNumber(numbers[1] && rightNumber(3)), rightRuns);
console.log("num-and=-0", showNumber(numbers[2] && rightNumber(3)), rightRuns);
console.log("num-and=NaN", showNumber(numbers[3] && rightNumber(3)), rightRuns);
console.log("num-and=undefined", showNumber(emptyNumbers[0] && rightNumber(3)), rightRuns);
console.log("num-or=0", showNumber(numbers[1] || rightNumber(3)), rightRuns);
console.log("num-or=-0", showNumber(numbers[2] || rightNumber(3)), rightRuns);
console.log("num-or=NaN", showNumber(numbers[3] || rightNumber(3)), rightRuns);
console.log("num-or=undefined", showNumber(emptyNumbers[0] || rightNumber(0)), rightRuns);
console.log("num-or=7", showNumber(numbers[0] || rightNumber(3)), rightRuns);

// A chain over three element reads: each link is itself a union-typed
// `&&`, and a missing element decides the result.
function chain(i: number, j: number, k: number): number | undefined {
  return numbers[i] && numbers[j] && numbers[k];
}
console.log("chain=7", showNumber(chain(0, 0, 0)), rightRuns);
console.log("chain=hole", showNumber(chain(0, 4, 0)), rightRuns);
console.log("chain=0", showNumber(chain(1, 0, 0)), rightRuns);
console.log("chain=-0", showNumber(chain(2, 0, 0)), rightRuns);

// Stored results keep the deciding operand, not a coerced boolean.
const stored: boolean | undefined = emptyFlags[0] && rightBool();
const storedNumber: number | undefined = numbers[2] && rightNumber(9);
const storedOr: number | undefined = numbers[1] || rightNumber(-0);
console.log("stored", showBool(stored), showNumber(storedNumber), showNumber(storedOr), rightRuns);
console.log("branch", stored ? "yes" : "no", storedOr ? "yes" : "no");

const table = new Map<string, number>();
table.set("zero", 0);
table.set("seven", 7);
console.log("map", showNumber(table.get("zero") && table.get("seven")), rightRuns);
console.log("map", showNumber(table.get("seven") || table.get("zero")), rightRuns);
console.log("map", showNumber(table.get("absent") || table.get("zero")), rightRuns);
