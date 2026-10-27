// `''.match(/x/) || []` drives tsgo into the TupleType interface-conversion
// panic (upstream signature 01/13) whenever the union's members are
// serialized; the widened union's members are readable, so the binding is
// the match array (the empty tuple is one of its values) and compiles.
const a = ''.match(/x/) || [];
console.log(a.length);
