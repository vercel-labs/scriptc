// util.inspect of untyped values that reference themselves: objects, arrays,
// Maps and Sets on the traversal stack print as [Circular *N], their own
// rendering gets the <ref *N> prefix, ids follow discovery order, and more
// than 64 circular targets keep their ids. Integer-like keys print first.
const util = require("util");

const self = {};
self.self = self;
console.log(util.inspect(self));
console.log(util.inspect(self, { depth: Infinity }));

const pair = {};
pair.n = { back: pair };
pair[0] = pair.n;
console.log(util.inspect(pair));

const list = [];
list.push(1);
list.push(list);
console.log(util.inspect(list));

const set = new Set();
set.add(set);
console.log(util.inspect(set));
const map = new Map();
map.set(map, "map");
map.set("again", map);
console.log(util.inspect(map));

const nested = {};
nested.a = [nested];
nested.b = {};
nested.b.inner = nested.b;
nested.b.obj = nested;
console.log(util.inspect(nested));

const keys = {};
keys.n = 1;
keys[0] = 2;
keys["10"] = 3;
keys[2] = 4;
keys.b = 5;
console.log(util.inspect(keys));

// A graph with a circular target per node (Node's test-util-inspect-long-running shape).
let last = {};
const graph = last;
for (let i = 0; i < 100; i++) {
  last.next = { circular: graph, last, obj: { a: 1, b: 2, c: true } };
  last = last.next;
  graph[i] = last;
}
const text = util.inspect(graph, { depth: Infinity });
console.log(text.length, (text.match(/<ref \*/g) || []).length, text.slice(0, 120));
