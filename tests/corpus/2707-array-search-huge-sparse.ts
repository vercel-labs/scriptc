// Searches must jump over a billion-index hole run instead of visiting every
// absent position. The completion itself is the regression signal.
const high = 1_000_000_000;
const sparse: number[] = [];
sparse[high] = 7;

console.log(sparse.length);
console.log(sparse.indexOf(sparse[high]), sparse.includes(sparse[high]));

const missing = sparse[high - 1];
console.log(sparse.includes(missing));
