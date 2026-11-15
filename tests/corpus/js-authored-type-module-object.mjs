// A module-level object the program types with its own JSDoc, next to one the
// overlay infers: both bindings keep the same object through a function that
// writes a field and returns it, so the writes are visible to every reader.
/**
 * @type {{ hits: number }}
 */
export const box = { hits: 0 };
const mirror = { hits: 0 };
function bump(value) {
  value.hits += 1;
  return value;
}
function read(value) {
  return value.hits;
}
bump(box);
bump(mirror);
bump(box);
console.log(bump(box) === box, bump(mirror) === mirror, read(box), read(mirror), box.hits, mirror.hits);
