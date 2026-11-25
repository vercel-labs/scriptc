// A record type that declares a toJSON method serializes through it, as a
// class instance does: JSON.stringify calls the method with the record as
// receiver and the property key as its argument, and serializes whatever the
// method answers. The record's other methods stay function-valued properties
// and are omitted.
type Counter = {
  count: number;
  label: string;
  toJSON(key: string): { count: number; label: string };
  read(): number;
};

const make = (count: number): Counter => ({
  count,
  label: "c" + count,
  toJSON(key: string) {
    return { count: this.count * 2, label: this.label + ":" + key };
  },
  read() {
    return this.count;
  },
});

console.log(JSON.stringify(make(2)));
console.log(make(2).read());

// The hook runs at every position it is found: a nested record, an array
// element, and a record reached through another record's field.
const nested = { item: make(3) };
console.log(JSON.stringify(nested));
console.log(JSON.stringify([make(4), make(5)]));

// A toJSON that answers undefined makes the whole result undefined at the
// root and drops the key inside an object.
type Hidden = {
  a: number;
  toJSON(): undefined;
};
const hidden: Hidden = {
  a: 1,
  toJSON() {
    return undefined;
  },
};
console.log(JSON.stringify(hidden));
console.log(JSON.stringify({ hidden, after: 1 }));

// A non-callable toJSON is an ordinary omitted function-valued property.
type NotHook = {
  a: number;
  toJSON: string;
};
const notHook: NotHook = { a: 7, toJSON: "nope" };
console.log(JSON.stringify(notHook));
