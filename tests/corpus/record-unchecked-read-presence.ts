// Fields initialized from unchecked array reads are explicit properties
// even when the read lands outside the array: the key exists and holds
// undefined.
const source: number[] = [5, 6];
const pair = { first: source[0], missing: source[7] };
console.log("missing" in pair, Object.hasOwn(pair, "missing"), Object.keys(pair).join(","));
console.log(Object.values(pair), pair);
console.log(JSON.stringify(pair));
const seen: string[] = [];
for (const key in pair) seen.push(key);
console.log(seen.join("|"));

const words: string[] = ["alpha"];
const label = { head: words[0], tail: words[3] };
console.log("tail" in label, Object.keys(label), label, label.tail === undefined);
