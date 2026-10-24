// Computed-key reads on unknown records answer the members every plain
// object inherits from Object.prototype, the way a lookup table guarded by
// `typeof table[key] === "function"` sees them in Node.

const table: Record<string, unknown> = JSON.parse('{"add":1,"sub":2}');
const keys = ["add", "toString", "constructor", "valueOf", "hasOwnProperty", "missing"];

for (const key of keys) {
  const entry: unknown = table[key];
  console.log(key, typeof entry, entry === Object);
}

const own = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);
const safe = keys.filter((key) => own(table, key));
const unsafe = keys.filter((key) => !own(table, key) && table[key] !== undefined);
console.log(safe.join(","), "|", unsafe.join(","));
