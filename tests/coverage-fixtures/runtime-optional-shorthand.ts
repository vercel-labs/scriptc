// How the runtime-optional section names reads of a widened slot: a guard can
// narrow the slot to several of its storage arms at once, and an object
// shorthand reads the binding behind the property it creates.

const mixed: (string | number | boolean)[] = [];
const item = mixed[0];
if (typeof item === "string" || typeof item === "number") console.log(item);

const labels: Record<string, string> = { a: "x" };
const label = labels["a"];
const boxed = { label };
console.log(boxed.label.toUpperCase());
