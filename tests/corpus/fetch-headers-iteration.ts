// `for..of` over a static Headers value: entries(), keys() and values()
// walk the same sort-and-combine list forEach does, and — like Node's own
// iterator — every step reads the list again, so a mutation under the loop
// is observed and a delete shifts the next entry into the freed slot.
const h = new Headers();
h.append("set-cookie", "a=1; Path=/");
h.append("x-b", "1");
h.append("Set-Cookie", "b=2, c=3");
h.append("x-a", "1");
h.append("x-a", "2");
h.append("set-cookie", "d=4");
for (const [name, value] of h.entries()) console.log(`entry ${name}: ${value}`);
for (const name of h.keys()) console.log(`key ${name}`);
for (const value of h.values()) console.log(`value ${value}`);

// An identifier head takes the whole [string, string] pair, and a nested
// pattern destructures it.
for (const pair of h.entries()) console.log("pair", pair[0], pair[1]);
for (const [name, [first]] of h.entries()) console.log("nested", name, first.charAt(0));

// Deleting while visiting the first entry shifts the next one forward; the
// count is read afresh each pass, so the walk visits exactly what Node's
// live iterator does.
const live = new Headers();
live.append("set-cookie", "a=1");
live.append("set-cookie", "b=2");
live.append("x-z", "z");
const seen: string[] = [];
for (const [name, value] of live.entries()) {
  seen.push(`${name}=${value}`);
  if (value === "a=1") live.delete("set-cookie");
}
console.log(seen.join(" | "));

// An append during the walk reaches the list when it sorts later.
const grow = new Headers();
grow.append("set-cookie", "a=1");
grow.append("x-y", "y");
const grown: string[] = [];
for (const [name, value] of grow.entries()) {
  grown.push(`${name}=${value}`);
  if (value === "a=1") grow.append("set-cookie", "b=2");
}
console.log(grown.join(" | "));

// An empty Headers walks nothing, and `let` heads rebind per pass.
const empty = new Headers();
for (const [name] of empty.entries()) console.log("never", name);
let lastKey = "";
for (let name of h.keys()) lastKey = name;
console.log("last", lastKey);
