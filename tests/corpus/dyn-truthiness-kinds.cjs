// Truthiness of every kind of checked-dynamic value.
const values = [0, -0, NaN, 1, -1, "", "0", " ", true, false, null, undefined, 0n, 1n, {}, [], [0], () => 0, new Map(), Symbol("s"), new Uint8Array(0), Promise.resolve(), new Proxy({}, {})];
console.log(values.map((v) => (v ? "T" : "f")).join(""));
let count = 0;
for (const v of values) if (!v) count++;
console.log(count, values.filter(Boolean).length);
