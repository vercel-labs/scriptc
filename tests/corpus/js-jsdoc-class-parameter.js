// @ts-nocheck
// A JavaScript file TypeScript does not check keeps a JSDoc class parameter
// as a hint, not a promise: three's Color.getRGB(target) is handed a plain
// { r, g, b } and Node stores into it. The parameter takes checked-dynamic
// storage, and a function that answers that parameter answers its
// checked-dynamic value instead of converting it back to the class.

export class Color {
  constructor(value = 0) {
    this.value = value;
  }
  /** @param {Color} target */
  getRGB(target) {
    target.r = this.value;
    return target;
  }
}

const rgb = { r: 0, g: 0, b: 0 };
const color = new Color(7);
const returned = color.getRGB(rgb);
console.log("rgb", rgb.r, rgb.g, rgb.b, returned === rgb);

/** @returns {Color} */
function reread(target = new Color(1)) {
  target.value = 2;
  return target;
}

const record = { value: 0 };
console.log("reread", reread(record).value, reread().value);

/** @param {Color} first */
function swap(first, second) {
  first.value = second.value;
  return second;
}

const left = { value: 5 };
const right = { value: 9 };
console.log("swap", swap(left, right).value, left.value);
