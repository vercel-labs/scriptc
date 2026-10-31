// Untyped values frozen in sloppy-mode code and then held as typed records
// stay frozen: writes through typed parameters and a typed `this` leave them
// unchanged, as Node does, and Object.isFrozen answers true. An unfrozen value
// checked into the same record type stays writable.

/** @typedef {{ count: number, label: string }} Counter */

/** @param {Counter} c @param {number} by */
function bump(c, by) {
  c.count += by;
  c.label = c.label + "!";
  return c.count;
}

/** @this {Counter} @param {number} by */
function bumpThis(by) {
  this.count += by;
  this.label = "this";
  return this.count;
}

/** @type {Counter} */
const literal = Object.freeze({ count: 1, label: "a" });
console.log(bump(literal, 2), bumpThis.call(literal, 3), JSON.stringify(literal), Object.isFrozen(literal));

/** @type {Counter} */
const parsed = Object.freeze(JSON.parse('{"count":10,"label":"b"}'));
console.log(bump(parsed, 2), bumpThis.call(parsed, 3), JSON.stringify(parsed), Object.isFrozen(parsed));

/** @type {Counter} */
const open = JSON.parse('{"count":100,"label":"c"}');
console.log(bump(open, 2), bumpThis.call(open, 3), JSON.stringify(open), Object.isFrozen(open));

/** @type {Counter[]} */
const list = [Object.freeze({ count: 5, label: "l" }), { count: 6, label: "m" }];
for (const item of list) bump(item, 1);
console.log(JSON.stringify(list), Object.isFrozen(list[0]), Object.isFrozen(list[1]));
