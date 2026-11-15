// A binding that a function assigns, read after the call. TypeScript types
// such a read by the last assignment it sees in the read's own function
// (`undefined` for `var text;`), and a call does not change that. The read
// is the value the callee stored, wherever it stands: an argument of a
// constructor function's method, of a class method, of a function, of
// `new`, of a library function with an optional parameter, an operand, a
// test, a returned value.

function show(value) {
  return typeof value + " " + String(value);
}
function withDefault(value = "default") {
  return typeof value + " " + String(value);
}
function Holder(value) {
  this.value = value;
}
Holder.prototype.show = function (value) {
  return typeof value + " " + String(value);
};
class Klass {
  constructor(value) {
    this.value = value;
  }
  show(value) {
    return typeof value + " " + String(value);
  }
}
const holder = new Holder();
const klass = new Klass();

// Module-level bindings, assigned by a hoisted function declaration.
var text;
let count;
var separator = undefined;
var radix = null;
function assign() {
  text = "t";
  count = 2;
  separator = "-";
  radix = 2;
}
assign();
console.log("constructor function method:", holder.show(text), "|", new Holder().show(count));
console.log("class method:", klass.show(text), "|", new Klass().show(count));
console.log("function:", show(text), "|", withDefault(text), "|", show(separator));
console.log("new:", show(new Holder(text).value), "|", show(new Klass(count).value));
console.log("console:", text, count, separator, radix);
console.log("operands:", `${text}/${count}`, "" + text + count, typeof text, typeof count);
console.log("tests:", text === undefined, count == null, text ?? "absent", text || "empty", text ? "yes" : "no");
console.log("Number, String:", Number(count), String(text), String(count));
console.log("strings:", "abcd".slice(count), "abab".indexOf("b", count), "x".padStart(3, text));
console.log("split, join:", JSON.stringify("a-b".split(separator)), [1, 2].join(separator));
console.log("radix:", parseInt("11", radix), (5).toString(radix), JSON.stringify({ a: 1 }, null, count));
console.log("arithmetic:", count + 1, count * 2, count > 1, [5, 6, 7][count]);
console.log("positions:", "abcdef".slice(1, count), "abcd".substring(count), "abcd".charAt(count), "abcd".at(count));
console.log("searches:", "abab".startsWith("ab", count), "abab".lastIndexOf("ab", count), [1, 2, 1].indexOf(1, count));
console.log("strings:", "ab".repeat(count), "x".concat(text), String.fromCharCode(count + 63), String(count).padEnd(3, text));

// The shape of an old-style parser: `var`s of a function that a nested
// function assigns, handed to methods of a constructor function's instance.
function Scanner(string) {
  this.tail = string;
  this.pos = 0;
}
Scanner.prototype.eos = function eos() {
  return this.tail === "";
};
Scanner.prototype.scan = function scan(re) {
  var match = this.tail.match(re);
  if (!match || match.index !== 0) return "";
  var string = match[0];
  this.tail = this.tail.substring(string.length);
  this.pos += string.length;
  return string;
};
Scanner.prototype.scanUntil = function scanUntil(re) {
  var index = this.tail.search(re),
    match;
  switch (index) {
    case -1:
      match = this.tail;
      this.tail = "";
      break;
    case 0:
      match = "";
      break;
    default:
      match = this.tail.substring(0, index);
      this.tail = this.tail.substring(index);
  }
  this.pos += match.length;
  return match;
};
function parse(template, tags) {
  var openingTagRe, closingTagRe;
  function compileTags(pair) {
    openingTagRe = new RegExp(pair[0] + "\\s*");
    closingTagRe = new RegExp("\\s*" + pair[1]);
  }
  compileTags(tags);
  var scanner = new Scanner(template);
  var tokens = [];
  while (!scanner.eos()) {
    var value = scanner.scanUntil(openingTagRe);
    if (value) tokens.push(["text", value, scanner.pos]);
    if (!scanner.scan(openingTagRe)) break;
    tokens.push(["name", scanner.scanUntil(closingTagRe), scanner.pos]);
    if (!scanner.scan(closingTagRe)) break;
  }
  return tokens;
}
console.log("parse:", JSON.stringify(parse("hi {{who}}, {{ you }}!", ["\\{\\{", "\\}\\}"])));
console.log("parse:", JSON.stringify(parse("plain", ["<%", "%>"])));

