// A fetch-only program serializes a wide, shallow JSON graph. No handle
// has an own-property table, so the serialization guard must not walk the
// graph (and must not look each visited object up in a linear visited set):
// the JSON body a server hands to JSON.stringify can be attacker-sized.
const keep = new Response("fetch keeps the handle table unit linked");

const width = 1_000_000;
const graph = Array.from({ length: width }, (_, i) => ({ i }));
const text = JSON.stringify(graph);
console.log("json", text.length, text.slice(0, 12), text.slice(-2));
console.log("fetch", keep !== null);
