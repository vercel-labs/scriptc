// Module-level records and arrays of untyped JavaScript that functions read
// and write: element and field updates are seen through every reference,
// identity comparisons hold, and class instances of a base class and its
// subclass share one array.
class Cursor {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  step(dx, dy) {
    this.x += dx;
    this.y += dy;
    return this;
  }
}
class Marker extends Cursor {
  constructor(x, y, label) {
    super(x, y);
    this.label = label;
  }
}
const settings = { scale: 2, offset: { x: 1, y: -1 } };
const history = [];
const cursors = [];
for (let i = 0; i < 6; i++)
  cursors.push(i % 2 === 0 ? new Cursor(i, -i) : new Marker(i, -i, "m" + i));
function record(cursor) {
  const entry = { x: cursor.x * settings.scale + settings.offset.x, y: cursor.y + settings.offset.y };
  history.push(entry);
  return entry;
}
function shift(offset) {
  offset.x += 1;
  offset.y -= 1;
  return offset;
}
let last = null;
for (let r = 0; r < 12; r++) {
  const cursor = cursors[r % cursors.length];
  const moved = cursor.step((r % 3) - 1, (r % 2) - 1);
  last = record(moved);
  if (moved !== cursor) console.log("receiver changed");
  if (r % 4 === 3) shift(settings.offset);
}
const offset = settings.offset;
console.log(shift(offset) === settings.offset, settings.offset.x, settings.offset.y);
console.log(history.length, history[history.length - 1] === last, last.x, last.y);
console.log(cursors.map((c) => (c instanceof Marker ? `${c.label}:${c.x}` : `${c.x},${c.y}`)).join(" "));
settings.scale = 3;
console.log(record(cursors[1]).x, history.indexOf(last), JSON.stringify(settings));
// Literals declared together in one statement are typed like separate ones:
// the lowering keeps each dynamic, so a function that takes one sees the
// same object, not a copy.
const firstBox = { hits: 0 }, secondBox = { hits: 0 };
function bump(box) {
  box.hits += 1;
  return box;
}
console.log(bump(firstBox) === firstBox, bump(secondBox) === secondBox, firstBox.hits, secondBox.hits);
