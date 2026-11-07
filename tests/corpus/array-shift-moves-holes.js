// shift() moves every value down one index and the holes with them: an index
// that held a hole is still a hole after the move, an element that moves into
// a hole takes no descriptor from it, and the index the shift removes becomes
// a hole. The array answers its own length and key set afterwards, so a hole
// reported at the wrong index shows up in the `in` checks and in join().
// The arrays arrive from a parameter whose type is not known, so shift() runs
// against a checked-dynamic value.
/** @param {any} value */
function dyn(value) {
  return value;
}

const a = dyn([1, , 3]);
console.log(a.shift(), a.length, 0 in a, 1 in a, 2 in a, a.join(','));

const b = dyn([, 2, 3]);
console.log(b.shift(), b.length, 0 in b, 1 in b, 2 in b, b.join(','));

const c = dyn([1, 2, , 4]);
console.log(c.shift(), c.length, 0 in c, 1 in c, 2 in c, c.join(','));

// A second shift keeps moving the remaining hole with the values around it.
console.log(a.shift(), a.length, 0 in a, 1 in a, a.join(','));
