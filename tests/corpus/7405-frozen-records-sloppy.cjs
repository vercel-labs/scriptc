// Writes to frozen records in sloppy-mode code leave them unchanged, where
// strict mode code throws (7404). The records are typed through JSDoc, so
// the writes are native record writes.

/** @typedef {{ count: number, label: string }} Counter */
/** @typedef {{ id: number, note?: string }} Note */
/** @typedef {{ kind: "a", name: string }} Small */
/** @typedef {{ kind: "b", name: string, size: number }} Large */

/** @param {Counter} c */
function bump(c) {
  c.count += 1;
  c.label = c.label + "!";
}

/** @param {Note} n */
function dropNote(n) {
  delete n.note;
}

/** @param {number} count @returns {Counter} */
function counter(count) {
  return { count: count, label: "c" + count };
}

const open = counter(1);
const frozen = Object.freeze(counter(2));
bump(open);
bump(frozen);
console.log(JSON.stringify(open), JSON.stringify(frozen), Object.isFrozen(frozen));

/** @type {Note} */
const note = { id: 1, note: "n" };
Object.freeze(note);
dropNote(note);
console.log(JSON.stringify(note));

/** @param {Small | Large} shape */
function rename(shape) {
  shape.name = "renamed";
}

/** @param {boolean} large @returns {Small | Large} */
function shapeOf(large) {
  return large ? { kind: "b", name: "b", size: 1 } : { kind: "a", name: "a" };
}

const openShape = shapeOf(true);
const frozenShape = shapeOf(false);
Object.freeze(frozenShape);
rename(openShape);
rename(frozenShape);
console.log(openShape.name, frozenShape.name);
