// A FinalizationRegistry accepts any object as an unregister token. A token
// whose reference kind has no weak lifetime lowering (a Date handle, a copied
// native value) keeps no count, so the registration is accepted and unregister
// answers false for it; a plain object token is counted and unregistered as
// Node does.

const registry = new FinalizationRegistry((held) => console.log("collected", held));

const plainTarget = { name: "plain" };
registry.register(plainTarget, "plain-held", plainTarget);
console.log("plain", registry.unregister(plainTarget), registry.unregister(plainTarget));

const dateTarget = new Date(1);
const dateToken = new Date(2);
registry.register(dateTarget, "date-held", dateToken);
registry.unregister(dateToken);
console.log("date", typeof dateTarget.getTime, typeof dateToken.getTime);

const heldOnly = {};
registry.register(heldOnly, "held-only");
console.log("held", registry.unregister({}));
