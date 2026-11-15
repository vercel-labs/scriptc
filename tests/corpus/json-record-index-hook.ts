// A record whose unknown index signature holds a callable `toJSON`: Node
// calls it with the member's key before writing the record, and its answer
// replaces the record. The member, array and tuple positions run the hook;
// a data value under the same name stays an ordinary member, and a hook that
// answers undefined drops the member or writes null in an array slot.
interface Row {
  id: number;
  [key: string]: unknown;
}

const row: Row = { id: 1 };
row["toJSON"] = (key: unknown) => ({ redacted: true, key });
console.log(JSON.stringify({ wrap: row }));
console.log(JSON.stringify([row]));
const tuple: [Row, number] = [row, 2];
console.log(JSON.stringify(tuple));

const data: Row = { id: 3 };
data["toJSON"] = "not a function";
console.log(JSON.stringify({ wrap: data }));
console.log(JSON.stringify([data]));

const dropping: Row = { id: 4 };
dropping["toJSON"] = () => undefined;
console.log(JSON.stringify({ dropping }));
console.log(JSON.stringify([dropping]));

// The hook is per instance: a second row without one serializes its fields
// and entries.
const plain: Row = { id: 5 };
plain["note"] = "kept";
console.log(JSON.stringify({ plain, hooked: row }));

// The hook runs with the record as its `this`, as JSON.stringify calls it.
const fromThis: Row = { id: 6 };
fromThis["toJSON"] = function (this: Row) {
  return { was: this.id };
};
console.log(JSON.stringify({ fromThis }));
console.log(JSON.stringify([fromThis]));
