// Static functions of the builtin constructors taken off them by
// destructuring: each binding is the function its spelled read answers,
// and takes its arguments without a receiver.
const { isArray } = Array;
const { keys, entries, values, assign, freeze } = Object;
const { isInteger, isFinite: finite, parseFloat: toFloat } = Number;
const { fromCharCode } = String;

console.log(isArray([1]), isArray('x'), isArray === Array.isArray);
console.log(keys({ a: 1, b: 2 }).join(','), entries({ k: 'v' })[0].join('='), values({ p: 3 })[0]);
console.log(assign({ a: 1 }, { b: 2 }).b, Object.isFrozen(freeze({ c: 3 })));
console.log(isInteger(3), isInteger(3.5), finite(1 / 0), toFloat('1.5px'), fromCharCode(72, 105));

function allArrays(...candidates) {
  return candidates.every((candidate) => isArray(candidate));
}
console.log(allArrays([], [1]), allArrays([], 'no'));

function inside() {
  const { isArray: check } = Array;
  const { keys: names } = Object;
  return check(names({ z: 1 })) && names({ z: 1 })[0] === 'z';
}
console.log(inside(), [[1], 2, [3]].filter(isArray).length, ['1', 'x'].map(toFloat).join(','));
