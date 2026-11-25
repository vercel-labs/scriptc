// JavaScript documents the indexed object with JSDoc (`@typedef` with an
// index signature beside optional members). A member read is the checker's
// `string | undefined` and a checked value at run time, so an array literal,
// an index write and a push into a `(string | undefined)[]` keep the present
// undefined Node keeps.
/** @typedef {{ alg?: string, kty?: string, ext?: boolean, [key: string]: unknown }} Key */

/** @type {Key} */
const key = { kty: "oct", ext: true };
/** @type {Key} */
const empty = {};

console.log(JSON.stringify([key.alg, key.kty]));
console.log(JSON.stringify([empty.alg]));
console.log(JSON.stringify([empty.ext, key.ext]));

/** @type {Array<string | undefined>} */
const written = [];
written[0] = empty.alg;
written[1] = key.kty;
console.log(JSON.stringify(written), written.length, written[0] === undefined);

/** @type {Array<string | undefined>} */
const pushed = [];
console.log(pushed.push(empty.alg, key.kty), JSON.stringify(pushed));

/** @type {Array<boolean | undefined>} */
const flags = [];
flags.push(empty.ext, true);
console.log(JSON.stringify(flags), flags[0] === undefined, flags[1]);
