// A HYBRID record (declared fields plus `[key: string]: unknown`) whose
// declared OPTIONAL checked-dynamic field (`store?: boolean` /
// `input?: unknown` on pi's openai-codex-based request bodies) is ABSENT:
// an absent slot is not a key, so Object.keys/values/entries, for-in, `in`
// and JSON agree with Node, and a later write, delete or spread moves it in
// and out of that surface. Declared fields are always walked before the
// overflow in both shapes, so the orders match too.
type Body = {
  model: string;
  store?: boolean;
  input?: unknown;
  [key: string]: unknown;
};

const bare: Body = { model: "m", extra: 1 };
console.log(Object.keys(bare).join(","));
console.log(Object.values(bare).join(","));
console.log(JSON.stringify(Object.entries(bare)));
for (const k in bare) console.log("for-in", k);
console.log("store" in bare, "input" in bare, "extra" in bare, JSON.stringify(bare));

// A late write fills the slot (its KEY ORDER across the declared/overflow
// boundary is the hybrid representation's known divergence, so this block
// asserts presence and value only).
bare.store = true;
console.log("store" in bare, bare.store);
delete bare.store;
console.log(Object.keys(bare).join(","), "store" in bare, JSON.stringify(bare));

// Present from the start, and nil-valued through a declared field.
const present: Body = { model: "n", store: false, input: null };
console.log(Object.keys(present).join(","), JSON.stringify(present));

// A rest copy drops the declared keys it excludes and keeps the overflow.
const { store: _store, ...rest } = present;
console.log(Object.keys(rest).join(","), JSON.stringify(rest), "store" in rest);
