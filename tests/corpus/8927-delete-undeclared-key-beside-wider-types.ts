// `delete` of a key the operand's type does not declare removes the key
// from the record's own kept source, also in a program that has a wider
// record type declaring the same key: as long as no record of the wider
// type is converted to the operand's type or passed as an untyped value,
// the operand is the only record the object has, and the delete is Node's.
// (A wider record that can reach the operand is refused by name:
// tests/diagnostics/delete-source-field.ts.)
type Narrow = { x: number };
type Wide = { x: number; k: number };

// A native record of the wider type, used only through its own type.
const wide: Wide = { x: 10, k: 20 };
wide.k += 1;
console.log(wide.x, wide.k);

// The parsed record keeps `k` in its source.
const narrow = JSON.parse('{"x":1,"k":2}') as Narrow;
console.log(JSON.stringify(narrow), Object.keys(narrow).join(","), "k" in narrow);
const gone = delete (narrow as Narrow & { k?: number }).k;
console.log(gone, "k" in narrow, Object.keys(narrow).join(","), JSON.stringify(narrow));

// A second delete finds nothing and still answers true.
console.log(delete (narrow as Narrow & { k?: number }).k, JSON.stringify(narrow));

// Statement position, several kept keys, removal keeps the others' order.
const many = JSON.parse('{"a":1,"x":2,"b":3,"c":4}') as Narrow;
delete (many as Narrow & { b?: number }).b;
console.log(Object.keys(many).join(","), JSON.stringify(many));
delete (many as Narrow & { a?: number }).a;
console.log(Object.keys(many).join(","), JSON.stringify(many));

// The wider record is untouched throughout.
console.log(wide.x, wide.k);
