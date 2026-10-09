// JSON.parse(text) as T with record/array targets of number, boolean and
// string leaves parses straight into the native layout in one pass, and
// falls back to the checked-dynamic route for anything it does not accept
// (duplicate keys, syntax errors, ...). Every input here is a VALID cast,
// so Node (where `as` is a no-op) and the native binary must agree on both
// routes.

interface Item {
  sku: string;
  qty: number;
  ok: boolean;
}
interface Order {
  id: number;
  name: string;
  items: Item[];
  tags: string[];
  grid: number[][];
  flags: boolean[];
}
interface Tree {
  label: string;
  kids: Tree[];
}

function showOrder(o: Order): void {
  const items = o.items.map((i) => `${i.sku}x${i.qty}${i.ok ? "!" : ""}`).join(",");
  const grid = o.grid.map((row) => row.join("/")).join("|");
  console.log(o.id, JSON.stringify(o.name), items, o.tags.join("+"), grid, o.flags.join(","));
}

function attempt(label: string, text: string): void {
  try {
    const o = JSON.parse(text) as Order;
    console.log("ok", label);
    showOrder(o);
  } catch {
    console.log("caught", label);
  }
}

// Declaration order, exact keys: a byte-identical round trip.
const exact =
  '{"id":7,"name":"seven","items":[{"sku":"a","qty":2,"ok":true},{"sku":"b","qty":0.5,"ok":false}],"tags":["x","y"],"grid":[[1,2],[],[3]],"flags":[true,false]}';
const exactParsed = JSON.parse(exact) as Order;
showOrder(exactParsed);
console.log(JSON.stringify(exactParsed) === exact);

// Keys out of declaration order, surrounded by every kind of whitespace.
attempt(
  "reordered",
  ' \t\r\n{ "flags" : [ ] ,\n "grid":[ [ 9 ] ], "tags":[],"items" : [ { "ok":false, "qty": 3, "sku":"z" } ],\r\n"name":"r", "id" : -1 } \n',
);

// Undeclared members of every JSON kind are validated and ignored.
attempt(
  "extra members",
  '{"id":1,"extraNum":-12.5e+3,"extraStr":"q\\"uo\\\\te\\u00e9\\ud83d\\ude00","name":"n",' +
    '"extraObj":{"a":[1,{"b":null}],"c":{}},"extraArr":[[],[[true]],"s",false],' +
    '"items":[{"sku":"s","qty":1,"ok":true,"note":{"deep":[1,2,3]}}],' +
    '"tags":[],"grid":[],"flags":[],"extraNull":null,"extraTrue":true,"extraEmpty":""}',
);

// Escaped keys still match declared fields.
attempt(
  "escaped keys",
  '{"\\u0069d":2,"n\\u0061me":"esc","items":[],"t\\u0061gs":["k"],"grid":[],"fl\\u0061gs":[true],"\\"x\\"":1}',
);

// String values with every escape form, including a surrogate pair.
const strings = JSON.parse(
  '["plain","q\\"b\\\\s\\/f\\b\\f\\n\\r\\t","\\u0041\\u00e9\\u4e2d","\\ud83d\\ude00!","",' +
    '"caf\u00e9 \u4e2d\u6587"]',
) as string[];
for (const s of strings) console.log(s.length, JSON.stringify(s));

// Numbers: exact short forms, exponents, more than 15 significant digits,
// subnormals and extremes all decode exactly like Node.
const numbers = JSON.parse(
  "[0,-0,1,-1,0.1,0.2,1e21,1E-7,-12.5e+3,123456789012345678,0.30000000000000004," +
    "5e-324,1.7976931348623157e308,2.2250738585072014e-308,9007199254740993,1e400,-1e400,0.000001]",
) as number[];
for (const n of numbers) console.log(Object.is(n, -0) ? "-0" : String(n));

// Booleans and empty containers at the root.
console.log((JSON.parse("[true,false,true]") as boolean[]).join(","));
console.log((JSON.parse("[]") as number[]).length, (JSON.parse(" [ ] ") as string[][]).length);
console.log((JSON.parse("[[],[[]],[[1]]]") as number[][][]).map((a) => a.length).join(","));

// Recursive records.
const tree = JSON.parse(
  '{"label":"root","kids":[{"label":"a","kids":[]},{"label":"b","kids":[{"label":"c","kids":[]}]}]}',
) as Tree;
function walk(t: Tree, depth: number): void {
  console.log(" ".repeat(depth) + t.label);
  for (const k of t.kids) walk(k, depth + 1);
}
walk(tree, 0);

// Duplicate declared keys: the later value wins, even after an earlier
// value of the wrong kind.
const dup = JSON.parse('{"sku":"first","qty":1,"ok":true,"qty":2,"sku":"second"}') as Item;
console.log(dup.sku, dup.qty, dup.ok);
const dupWrong = JSON.parse('{"sku":7,"qty":"x","ok":null,"sku":"s","qty":3,"ok":false}') as Item;
console.log(dupWrong.sku, dupWrong.qty, dupWrong.ok);

// Deep nesting inside an ignored member.
const deep = "[".repeat(400) + "]".repeat(400);
const nested = JSON.parse(`{"sku":"d","junk":${deep},"qty":4,"ok":true}`) as Item;
console.log(nested.sku, nested.qty, nested.ok);

// Syntax errors are catchable SyntaxErrors on both routes, wherever they
// occur: in a typed field, inside an ignored member, or after the root.
attempt("truncated", '{"id":1,"name":"n"');
attempt("trailing comma", '{"id":1,"name":"n","items":[],"tags":[],"grid":[],"flags":[],}');
attempt("bad member value", '{"id":1,"junk":[1,],"name":"n","items":[],"tags":[],"grid":[],"flags":[]}');
attempt("bad skipped escape", '{"id":1,"junk":"\\x","name":"n","items":[],"tags":[],"grid":[],"flags":[]}');
attempt("bad number", '{"id":01,"name":"n","items":[],"tags":[],"grid":[],"flags":[]}');
attempt("bad literal", '{"id":1,"name":"n","items":[{"sku":"a","qty":1,"ok":tru}],"tags":[],"grid":[],"flags":[]}');
attempt("control char", '{"id":1,"name":"a\nb","items":[],"tags":[],"grid":[],"flags":[]}');
attempt("trailing content", '{"id":1,"name":"n","items":[],"tags":[],"grid":[],"flags":[]} x');
try {
  JSON.parse("[1,2") as number[];
} catch {
  console.log("caught array");
}

// Parsed values are independent native records.
const first = JSON.parse(exact) as Order;
const second = JSON.parse(exact) as Order;
first.items[0]!.qty = 99;
first.tags.push("pushed");
console.log(first.items[0]!.qty, second.items[0]!.qty, first.tags.length, second.tags.length);

// A bulk round trip through stringify and parse.
const bulk: Order[] = [];
for (let i = 0; i < 300; i++) {
  bulk.push({
    id: i,
    name: "order-" + i,
    items: [{ sku: "s" + (i % 7), qty: i / 8, ok: i % 3 === 0 }],
    tags: i % 2 === 0 ? ["even"] : [],
    grid: [[i, -i], [i * 1.5]],
    flags: [i % 5 === 0],
  });
}
const bulkText = JSON.stringify(bulk);
const bulkBack = JSON.parse(bulkText) as Order[];
console.log(bulkBack.length, JSON.stringify(bulkBack) === bulkText);
let sum = 0;
for (const o of bulkBack) sum += o.id + o.items[0]!.qty + o.grid[1]![0]!;
console.log(sum);
