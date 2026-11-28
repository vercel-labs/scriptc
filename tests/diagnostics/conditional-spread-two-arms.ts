// A conditional spread whose arms both carry keys builds the taken arm's
// record (corpus 8739), and a property with effects before it now evaluates
// once before the condition (corpus conditional-spread-effectful-prefix).
// The forms below keep their refusal.
// Two such spreads in one literal are a product of four records.
function product(flag: boolean, other: boolean) {
  return { ...(flag ? { a: 1 } : { b: "2" }), ...(other ? { x: 1 } : { y: "2" }) };
}

// An arm that is itself a conditional.
function nested(flag: boolean, other: boolean) {
  return { id: 1, ...(flag ? { a: 1 } : other ? { b: "2" } : { c: true }) };
}

// A key decided at run time beside the spread.
function runtimeKey(flag: boolean, key: string) {
  return { [key]: 1, ...(flag ? { a: 1 } : { b: "2" }) };
}

console.log(product(true, false), nested(false, true), runtimeKey(true, "k"));
