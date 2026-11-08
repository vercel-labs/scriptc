// The members of a union that share a discriminant literal are stored as one record, and a value
// typed as one of those members is that record. A value whose type only looks like a member (an
// inferred literal type) has that member's own layout: storing it in the union would copy it into
// the class's record, and the copy would not be the object `held` names. Refused by name; the
// literal written at the slot (the second statement) has no other name and compiles.
type Leaf = { kind: "node"; id: string };
type Branch = { kind: "node"; id: string; parent: string };
type Count = { kind: "count"; n: number };
type Item = Leaf | Branch | Count;

const held = { kind: "node" as const, id: "i" };
const fresh: Item = { kind: "node", id: "j" };
const stored: Item = held;
console.log(JSON.stringify(stored), JSON.stringify(fresh));
