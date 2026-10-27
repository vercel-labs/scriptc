// index and input on matchAll rows and exec results: for-of bindings that
// read only captures and the index, bindings that escape, spreads,
// callbacks, stored drains and closures.
const text = "k1=v10; k22=v3; k3=v400;";
const re = /(?<key>k\d+)=(?<val>v\d+);/g;

for (const m of text.matchAll(re)) console.log(m.index, m[1], m.groups!.val);
const kept: RegExpExecArray[] = [];
for (const m of text.matchAll(re)) {
  kept.push(m);
  console.log(m.index, m.input === text);
}
console.log(kept.map((m) => `${m.index}:${m[0]}`).join(" "));

const rows = [...text.matchAll(re)];
console.log(rows.map((m) => m.index).join(","), rows[1]!.index, rows[2]!.input.length);
console.log(rows.filter((m) => m.index > 0).map((m) => m.groups!.key).join(","));
console.log(rows.find((m) => m.index === 8)?.[2], rows.at(-1)!.index);
console.log(Array.from(text.matchAll(re), (m) => m.index + m[0].length).join(","));

const drained = text.matchAll(/v(\d+)/g);
for (const m of drained) console.log(m.index, m[1]);
const stored = text.matchAll(/k(\d)/g);
const later = (): string => [...stored].map((m) => m.index).join("|");
console.log(later());

function startOf(m: RegExpExecArray): number {
  return m.index;
}
console.log([...text.matchAll(/=/g)].map(startOf).join(","));

const e = /(?<n>\d+);/.exec(text)!;
console.log(e.index, e.input === text, e[1], e.groups!.n);
const g = text.match(/k\d+/g)!;
console.log(g.join(","), g.length);
const plain = [..."aXbX".matchAll(/X/g)];
console.log(plain.map((m) => m.index).join(","), plain.length);
console.log([...text.matchAll(re)].map((m) => m[1]).join(","), [...text.matchAll(re)].length);
console.log(Array.from(text.matchAll(re), (m) => m.groups!.key + m.length).join(","));
for (const m of [...text.matchAll(re)].slice(1)) console.log(m[2], m.groups!.val);
