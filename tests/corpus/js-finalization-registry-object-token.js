// A FinalizationRegistry accepts any object as an unregister token. A token
// whose reference kind has no weak lifetime lowering (a Date handle, a copied
// native value) cannot be counted in the registry's weak map, so the registry
// keeps it by value: unregister answers true for the registration the program
// made, and false once it is removed or for another object. A plain object
// token is counted in the weak map and answers the same way.

const registry = new FinalizationRegistry((held) => console.log("collected", held));

const dateTarget = new Date(1);
const dateToken = new Date(2);
registry.register(dateTarget, "date-held", dateToken);
console.log("date", registry.unregister(dateToken), registry.unregister(dateToken));

const plainTarget = { name: "plain" };
registry.register(plainTarget, "plain-held", plainTarget);
console.log("plain", registry.unregister(plainTarget), registry.unregister(plainTarget));

const otherToken = new Date(3);
registry.register({ name: "other" }, "other-held", otherToken);
console.log("other", registry.unregister(new Date(4)));

console.log("never", registry.unregister({}));
