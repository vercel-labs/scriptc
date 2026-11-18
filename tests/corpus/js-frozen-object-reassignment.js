// A shipped module reassigns a record-typed binding to the result of
// Object.freeze. TypeScript reports TS2739 because the frozen shape lacks
// the properties of the binding's first value; JavaScript stores the frozen
// object, and reads answer what it holds.

var deprecatedAPIs = {
  isMounted: ["isMounted", "clean up subscriptions"],
  replaceState: ["replaceState", "use setState instead"],
};

for (var name in deprecatedAPIs) console.log("before", name);

deprecatedAPIs = Object.freeze({
  __proto__: null,
  c: function (size) {
    return "cache-" + size;
  },
});

console.log(Object.keys(deprecatedAPIs).join(","));
console.log(deprecatedAPIs.c(3));
console.log(deprecatedAPIs.isMounted === undefined);
console.log(
  Object.isFrozen(deprecatedAPIs),
  Object.getPrototypeOf(deprecatedAPIs) === null,
);

// A second write of another shape keeps the identity the program stored.
var replacement = { kind: "other" };
deprecatedAPIs = replacement;
console.log(deprecatedAPIs === replacement, deprecatedAPIs.isMounted);
