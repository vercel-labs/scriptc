// String.prototype.{includes,startsWith,endsWith} answer a TypeError when
// the search value is a RegExp (V8's IsRegExp check), while indexOf and
// lastIndexOf convert it with ToString and search for the text "/x/".
// Both operands are evaluated — receiver first, then the search value —
// before the throw. scriptc used to compile the RegExp check out entirely
// and answer a plausible index instead.
// @ts-nocheck -- passing a RegExp where the lib declares a string is a type
// error in TypeScript and legal JavaScript.
function describe(fn) {
  try {
    return "value:" + fn();
  } catch (error) {
    return error.constructor.name + ":" + error.message;
  }
}

const pattern = /b/;
console.log("includes", describe(() => "abc".includes(pattern)));
console.log("startsWith", describe(() => "abc".startsWith(pattern)));
console.log("endsWith", describe(() => "abc".endsWith(pattern)));
console.log("includes-with-position", describe(() => "abc".includes(pattern, 0)));
console.log("startsWith-with-position", describe(() => "abc".startsWith(pattern, 0)));
console.log("endsWith-with-length", describe(() => "abc".endsWith(pattern, 3)));

// A RegExp whose source is not in the haystack still throws.
console.log("absent", describe(() => "abc".includes(/zzz/)));

// indexOf/lastIndexOf/search convert instead.
console.log("indexOf", describe(() => "abc".indexOf(pattern)));
console.log("indexOf-text", describe(() => "a/b".indexOf(pattern)));
console.log("lastIndexOf", describe(() => "abc".lastIndexOf(pattern)));

// Evaluation order: the receiver, then the search value, then the throw.
const order = [];
function receiver() {
  order.push("receiver");
  return "abc";
}
function needle() {
  order.push("needle");
  return pattern;
}
console.log("order", describe(() => receiver().includes(needle())));
console.log("order-seen", order.join(","));

// Strings, RegExp-free searches and non-string receivers are unaffected.
console.log("strings", "abc".includes("b"), "abc".startsWith("a"), "abc".endsWith("c"));
console.log("array", [pattern].includes(pattern));
console.log("regexp-own", String(pattern), pattern.test("abc"), pattern.source);
