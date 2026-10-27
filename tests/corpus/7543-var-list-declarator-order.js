// A `var` read in a later declarator of the statement that stores it runs
// after the store; a read in the same or an earlier declarator sees undefined.
var base = { a: 1, b: "x" },
  more = { ...base, c: 2 },
  keys = Object.keys({ ...more }).join(","),
  first = base.a + 1;
console.log(JSON.stringify(more), keys, first);

function describeBase() {
  return base.b + more.c;
}
var rules = { space: /\s+/, word: /\w+/ },
  merged = { ...rules, digit: /\d/ },
  described = describeBase();
console.log(Object.keys(merged).join(","), merged.word.test("ab"), described);

var table = { one: 1, two: 2 },
  lookup = function (key) {
    return table[key];
  },
  arrow = (key) => ({ ...table })[key];
console.log(lookup("one"), arrow("two"));

var readLater = function () {
    return later;
  },
  early = readLater(),
  later = { k: 1 },
  after = readLater().k;
console.log(early, after);

var self = self ? 1 : 2;
console.log(self);

for (var i = 0, j = i + 10; i < 2; i++) console.log(i, j);

function nested() {
  var inner = [1, 2, 3],
    copy = [...inner, 4],
    total = copy.reduce((sum, n) => sum + n, 0);
  return { copy, total };
}
console.log(JSON.stringify(nested()));

function earlyInFunction() {
  show("before");
  var point = { n: 1 },
    next = { m: point.n + 1 };
  show("after");
  function show(when) {
    console.log(when, typeof point, point === undefined ? "none" : point.n, next === undefined ? "none" : next.m);
  }
  var check = () => console.log("check", items === undefined);
  check();
  var items = [1];
  check();
}
earlyInFunction();

function loopLists() {
  for (var k = 0, sum = k; k < 3; k++) sum += k;
  var doubled = sum * 2,
    again = doubled + 1;
  return [sum, doubled, again];
}
console.log(JSON.stringify(loopLists()));
