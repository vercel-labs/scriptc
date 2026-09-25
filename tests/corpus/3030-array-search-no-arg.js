console.log([0].includes(), [undefined].includes(), [null].includes(), [].includes());
console.log([undefined, 0, undefined].includes());

const holes = [2];
holes[2] = 2;
console.log(holes.includes());

const untyped = [];
untyped[2] = 2;
console.log(untyped.includes());

const present = [undefined, 1];
present[3] = undefined;
console.log(present.includes());

let evaluations = 0;
function receiver() { evaluations++; return [undefined, 1]; }
console.log(receiver().includes(), evaluations);
