// A CommonJS module in the same program: its object-literal types only the
// checked-dynamic representation holds (js-dynamic-objects.ts), so the
// round's shared JavaScript dynamic-declaration set is consulted while this
// source lowers beside the TypeScript entry.
function describe(label) {
  const entry = { label: label, length: label.length };
  entry.length = entry.length + 1;
  return entry.label + ":" + entry.length;
}

module.exports = { describe: describe };
