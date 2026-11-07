// `"k" in value` asks the actual value, not the static shape. A checked
// conversion (JSON.parse as a closed record or a record union) keeps the
// own properties its declared fields do not cover, so presence answers for
// those keys come from the kept source: Node sees the extra key, and the
// value keeps it on the way out. A union of record arms asks through each
// arm that can keep a source, so a key declared by no arm still answers
// from the value.
interface AlphaOpts {
  alphaField?: string;
  shared?: boolean;
}
interface BetaOpts {
  betaField?: string;
  shared?: boolean;
}
type Compat = AlphaOpts | BetaOpts;

const both = '{"alphaField":"a","betaField":"b"}';

const v = JSON.parse(both) as Compat;
console.log("union alphaField", "alphaField" in v);
console.log("union betaField", "betaField" in v);
console.log("union shared", "shared" in v);
console.log("union missing", "missing" in v);
console.log("union json", JSON.stringify(v));

const r = JSON.parse(both) as BetaOpts;
console.log("record alphaField", "alphaField" in r);
console.log("record betaField", "betaField" in r);
console.log("record shared", "shared" in r);
console.log("record missing", "missing" in r);
console.log("record json", JSON.stringify(r));

const declared = JSON.parse('{"alphaField":"a","shared":true}') as AlphaOpts;
console.log("declared alphaField", "alphaField" in declared);
console.log("declared shared", "shared" in declared);
console.log("declared betaField", "betaField" in declared);
console.log("declared json", JSON.stringify(declared));

const plain: BetaOpts = { shared: false };
console.log("plain betaField", "betaField" in plain);
console.log("plain shared", "shared" in plain);
