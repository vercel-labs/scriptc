// A typed closure handed to an untyped slot keeps the identity of the
// record or array it returns: the dynamic boundary boxes the closure's own
// object as a live capsule (`dynFrom` with `liveRef`, like every other
// record-to-dyn crossing), so `call(dyn)` answers `shared` itself, not a
// snapshot of it. Node: `(r as Row) === shared` is true.
interface Row {
  id: number;
  tag: string;
}
function call<T>(f: () => T): T {
  return f();
}
const shared: Row = { id: 1, tag: "a" };
const rows: Row[] = [shared];

const recordFn: any = () => shared;
const r = call(recordFn);
console.log("record:", (r as Row) === shared, (r as Row).tag);

const arrayFn: any = () => rows;
const a = call(arrayFn) as Row[];
console.log("array:", a === rows, a[0] === shared);

const unknownFn: unknown = () => shared;
console.log("unknown:", call(unknownFn as () => Row) === shared);

// A record through the untyped slot's parameter and back.
const identity: any = (row: Row) => row;
console.log("param:", (identity(shared) as Row) === shared);
const reader: any = (row: Row) => row.id;
console.log("reader:", reader(shared));

// Through an untyped array method's callback.
const viaMap: any = rows.map((row) => row);
console.log("map:", (viaMap as Row[])[0] === shared);
