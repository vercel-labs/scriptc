// A for-in head is retyped by the program. JavaScript writes the key string
// into the head's binding whatever the binding was declared to hold, and
// walks whatever value the right side holds. TypeScript types the head from
// its declaration and reports TS2405/TS2407; unchecked JavaScript keeps
// Node's behavior.

var table = {
  isMounted: ["isMounted", "clean up subscriptions"],
  replaceState: ["replaceState", "use setState instead"],
};

var fnName = 3;
for (fnName in table) console.log("key", typeof fnName, fnName);
console.log("after", fnName);

function createElement(type, config) {
  var propCount = arguments.length - 2;
  if (type && type.defaultProps)
    for (var propName in ((propCount = type.defaultProps), propCount)) {
      console.log("prop", propName, propCount[propName], typeof propCount);
    }
  return propCount;
}

function Component() {}
Component.defaultProps = { className: "box", id: "one" };
console.log("returned", createElement(Component, {}).className);

// A right side the checker types as a primitive still walks the value Node
// sees: a string's indices, and nothing at all for a number.
for (var index in "abc") console.log("string key", index);
for (var none in 42) console.log("number key", none);

// The binding the loop wrote keeps the last key, exactly as in Node.
for (fnName in table);
console.log("last", fnName);

// A loop that visits nothing leaves the binding's prior value in place, so
// the retyped binding still answers it.
var untouched = 7;
for (untouched in {}) console.log("never");
console.log("untouched", untouched, untouched + 1);
