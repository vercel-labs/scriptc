// Forward var reads across storage kinds: a function declared above a `var`
// whose every call follows the store reads the assigned value in the
// binding's own storage — a string, an array, a record, a checked-dynamic
// object — never an unassigned copy.
function severalTypes() {
  function show() {
    return label + ":" + list.length + ":" + config.name;
  }
  var label = "tag";
  var list = [1, 2, 3];
  var config = { name: "cfg" };
  console.log("types", show());
}
severalTypes();

// An initializer that builds a checked-dynamic literal keeps that storage for
// the forward reader too.
function checkedLiteral() {
  function value() {
    return holder.inner.value;
  }
  var holder = { inner: JSON.parse('{"value": 42}') };
  console.log("checked", value());
}
checkedLiteral();

// An initializer that answers an existing object keeps that object's
// identity, not a copy of it.
function identity() {
  function same() {
    return copy === original;
  }
  var original = { a: 1 };
  var copy = original;
  console.log("identity", same(), copy.a);
}
identity();

// A recursive declaration above the binding it accumulates.
function recursion() {
  function down(n) {
    return n === 0 ? count : down(n - 1) + 1;
  }
  var count = 0;
  count = down(3);
  console.log("recursion", count);
}
recursion();

// A direct read that can observe the unassigned state still sees undefined.
function observesUndefined() {
  console.log("early", typeof missing === "undefined");
  var missing = 5;
  console.log("late", missing);
}
observesUndefined();

console.log("done");
