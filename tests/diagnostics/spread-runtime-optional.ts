const values = [{ name: "first", id: 1 }].slice();
const missing: { name: string; id: number }[] = [];
values.push(missing[3]);
// The array can hold undefined, so the callback ABI includes it; spreading
// that arm cannot initialize the required fields inferred by TypeScript.
const copies = values.map((value) => ({ ...value, label: "copy" }));
console.log(copies.length);
