// A function-scoped `var` initialized with an object literal that later
// assignments fill in: tsc types the binding by the members those
// assignments add, but the object only gains them after its initializer.
"use strict";
function load(id) {
  var p = {};
  console.log(p.count, "count" in p, Object.keys(p).length);
  p.id = id;
  p.count = id * 2;
  p.label = "item-" + id;
  return p;
}
const p = load(7);
console.log(p.id + p.count, p.label.toUpperCase(), JSON.stringify(p), Object.keys(p).join(","));

function partial(name) {
  var entry = { name: name };
  entry.size = name.length;
  entry.tags = [name, name + "!"];
  return entry;
}
const e = partial("abc");
console.log(e.size * 10, e.tags.join("|"), JSON.stringify(e));

function nested(depth) {
  var node = {};
  node.depth = depth;
  node.child = depth > 0 ? nested(depth - 1) : null;
  return node;
}
console.log(JSON.stringify(nested(2)));

function rows(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var row = {};
    row.index = i;
    row.square = i * i;
    out.push(row);
  }
  return out;
}
console.log(rows(4).map(function (r) { return r.index + ":" + r.square; }).join(" "));

var top = {};
top.ready = true;
top.total = rows(3).reduce(function (s, r) { return s + r.square; }, 0);
console.log(top.ready, top.total, JSON.stringify(top));
