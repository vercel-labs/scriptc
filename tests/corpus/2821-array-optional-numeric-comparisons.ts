// Numeric consumers use JavaScript's ToNumber(undefined) = NaN while
// strict equality keeps the original undefined union arm. A wider array
// element union may use number operations after a typeof guard without
// losing that runtime-optional representation.
const numbers: number[] = [5];
console.log(numbers[4] < 10, numbers[4] <= 10, numbers[4] > 10, numbers[4] >= 10);
console.log(numbers[4] === numbers[4]);
const missing: number | undefined = numbers[4];
console.log(missing === undefined, missing !== undefined);

let indexCalls = 0;
function missingIndex(): number {
  indexCalls++;
  return 4;
}
console.log(numbers[missingIndex()] < 10, indexCalls);

const mixed: (string | number)[] = ["first", 20];
const second = mixed[1];
if (typeof second === "number") {
  console.log(second + 1, second < 30, second === 20);
}
