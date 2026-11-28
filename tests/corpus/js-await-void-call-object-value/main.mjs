// A non-thenable object: the await settles on the value itself, which the truthiness test
// then reads.
const plain = { marker: 7 };
const Internals = {
  /** @returns {void} */
  give() {
    return plain;
  },
};
async function main() {
  const value = (await Internals.give()) || "fallback";
  console.log("t5 same", value === plain, "marker", value.marker);
}
main();
