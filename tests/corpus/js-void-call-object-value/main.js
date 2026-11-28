// A plain object returned from a void-declared member and read through ||:
// Node reads the object, so the binding is the object itself.
const plain = { marker: 7 };
const Internals = {
  /** @returns {void} */
  give() {
    return plain;
  },
};
function main() {
  const value = Internals.give() || "fallback";
  console.log("same", value === plain, "marker", value.marker);
}
main();
