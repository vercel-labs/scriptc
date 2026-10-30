// String search, match and replace with untyped pattern values: a RegExp
// is used as is, and any other value is converted as Node converts it.
const rules = JSON.parse('{"other":{}}');
rules.other.space = /\s+/g;
rules.other.word = /o+/;
rules.other.text = "l";
rules.other.dot = ".";
rules.other.none = undefined;
rules.other.nul = null;
rules.other.one = /(l)(o)/;
rules.other.many = /l+/g;
const t = "  hello world";

console.log(
  t.search(rules.other.word),
  t.search(rules.other.text),
  t.search(rules.other.none),
  t.search(rules.other.nul),
  t.search(rules.other.space),
  "a.b".search(rules.other.dot),
);
console.log(rules.other.space.lastIndex);

let conversions = 0;
rules.other.obj = {
  toString() {
    conversions++;
    return "w";
  },
};
console.log(t.search(rules.other.obj), t.match(rules.other.obj)[0], conversions);

const all = t.match(rules.other.many);
console.log(JSON.stringify(all), rules.other.many.lastIndex);
const pair = t.match(rules.other.one);
console.log(pair[0], pair[1], pair[2], pair.index, pair.length, pair.input === t);
const literal = t.match(rules.other.dot);
console.log(literal[0], literal.index, literal.length);
console.log(JSON.stringify(t.match(rules.other.none)), t.match(rules.other.zz));
rules.other.zz = "zz";
console.log(t.match(rules.other.zz));
function first(text, re) {
  const m = text.match(re);
  return m ? m[0] : "none";
}
console.log(first("abc", rules.other.dot), first("", rules.other.dot));

console.log(t.replace(rules.other.space, (m) => "[" + m.length + "]"));
console.log(t.replace(rules.other.word, (m, offset) => m.toUpperCase() + offset));
console.log(t.replace(rules.other.text, (m, offset, subject) => "<" + m + offset + subject.length + ">"));
console.log(t.replaceAll(rules.other.text, (m) => m.toUpperCase()));
console.log(t.replaceAll(rules.other.space, () => "_"));
console.log(t.replace(rules.other.one, (m, p1, p2, offset) => p1 + "|" + p2 + "|" + offset));
console.log(t.replace(rules.other.text, (m, offset, subject, extra) => typeof extra));
console.log(t.replace(rules.other.text, (m) => m.length));
try {
  t.replaceAll(rules.other.word, (m) => m);
} catch (e) {
  console.log(e.constructor.name, e.message);
}

function tabs(text, width) {
  let column = 0;
  let out = "";
  for (const ch of text) {
    if (ch === "\t") {
      const pad = 4 - (column % 4);
      out += " ".repeat(pad);
      column += pad;
    } else {
      out += ch;
      column++;
    }
  }
  return out + width;
}
class Lexer {
  constructor(table) {
    this.rules = table;
  }
  indent(line, width) {
    return line.replace(this.rules.leading, (w) => tabs(w, width));
  }
  firstText(line) {
    return line.search(this.rules.nonSpace);
  }
}
const lexer = new Lexer({ leading: /^( {1,4}| {0,3}\t)/, nonSpace: /[^ ]/ });
console.log(JSON.stringify(lexer.indent("\tabc", 2)), lexer.firstText("   x"));
