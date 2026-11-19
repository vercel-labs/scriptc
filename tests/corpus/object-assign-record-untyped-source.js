// `Object.assign(opt, options)` with a record target and an untyped
// source: the source's own members land on the record in place, and a key
// the record does not name stays readable through the result.
function applyDefaults(options) {
  const opt = { resolveKnownTags: true, schema: "core" };
  return Object.assign(opt, options);
}
const merged = applyDefaults({ customTags: ["a"] });
console.log(merged.resolveKnownTags, merged.schema, JSON.stringify(merged.customTags));
console.log(JSON.stringify(merged));
const plain = applyDefaults();
console.log(plain.resolveKnownTags, JSON.stringify(plain));
