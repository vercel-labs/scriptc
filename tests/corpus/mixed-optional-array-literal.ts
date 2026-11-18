// An array literal that mixes an optional member with defined elements of
// the same and of other types: the undefined keeps its position beside
// numbers, null and other strings, and the literal's element type takes
// the union the checker infers.
interface Fields {
  name?: string;
  count?: number;
  [key: string]: unknown;
}

const fields: Fields = {};
const named: Fields = { name: "x", count: 2 };

console.log(JSON.stringify([fields.name, "fixed"]));
console.log(JSON.stringify([fields.count, 1]));
console.log(JSON.stringify([fields.name, 1]));
console.log(JSON.stringify([fields.name, null]));
console.log(JSON.stringify([fields.name, true, "s"]));
console.log(JSON.stringify([named.name, named.count]));

// A defined element of the same type keeps its value in both positions.
const twoStrings = [named.name, "tail"];
console.log(JSON.stringify(twoStrings), twoStrings.length, twoStrings[0]);

// A record field and a nested array element take the same union.
const record = { value: fields.name, count: 1 };
console.log(JSON.stringify(record), record.value === undefined);
const rows = [[fields.name, "a"], [named.name, "b"]];
console.log(JSON.stringify(rows), rows.length);

// A mixed-typed literal the checker widens keeps the present undefined.
const widened = [fields.name, fields.count, undefined];
console.log(JSON.stringify(widened), widened.length, widened[0] === undefined);
