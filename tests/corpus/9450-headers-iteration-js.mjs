// Headers iteration from a JavaScript source: for-of, spread and the three
// iterator methods on a Headers the program builds and on a Response's.
const shelf = new Headers({ "x-b": "2", "X-A": "1" });
shelf.append("set-cookie", "s=1");
shelf.append("set-cookie", "t=2");
for (const [name, value] of shelf) console.log(name, value);
console.log(JSON.stringify([...shelf]), JSON.stringify(Object.fromEntries(shelf)));
console.log(JSON.stringify([...shelf.keys()]), JSON.stringify([...shelf.values()]));
const [first, ...others] = shelf;
console.log(first.join("="), others.length);
const walk = shelf.entries();
console.log(JSON.stringify(walk.next()));
shelf.delete("x-b");
shelf.append("y-last", "9");
const rest = [];
for (const entry of walk) rest.push(entry.join("="));
console.log(rest.join(" "), JSON.stringify(walk.next()));
const reply = new Response(null, { status: 204, headers: shelf });
for (const [name, value] of reply.headers) console.log("reply", name, value);
