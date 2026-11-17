// A JavaScript binding an operator reads holds whatever the program last
// stored, not the shape one assignment gave it: shipped JavaScript reuses a
// `var` for a record, an array of stack lines and a count. The widening
// prepass gives each such binding checked-dynamic storage, so the operator
// applies Node's ToNumeric/ToPrimitive to the stored value.

function compare() {
  var value = { tag: "record" };
  value = 2;
  var text = [];
  text = "b";
  var empty = [];
  return [1 <= value, value < 3, text < "c", empty < 1, empty > -1];
}
console.log("compare", compare().join());

function stackWalk() {
  // React's stack-frame walk in miniature: one `var` per column, reused for
  // a frame record, a line count and the loop index.
  var line = { name: "frame" };
  var index = { step: 0 };
  for (index = 0; index < 3; index++) {}
  line = index;
  var out = [];
  for (; 1 <= line && line > 0; line--) out.push(line);
  return out.join();
}
console.log("walk", stackWalk());

function increments() {
  var descriptor = { value: 1 };
  var count = 0;
  descriptor = count;
  descriptor++;
  descriptor--;
  descriptor++;
  var list = [];
  list += 2;
  list += "x";
  return [descriptor, typeof list, list];
}
console.log("increments", increments().join(","));

function conversions() {
  var record = { n: 1 };
  record = { valueOf: function () { return 7; } };
  var script = { n: 1 };
  script = { toString: function () { return "3"; } };
  return [record * 2, record < 8, script < 4, script + 1, record - 1];
}
console.log("conversions", conversions().join());

function booleans() {
  var flag = 0;
  flag = true;
  return [flag < 2, flag > 0, flag * 3, flag && "yes"];
}
console.log("booleans", booleans().join());

function strings() {
  var name = 0;
  name = "7";
  return [name < 8, name + 1, name - 1, name * 2];
}
console.log("strings", strings().join());
