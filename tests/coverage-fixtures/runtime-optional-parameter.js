// A short JavaScript call passes undefined to a parameter its JSDoc does not
// mark optional: the parameter holds undefined at runtime, and the checker
// still types its reads as number.

/** @param {number} value */
function describe(value) {
  return value.toFixed(1);
}

console.log(describe());
