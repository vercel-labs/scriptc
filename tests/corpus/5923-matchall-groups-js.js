// .groups on matchAll rows in JavaScript: array callbacks, Array.from's
// mapping function, destructuring, rows picked with find/at or kept by
// filter/slice, nonparticipating and duplicate named groups.
const text = "a1b2c3";
console.log([...text.matchAll(/(?<k>[a-z])/g)].map((m) => m.groups.k).join(""));
console.log([...text.matchAll(/(?<k>[a-z])|(?<k>\d)/g)].map((m) => m.groups.k).join(""));
console.log(Array.from(text.matchAll(/(?<d>\d)/g), (m) => m.groups.d).join("+"));
const rows = [...text.matchAll(/(?<letter>[a-z])(?<digit>\d)/g)];
rows.forEach((m) => console.log(m.groups.letter, m.groups.digit, JSON.stringify(m.groups)));
console.log(rows.filter((m) => m.groups.digit !== "2").length);
console.log(rows.some((m) => m.groups.letter === "c"), rows.find((m) => m.groups.digit === "3") !== undefined);
rows.forEach(function (m) {
  const { groups } = m;
  const {
    groups: { digit },
  } = m;
  console.log(groups.letter, digit);
});
console.log(rows.map(({ groups }) => groups.letter + groups.digit).join(","));

const mixed = [..."2024 and x9".matchAll(/(?<word>[a-z]+)|(?<num>\d+)/g)];
mixed.forEach((m) => {
  console.log(m.groups.word === undefined, m.groups.num ?? "-", typeof m.groups.word, m.groups);
});
console.log(mixed.filter((m) => m.groups.num !== undefined).map((m) => m.groups.num).join(","));
console.log(mixed.slice(1).map((m) => m.groups.word ?? m.groups.num).join(" "));
console.log(mixed.find((m) => m.groups.word === "and").groups);
console.log(mixed.findLast((m) => m.groups.word !== undefined).groups.word);
console.log(mixed.at(-1).groups.num, Object.keys(mixed.at(0).groups));
try {
  console.log(mixed.find((m) => m.groups.word === "zzz").groups);
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}

const dup = [..."a1-b".matchAll(/(?<v>[a-z])|(?<v>\d)|-/g)];
console.log(dup.map((m) => String(m.groups.v)).join("|"));
const plain = [..."ab".matchAll(/[a-z]/g)];
console.log(plain.map((m) => m.groups === undefined).join());

const one = /(?<k>a)|(?<n>b)/.exec("a");
console.log(one.groups.n, one.groups.n === undefined, one.groups);
