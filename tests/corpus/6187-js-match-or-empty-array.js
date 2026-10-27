// `s.match(re) || []` types the empty array as an empty tuple that the
// typescript-go API panics to describe (moment.js's configFromStringAndFormat).
// The union reads through its widened members, so the whole program
// compiles, including the statements whose lowering asks about that type.

/** @param {string} s */
function firstDigit(s) {
  return (s.match(/\d/) || [])[0];
}

/** @param {string} s */
function digitCount(s) {
  let count = 0;
  for (const ch of s) if (ch >= '0' && ch <= '9') count++;
  return count;
}

const parsers = { firstDigit, digitCount };
console.log(typeof parsers.firstDigit, parsers.digitCount('a1b22'));
console.log(firstDigit('a1b22'), firstDigit('none'));
