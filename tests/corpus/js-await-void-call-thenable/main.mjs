const lazy = {
  then(resolve) {
    console.log("then ran");
    resolve("adopted");
  },
};
const Internals = {
  /** @returns {void} */
  give() {
    return lazy;
  },
};
async function main() {
  const value = (await Internals.give()) || "fallback";
  console.log(value);
}
main();
