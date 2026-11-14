// @ts-check
// The JSDoc form of the same resolution: svelte 4's
// `@param {import('./utils.js')['not_equal']}` names the imported member's
// value type without spelling `typeof`.
import { k, f, record } from "./n.mjs";

/** @type {import('./n.mjs')['k']} */
const count = 3;

/** @param {import('./n.mjs')['f']} mapper */
function apply(mapper) {
  return mapper(count);
}

/** @type {import('./n.mjs')['record']} */
const value = record;

console.log(typeof count, count + 1);
console.log(apply(f), apply((n) => n + 100));
console.log(value.kind, typeof value.n, record.n);
