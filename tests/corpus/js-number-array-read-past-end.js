// JavaScript element reads whose consumers cannot tell undefined from NaN
// lower to a plain number holding NaN for an index past the end of the
// array. A consumer that can tell them apart — string conversion, a strict
// comparison, an array literal, a property write — keeps the undefined
// answer, and two reads that both stand for undefined still compare equal.
'use strict';

const numbers = [3, 1, 4];

console.log(numbers[7] + 1);
console.log(numbers[7] | 0);
console.log(numbers[7] > 2);
console.log(numbers[7] < 2);
console.log(numbers[2] * 2);

console.log(String(numbers[7]));
console.log(numbers[7] === undefined);
console.log(numbers[7] !== undefined);
console.log(numbers[7] === numbers[8]);
console.log([numbers[7]]);

const nested = [[1, 2], [3]];
console.log(nested[0][5] + 10);
console.log(String(nested[1][2]));

let acc = 0;
for (const value of numbers) acc += value;
console.log(acc + numbers[9]);
