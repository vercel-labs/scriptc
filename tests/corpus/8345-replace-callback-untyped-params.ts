// String replace/replaceAll with inline callbacks whose parameters have no
// annotations, so the lib types every parameter after the match `any`.
// Each such parameter holds what Node passes at its position: the captures,
// the offset, the subject, the groups object and then undefined. Captures a
// match can leave unset hold undefined, and a result that is not a string
// converts with ToString.
const vars: Record<string, string> = { name: "world", place: "earth" };
const template = "Hello {name}, welcome to {place}! {missing} {name}.";
console.log(template.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? `<${key}>`));
console.log(template.replace(/\{(\w+)\}/, (_m, key) => key.toUpperCase()));
console.log("some_snake_case_name".replace(/_([a-z])/g, (_m, c) => c.toUpperCase()));
console.log("2024-01-15 and 1999-07-04".replace(/(\d{4})-(\d{2})-(\d{2})/g, (_m, y, mo, d) => `${d}/${mo}/${y}`));
console.log("a1b22".replace(/\d+/g, (m, offset, subject) => `[${m}@${offset}/${subject.length}]`));
console.log("x1y2".replace(/(\d)/g, (m, digit, offset, subject) => `${m}${digit}${offset}${subject}`));
console.log("k=v".replace(/(\w)=(\w)/, function (m, k, v, at, all) {
  return `${v}=${k}:${at}:${all}:${m}`;
}));

console.log("k=v".replace(/(\w)=(\w)/, function (this: void, m, k, v, at) {
  return `${typeof this}:${v}=${k}:${at}:${m}`;
}));

// A parameter the body assigns keeps `any`.
console.log("a1".replace(/(\d)/, (_m, d) => {
  d = Number(d) + 1;
  return String(d * 2);
}));

// Captures that a match can leave unset.
console.log("ab".replace(/(a)|(b)/g, (m, a, b) => `${m}:${a}:${b};`));
console.log("b xb".replace(/(x)?b/g, (m, x, at) => `${m}:${x}:${at}`));
console.log("ab".replace(/((a)|b)/g, (m, outer, inner) => `${outer}:${inner};`));
console.log("ab".replace(/(?:(a)|b)/g, (m, a, at) => `${m}:${a}:${at};`));
console.log("aab".replace(/(a){0,2}b/, (m, a, at) => `${m}:${a}:${at}`));
console.log("ab".replace(/(?=(a))a|b/g, (m, look, at) => `${m}:${look}:${at};`));
console.log("ab".replace(/(?!(x))a/g, (m, x, at) => `${m}:${x}:${at};`));
console.log("ab".replace(/(a)*b/, (m, a, at) => `${m}:${a}:${at}`));
console.log("a(b)".replace(/\((b)\)/, (m, b, at) => `${m}:${b}:${at}`));
console.log("a|b".replace(/[|(](b)?/, (m, b, at) => `${m}:${b}:${at}`));

// Annotated `string | undefined` captures hold undefined when unset.
console.log("2024-01-15 1999-07".replace(/(\d{4})-(\d{2})(-(\d{2}))?/g, (_m, y: string, mo: string, _x: string | undefined, d: string | undefined) => `${d ?? "??"}/${mo}/${y}`));
console.log("ab".replace(/(a)|(b)/g, (m: string, a: string | undefined, b: string | undefined, at: number) => `${m}:${a ?? "-"}:${b ?? "-"}:${at};`));
console.log("abc".replace(/(a)(b)(c)/, (m: string, a: string, b: string, c: string, at: number, all: string) => `${c}${b}${a}${m}${at}${all}`));
console.log("abcd".replace(/(a)(b)(c)(d)/, (m, a, b, c, d, at, all) => `${d}${c}${b}${a}${m}${at}${all}`));

// Named groups pass the groups object after the subject; later parameters
// are undefined.
console.log("2024-01".replace(/(?<y>\d{4})-(?<m>\d{2})/, (m, y, mo, at, all, groups) => `${groups.m}.${groups.y}:${y}${mo}:${at}:${all}`));
console.log("ab".replace(/(?<a>a)|(?<b>b)/g, (m, a, b, at, all, groups) => `${m}:${JSON.stringify(groups)};`));
console.log("ab".replace(/b/, (m, at, all, extra, more) => `${m}:${at}:${all}:${extra}:${more}`));
console.log("ab".replace(/(a)(b)/, (m, a, b, at, all, extra, more) => `${m}${a}${b}${at}${all}${extra}${more}`));

// An offset passed to parseFloat converts with ToString, and captures
// passed to parseInt and parseFloat are their text.
console.log("a1b22".replace(/\d+/g, (m, at) => `<${parseFloat(at) + parseInt(m, at + 10)}>`));
console.log("1.5 2e1".replace(/(\S+)/g, (_m, d) => String(parseFloat(d) + parseInt(d) + Number(d))));

// Results that are not strings convert with ToString.
const counts: Record<string, any> = { a: 1, b: true, c: null, d: undefined, e: { toString: () => "E" } };
console.log("a b c d e".replace(/\w/g, (m) => counts[m]));
console.log("abc".replace(/(\w)/g, (m, c) => counts[c]));

// String search patterns pass (match, offset, subject).
console.log("one two one".replaceAll("one", (m, at, subject) => `${m.length}@${at}/${subject.length}`));
console.log("one two one".replace("two", (m, at, subject, extra) => `${m}${at}${subject.length}${extra}`));

// A throw stops the replacement.
try {
  "a1b2c3".replace(/(\d)/g, (_m, d) => {
    if (d === "2") throw new Error("stop at " + d);
    return "#";
  });
} catch (error) {
  console.log((error as Error).message);
}
try {
  "a1".replace(/(\d)/g, (_m, d) => counts.e.missing.field + d);
} catch (error) {
  console.log(error instanceof TypeError);
}
try {
  "ab".replace(/(a)|b/g, (m, a) => a.toUpperCase());
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}

let total = 0;
for (let i = 0; i < 2000; i++) total += template.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? String(i)).length;
console.log(total);
