// SC2008: intersection types that resolve to no runtime shape. Object-member
// intersections intern through the record path, callable hybrids map to
// '%call' records, and a primitive against plain object refinements is the
// BRAND idiom — the value IS the primitive (tests/corpus/2694). What fences
// is the remainder, like a primitive against a CLASS instance: no value is
// both (inhabited only per the checker, never buildable).

// The producer has a BODY (an ambient `declare function` would compile to
// Node's ReferenceError at the call instead — the declare-erasure stance).
class Tag {
  readonly kind = "tag";
}
type Branded = number & Tag;
function mint(): Branded {
  return 1 as unknown as Branded;
}
const kept = mint();
console.log(kept);
