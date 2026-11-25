// Object.assign onto a function VALUE — the chalk `Object.assign(identity,
// { bold })` shape. JavaScript mutates the function object and answers it:
// the result IS that function, a write through either name lands on the one
// object, Object.keys on the function lists the copied keys, and the value
// stays callable. The closure's own-property table is that object.
type Style = (s: string) => string;
const identity: Style = (s) => s;
const bold: Style = (s) => `[b]${s}[/b]`;
const blue = Object.assign(identity, { bold } as { bold: Style });
console.log(blue === identity, blue("x"), blue.bold("y"), typeof blue);
console.log(Object.keys(identity).join(","), Object.keys(blue).join(","));

const wrapped = Object.assign((s: string) => s, { bold, level: 2 } as {
  bold: Style;
  level: number;
});
console.log(wrapped("x"), wrapped.bold("y"), wrapped.level);
wrapped.level = 7;
console.log(wrapped.level, Object.keys(wrapped).join(","));
console.log("level" in wrapped, "missing" in wrapped);
const entries = Object.entries(wrapped);
console.log(entries.length, entries[0]![0], entries[1]![0], Object.values(wrapped).length);

// Aliased writes observe one table, and a delete removes the entry.
const alias = wrapped;
alias.level = 8;
console.log(wrapped.level);
const tagged = Object.assign((s: string) => s, {} as { note?: string });
tagged.note = "n";
console.log(tagged.note, Object.keys(tagged).length, delete tagged.note);
console.log(Object.keys(tagged).length, tagged.note);
