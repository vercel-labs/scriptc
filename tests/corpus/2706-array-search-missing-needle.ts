// Missing array reads are legal search needles. indexOf skips holes, while
// includes observes a hole as undefined; explicit undefined remains present
// and searchable in both methods.
const numbers: number[] = [];
numbers[1] = 0 / 0;
numbers[3] = -0;

console.log(numbers.indexOf(numbers[0]), numbers.includes(numbers[0]));
console.log(numbers.indexOf(0 / 0), numbers.includes(0 / 0));
console.log(numbers.indexOf(0), numbers.indexOf(-0), numbers.includes(0));

const optional: (number | undefined)[] = [];
optional[0] = undefined;
optional[2] = 4;

console.log(optional.indexOf(optional[0]), optional.includes(optional[0]));
console.log(optional.indexOf(optional[1]), optional.includes(optional[1]));

const kv: [string, string][] = [["host", "localhost"], ["port", "8080"]];
console.log(kv.indexOf(kv[1]), kv.includes(kv[1]));
console.log(kv.indexOf(kv[99]), kv.includes(kv[99]));
