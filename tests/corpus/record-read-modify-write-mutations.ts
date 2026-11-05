// A dictionary update whose value expression runs user code that mutates the
// same record, or reads and writes through other bindings: inserting,
// deleting and clearing between the read and the write must keep Node's
// values and insertion order.

function show(label: string, counts: Record<string, number>): void {
  const parts: string[] = [];
  for (const key in counts) parts.push(key + "=" + counts[key]);
  console.log(label, parts.join(" "));
}

const counts: Record<string, number> = {};

function grow(record: Record<string, number>, n: number): number {
  for (let i = 0; i < n; i++) record["x" + i] = i;
  return n;
}

// Inserts 400 keys between the read and the write.
const k = "k";
counts[k] = (counts[k] ?? 0) + grow(counts, 400);
show("inserted", counts);

// A value expression that deletes a key returns zero and leaves the update
// to insert the key it read after the delete.
function dropOne(record: Record<string, number>, key: string): number {
  delete record[key];
  return 0;
}
delete counts[k];
counts[k] = (counts[k] ?? 0) + dropOne(counts, "x0");
show("deleted key", counts);

// A clear between the read and the write drops every entry first.
function clearAll(record: Record<string, number>): number {
  for (const key in record) delete record[key];
  return 1;
}
counts[k] = (counts[k] ?? 0) + clearAll(counts);
show("cleared", counts);

// Separate bindings: the read names one record, the write another.
const left: Record<string, number> = { a: 1, b: 2 };
const right: Record<string, number> = { a: 10 };
const read = left["a"];
right["a"] = (read ?? 0) + 1;
show("left", left);
show("right", right);

// The key binding is a different variable on each side.
const readKey = "b";
const writeKey = "c";
left[writeKey] = (left[readKey] ?? 0) + 5;
show("key bindings", left);

// A getter on the object global runs between the read and the write.
function bump(record: Record<string, number>, key: string): number {
  record[key] = record[key] ?? 0;
  return record[key]! + 1;
}
const getterKey = "g";
counts[getterKey] = bump(counts, "none") + (counts["none"] ?? 0);
show("call", counts);