// Who assigns: a function expression, an arrow, a method, a constructor
// function's method, a callback a library function calls, a closure handed
// to another function. Each result goes through the method of a
// constructor function's instance and through `slice`.
function callIt(f) {
  f();
}
function assigners() {
  var a, b, c, d, e, f;
  var na, nb, nc, nd, ne, nf;
  var byExpression = function () {
    a = "expression";
    na = 1;
  };
  const byArrow = () => {
    b = "arrow";
    nb = 2;
  };
  var byMethod = {
    set() {
      c = "method";
      nc = 3;
    },
  };
  function Setter() {}
  Setter.prototype.set = function () {
    d = "prototype method";
    nd = 4;
  };
  byExpression();
  byArrow();
  byMethod.set();
  new Setter().set();
  [0].forEach(function () {
    e = "callback";
    ne = 5;
  });
  callIt(function () {
    f = "passed closure";
    nf = 6;
  });
  return [
    holder.show(a) + " " + "abcdefgh".slice(na),
    holder.show(b) + " " + "abcdefgh".slice(nb),
    holder.show(c) + " " + "abcdefgh".slice(nc),
    holder.show(d) + " " + "abcdefgh".slice(nd),
    holder.show(e) + " " + "abcdefgh".slice(ne),
    holder.show(f) + " " + "abcdefgh".slice(nf),
  ].join("; ");
}
console.log("assigners:", assigners());

// A copy of such a binding holds the value too: TypeScript infers the
// copy's type from the same narrowing.
function copies() {
  var first, size;
  function fill() {
    first = "first";
    size = 2;
  }
  fill();
  var copy = size;
  var again = copy;
  var either = again ? copy : undefined;
  var later;
  later = first;
  return ["abcd".slice(copy), "abcd".slice(again), "abcd".slice(either), holder.show(later), show(again)].join(" | ");
}
console.log("copies:", copies());

// An assignment of the copy's own ends what its initializer left in it:
// `undefined`, `null`, a value of another type; a reset on one path only
// does not, and neither does a reset followed by the read again.
function resets() {
  var value, size;
  function fill() {
    value = "filled";
    size = 2;
  }
  fill();
  var a = value;
  a = undefined;
  var b = value;
  b = null;
  var c = size;
  c = "text";
  var d = size;
  if (size > 5) d = undefined;
  var e = value;
  e = undefined;
  e = value;
  return [holder.show(a), "abcd".slice(a), holder.show(b), holder.show(c), "abcd".slice(d), holder.show(d), holder.show(e)].join(" | ");
}
function resetReturned() {
  var value;
  function fill() {
    value = "filled";
  }
  fill();
  var copy = value;
  copy = undefined;
  return copy;
}
function nullReturned() {
  var value;
  function fill() {
    value = "filled";
  }
  fill();
  var copy = value;
  copy = null;
  return copy;
}
console.log("resets:", resets());
console.log("reset and returned:", show(resetReturned()), show(nullReturned()));

// A function called where it stands is part of the enclosing flow: its
// assignment types the read, and stays the value.
function inPlace() {
  var n, s;
  (function () {
    n = 2;
    s = "in place";
  })();
  return "abcd".slice(n) + " " + holder.show(s) + " " + "abab".indexOf("b", n);
}
console.log("called in place:", inPlace());

// A parameter set to undefined and then assigned by a closure; the value
// returned, stored in a property, thrown, kept in a collection.
function later(value, into) {
  value = undefined;
  var fill = function () {
    value = "filled";
  };
  fill();
  into.property = value;
  const map = new Map();
  map.set("key", value);
  let caught;
  try {
    throw value;
  } catch (thrown) {
    caught = thrown;
  }
  console.log("stored:", show(into.property), "|", show(map.get("key")), "|", show(caught));
  return value;
}
console.log("returned:", show(later("first", { property: "initial" })));

// A binding no call can have changed keeps its narrowing.
function untouched() {
  var start;
  var size;
  function never() {
    start = 1;
    size = 2;
  }
  return "abcd".slice(start) + " " + holder.show(size) + " " + typeof never;
}
console.log("before any call:", untouched());
