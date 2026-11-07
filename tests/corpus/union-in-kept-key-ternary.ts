// `"k" in value` as a branching guard over a union whose arms declare no
// such key: the static answer is a constant false, but a value that kept its
// checked source still has the key, so the taken arm answers from the value.
// Lowering must not settle the branch on the static false.
interface AlphaOpts {
  alphaField?: string;
}
interface BetaOpts {
  betaField?: string;
}
type Compat = AlphaOpts | BetaOpts;

const v = JSON.parse('{"extra":"x"}') as Compat;
console.log("taken", "extra" in v ? "present" : "absent");
console.log("untaken", "other" in v ? "present" : "absent");
console.log("both", "alphaField" in v ? "alpha" : "not alpha");

const plain: Compat = { alphaField: "a" };
console.log("plain taken", "extra" in plain ? "present" : "absent");
console.log("plain declared", "alphaField" in plain ? "alpha" : "not alpha");
