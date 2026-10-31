// Expando writes on values whose static type is an array, a record, a class
// instance or a function. The write lands in the value's live
// property table, so every later read — typed, dynamic or reflective — sees
// it, the value keeps its identity, and its elements and declared fields keep
// their own storage. `a.index = 0` / `a.input = "s"` are the RegExp match
// result shape (a plain string array under the static types).
var match = ["x"];
match.index = 0;
match.input = "abc";
console.log(match.index, match.input, match.length, match[0]);
console.log(JSON.stringify(match));
console.log(Object.keys(match).join(","));
console.log(Object.getOwnPropertyNames(match).join(","));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(match, "index")));

// Element writes stay element writes, in and out of range, and the expandos
// never become elements or change the length.
match[0] = "y";
match[3] = "z";
console.log(match.length, match.join(","), match.index, match.input);
console.log(JSON.stringify(match));

// A record: declared fields keep their slots, added keys are own keys, and a
// later declared write is still visible through both views.
var point = { x: 1, y: 2 };
point.extra = "e";
point.x = 10;
console.log(point.x, point.extra, JSON.stringify(point));
console.log(Object.keys(point).join(","));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(point, "extra")));

// A class instance: the expando is an own property that is not a field.
function Counter(start) {
  this.count = start;
}
var counter = new Counter(1);
counter.label = "c";
counter.count = counter.count + 1;
console.log(counter.count, counter.label);
console.log(Object.keys(counter).join(","));

// A function value: properties live on the function object.
function callback(value) {
  return value;
}
callback.tag = "t";
callback.weight = 2;
console.log(callback("v"), callback.tag, callback.weight);
console.log(Object.getOwnPropertyNames(callback).join(","));

// The expando is visible through an untyped helper, and the value keeps its
// identity across the boundary.
function setKey(target, key, value) {
  target[key] = value;
}
function getKey(target, key) {
  return target[key];
}
function same(target) {
  return target;
}
var shared = ["s"];
setKey(shared, "index", 7);
console.log(getKey(shared, "index"), shared.index);
console.log(same(shared) === same(shared), shared === same(shared));
setKey(shared, "input", "in");
console.log(getKey(shared, "input"), Object.keys(shared).join(","));

// A record reached through a typed field keeps one property table.
var holder = { items: ["a"], label: "h" };
holder.items.index = 1;
console.log(holder.items.index, holder.items[0], holder.label);
var view = holder;
view.items.input = "i";
console.log(holder.items.input);

// Undeclared reads on typed arrays answer undefined, like JS.
console.log(match.missing, point.missing);
