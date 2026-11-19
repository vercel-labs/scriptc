// A module that only names an ML-KEM parameter set, with no asymmetric
// crypto call: the string literal selects the mlkem unit, which links the
// pki unit it installs its hook into.
const name = "ml-kem-768";
console.log(name.length, name.toUpperCase(), name.startsWith("ml-"));
