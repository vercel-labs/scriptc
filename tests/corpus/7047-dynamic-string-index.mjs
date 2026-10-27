// Indexing a string with a key whose type is only known at run time reads
// the property the key names: a code unit, the length, or undefined.
function skipSpaces(text, at) {
  let c;
  while ((c = text[at]) === " " || c === "\t") at++;
  return [at, c];
}
const where = JSON.parse('{"at":2,"name":"length","past":9,"text":"1","neg":-1,"frac":1.5}');
console.log(skipSpaces("ab  \tcd", where.at), skipSpaces("ab", where.past));
const s = "hello";
console.log(s[where.at], s[where.name], s[where.past], s[where.text], s[where.neg], s[where.frac]);
console.log(typeof s[where.past], typeof s[where.name], s[where.at] === "l");
function scan(text, start) {
  let out = "";
  for (let i = start; text[i] !== undefined && text[i] !== ";"; i++) out += text[i];
  return out;
}
console.log(scan("key=value;rest", JSON.parse("4")), scan("abc", JSON.parse("1")));
const codes = [];
for (let i = JSON.parse("0"); i < s.length; i++) codes.push(s[i].charCodeAt(0));
console.log(codes);
