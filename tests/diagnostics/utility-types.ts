// The fences around utility-type record shapes. Utility types over data
// shapes compile (Partial/Record/Pick/Omit/Readonly resolve to ordinary
// record shapes — differential corpus), and STRING and NUMBER index
// signatures over supported value types compile as hybrid shapes (declared
// fields + an overflow map; number keys canonicalize to their JS string
// spelling; function/Map/Set/nested-record values ride the same store —
// differential corpus); what stays rejected:
// - symbol-keyed index signatures (no lowering for symbol keys).
// (Readonly<Date> bindings compile, holding the Date as a checked value.
// Dot access/writes to index-signature keys compile now — the overflow
// path in dot spelling — and self-referential mapped types intern as
// named recursive shapes; differential corpus covers both.)
const bySymbol: { [s: symbol]: string } = {};
console.log(bySymbol);

const stamped: Readonly<Date> = new Date(0);
console.log(stamped.getTime());
