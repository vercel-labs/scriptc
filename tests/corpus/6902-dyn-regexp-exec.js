// exec on a regular expression held as an untyped value returns Node's
// match array: the captures (undefined for one that did not participate),
// index, input and groups. Global and sticky expressions read and advance
// lastIndex, and reset it when nothing matches.
function dyn(value) {
  return [value][0];
}
function show(label, match) {
  if (match === null) return console.log(label, null);
  console.log(label, JSON.stringify([...match]), match.index, match.input, JSON.stringify(match.groups), match.length);
}

const plain = dyn(/(\d+)-(x)?/);
show("plain", plain.exec("a 12- b"));
show("miss", plain.exec("none"));
console.log("plain lastIndex", plain.lastIndex);

const global = dyn(/o(.)/g);
show("g1", global.exec("foo boo"));
console.log("after g1", global.lastIndex);
show("g2", global.exec("foo boo"));
console.log("after g2", global.lastIndex);
show("g3", global.exec("foo boo"));
console.log("after g3", global.lastIndex);
global.lastIndex = 5;
show("from 5", global.exec("foo boo"));

const sticky = dyn(/b/y);
show("sticky miss", sticky.exec("ab"));
sticky.lastIndex = 1;
show("sticky hit", sticky.exec("ab"));
console.log("sticky after", sticky.lastIndex);

const named = dyn(/(?<year>\d{4})-(?<month>\d{2})(?:-(?<day>\d{2}))?/);
const date = named.exec("on 2024-05");
show("named", date);
console.log("year", date.groups.year, "day", date.groups.day, Object.getPrototypeOf(date.groups) === null);

const unicode = dyn(/\u{1F600}(.)/u);
show("unicode", unicode.exec("x\u{1F600}y"));
show("coerced", dyn(/1/).exec(123));
const matches = [];
const all = dyn(/a(\d)/g);
let m;
while ((m = all.exec("a1 a2 a3")) !== null) matches.push(m[1] + "@" + m.index);
console.log("loop", matches.join(","), all.lastIndex);
console.log("Array.isArray", Array.isArray(dyn(/x/).exec("x")));
