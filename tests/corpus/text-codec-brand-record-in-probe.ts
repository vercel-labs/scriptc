// A hoisted `var` holds an undefined arm until its initializer runs, so its
// storage type is a union. A TextEncoder in that union is a brand record
// (only `%`-prefixed internal fields), and `in` answers from the class's
// declared prototype members, exactly as it does for a single record
// receiver — not from the brand record's internal fields.
var hoisted = new TextEncoder();
console.log("encodeInto" in hoisted, "encode" in hoisted, "toString" in hoisted);
console.log("notAMember" in hoisted, "resizable" in hoisted);

// A genuine union answers per arm: each class's own members are present on
// its instances and absent on the other's.
function probe(e: TextEncoder | TextDecoder): void {
  console.log("encodeInto" in e, "decode" in e, "valueOf" in e, "missing" in e);
}
probe(new TextEncoder());
probe(new TextDecoder());

// A fresh binding of the same class keeps its static answer.
const decoder = new TextDecoder();
console.log("decode" in decoder, "encodeInto" in decoder, "constructor" in decoder);
