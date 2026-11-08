// A function that carries properties prints and enumerates like Node's
// function object: inspect shows `[Function: tagged] { label: 't' }`, and
// the properties are enumerable own keys even when the value is viewed
// through `unknown`.
function tagged(): number {
  return 1;
}
tagged.label = "t";
const viaUnknown: unknown = tagged;
console.log(tagged);
console.log(Object.keys(viaUnknown as object), JSON.stringify({ f: tagged }));
