// Results of string and number methods in untyped code: `at` and
// `codePointAt` past the end read undefined, a number's `valueOf` is a
// number, and `matchAll` yields match arrays with their index.
function charAt(text, i) {
  return text.at(i);
}
function codeAt(text, i) {
  return text.codePointAt(i);
}
function unwrap(n) {
  return n.valueOf();
}
function pairs(text) {
  const out = [];
  for (const m of text.matchAll(/(\w)=(\d)/g)) out.push(`${m[1]}${m[2]}@${m.index}`);
  return out;
}
console.log(charAt("abc", 1), charAt("abc", 5), typeof charAt("abc", -9));
console.log(codeAt("ab", 0), codeAt("ab", 9));
console.log(unwrap(4) + 1, typeof unwrap(4));
console.log(pairs("a=1 b=2").join(","), pairs("none").length);
