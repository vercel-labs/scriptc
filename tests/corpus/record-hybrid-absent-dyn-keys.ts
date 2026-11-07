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

// A late write fills the slot. Node lists a declared key created after
// other keys behind them and a hybrid record lists it ahead of them, which
// SC6002 reports where the program lists the type's keys: this block writes
// to a type whose keys nothing lists and asserts presence and value only.
type Late = { model: string; store?: boolean; kind?: string; [key: string]: unknown };
const late: Late = { model: "m", extra: 1 };
late.store = true;
console.log("store" in late, late.store);
delete late.store;
console.log("store" in late, late.store === undefined, "extra" in late);

// A delete takes a declared key out of the listed keys again.
const filled: Body = { model: "m", store: true, extra: 1 };
delete filled.store;
console.log(Object.keys(filled).join(","), "store" in filled, JSON.stringify(filled));

// Present from the start, and nil-valued through a declared field.
const present: Body = { model: "n", store: false, input: null };
console.log(Object.keys(present).join(","), JSON.stringify(present));

// A rest copy drops the declared keys it excludes and keeps the overflow.
const { store: _store, ...rest } = present;
console.log(Object.keys(rest).join(","), JSON.stringify(rest), "store" in rest);
