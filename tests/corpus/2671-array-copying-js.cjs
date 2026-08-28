// JavaScript permits the zero-argument Array.prototype.toSpliced form even
// though TypeScript's declaration requires `start`. It returns a fresh
// shallow copy; it must not share the one-argument form's delete-to-end
// default.

const source = [1, 2, 3];
const copied = source.toSpliced();
copied[0] = 9;
console.log(copied.join(","), source.join(","));
