// Match metadata on matchAll rows and exec results in JavaScript: index,
// input and groups through callbacks, untyped functions, destructuring,
// Object.keys and spread copies.
const text = "k1=v10; k22=v3; k3=v400;";
const re = /(?<key>k\d+)=(?<val>v\d+)(?<bang>!)?;/g;
const rows = [...text.matchAll(re)];
console.log(rows.map((m) => m.index).join(","), rows.map((m) => m.input.length).join(","));
console.log(rows.map(({ index, groups }) => `${index}=${groups.key}`).join(" "));

function describe(m) {
  return [m.index, m.input === text, m.groups.key, m.groups.bang, Object.keys(m).join("|")];
}
for (const m of text.matchAll(re)) console.log(describe(m));
console.log(rows.map((m) => describe(m)[0]).join(","));

const first = rows[0];
const copy = { ...first };
console.log(Object.keys(copy).join(","), copy.index, copy.groups.val, Object.getPrototypeOf(first.groups) === null);
console.log(JSON.stringify(first), first.length);

const dup = [..."a1-b".matchAll(/(?<v>[a-z])|(?<v>\d)|-/g)];
console.log(dup.map((m) => describe2(m)).join(" "));
function describe2(m) {
  return `${m.index}:${m.groups.v}`;
}

const pick = (m) => m && [m.index, m.groups];
console.log(pick(/(?<y>\d)(?<z>x)?/.exec("ab3")), pick(/b/.exec("ab")), pick(/z/.exec("ab")));
console.log(pick("a1".match(/(?<d>\d)/)), Object.keys("a1a".match(/a/g)).join(","));
const none = [..."ab".matchAll(/[a-z]/g)];
console.log(none.map((m) => m.groups === undefined && m.index >= 0).join(","));
