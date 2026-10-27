// JavaScript string replace/replaceAll with inline callbacks. Each
// parameter holds what Node passes at its position: the captures, the
// offset, the subject, the groups object and then undefined. Captures a
// match can leave unset hold undefined, and a result that is not a string
// converts with ToString.
const vars = { name: "world", place: "earth" };
const template = "Hello {name}, welcome to {place}! {missing} {name}.";
console.log(template.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? `<${key}>`));
console.log("some_snake_case_name".replace(/_([a-z])/g, (_m, c) => c.toUpperCase()));
console.log("2024-01-15 and 1999-07-04".replace(/(\d{4})-(\d{2})-(\d{2})/g, (_m, y, mo, d) => `${d}/${mo}/${y}`));
console.log("a1b22".replace(/\d+/g, (m, offset, subject) => `[${m}@${offset}/${subject.length}]`));
console.log("k=v".replace(/(\w)=(\w)/, function (m, k, v, at, all) {
  return `${this === undefined}:${v}=${k}:${at}:${all}:${m}`;
}));
console.log("ab".replace(/(a)|(b)/g, (m, a, b) => `${m}:${a}:${b};`));
console.log("b xb".replace(/(x)?b/g, (m, x, at) => `${m}:${x}:${at}`));
console.log("2024-01".replace(/(?<y>\d{4})-(?<m>\d{2})/, (m, y, mo, at, all, groups) => `${groups.m}.${groups.y}:${y}${mo}:${at}:${all}`));
console.log("ab".replace(/b/, (m, at, all, extra, more) => `${m}:${at}:${all}:${extra}:${more}`));
const counts = { a: 1, b: true, c: null, d: undefined, e: { toString: () => "E" } };
console.log("a b c d e".replace(/\w/g, (m) => counts[m]));
console.log("1-2".replace(/(\d)/g, (_m, d) => Number(d) * 10));
console.log("one two one".replaceAll("one", (m, at, subject) => `${m.length}@${at}/${subject.length}`));
let seen = "";
console.log("xyz".replace(/(y)/, (m, y, at, subject) => {
  seen = typeof m + typeof y + typeof at + typeof subject;
  return y + at;
}), seen);
try {
  "ab".replace(/(a)|b/g, (m, a) => a.toUpperCase());
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}
