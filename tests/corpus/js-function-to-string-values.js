// Function.prototype.toString over untyped JavaScript: a function value
// prints its own source text (there is no TypeScript syntax to erase), and a
// builtin method value prints its native-code form with its name.

/** @param {number} a */
function plain(a) {
  return a + 1;
}
const alias = /** @type {unknown} */ (plain);
console.log(String(alias));

/** @param {string} s @returns {number} */
const arrow = (s) => s.length;
const arrowAlias = /** @type {unknown} */ (arrow);
console.log(String(arrowAlias));

function defaults(a, b) {
  return a + b;
}
const defaultsAlias = /** @type {unknown} */ (defaults);
console.log(defaultsAlias.toString());

class Counter {
  /** @param {number} start */
  constructor(start) {
    this.value = start;
  }
  /** @param {number} by */
  add(by) {
    return this.value + by;
  }
}

const counter = new Counter(1);
const method = /** @type {unknown} */ (counter.add);
console.log(String(method));

const literal = {
  /** @param {number} x */
  twice(x) {
    return x * 2;
  },
};
const literalMethod = /** @type {unknown} */ (literal.twice);
console.log(String(literalMethod));

const bag = /** @type {unknown} */ ({ n: 1 });
console.log(String(bag.hasOwnProperty));
console.log(String(Array.prototype.push));

const list = /** @type {unknown[]} */ ([arrowAlias, alias]);
console.log(list.join(" | "));
