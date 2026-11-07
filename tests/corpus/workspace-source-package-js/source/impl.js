import { double } from "./helper.js";

/** @param {(n: number) => number} f */
const through = (f) => (/** @type {number} */ n) => f(n) + 1;

export const value = through(double)(20);
export { greet } from "./helper.js";
