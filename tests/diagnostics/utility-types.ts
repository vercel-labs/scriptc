// The fences around utility-type record shapes. Utility types over data
// shapes compile (Partial/Record/Pick/Omit/Readonly resolve to ordinary
// record shapes — differential corpus), and STRING and NUMBER index
// signatures over supported value types compile as hybrid shapes (declared
// fields + an overflow map; number keys canonicalize to their JS string
// spelling; function/Map/Set/nested-record values ride the same store —
// differential corpus); what stays rejected:
// - symbol-keyed index signatures (no lowering for symbol keys);
// - index-signature value types outside the overflow-map slice (Dates and
//   other lib API objects, even when the value itself has a representation);
// - utility types over LIB interfaces stay a type world, not data shapes.
// (Dot access/writes to index-signature keys compile now — the overflow
// path in dot spelling — and self-referential mapped types intern as
// named recursive shapes; differential corpus covers both.)
const bySymbol: { [s: symbol]: string } = {};
console.log(bySymbol);

const dateBag: { [k: string]: Date } = {};
const boot = dateBag["boot"];
console.log(boot);

const stamped: Readonly<Date> = new Date(0);
console.log(stamped.getTime());
