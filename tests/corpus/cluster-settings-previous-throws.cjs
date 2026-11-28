// Node's setupPrimary spreads the previous settings before the options. A
// getter on the previous settings that throws stops the spread there, so the
// options' getters do not run.
const cluster = require("cluster");

cluster.on("setup", (settings) => console.log("setup", settings.silent, settings.custom));
cluster.setupPrimary({ silent: true });
Object.defineProperty(cluster.settings, "boom", {
  get() {
    throw new Error("previous boom");
  },
  enumerable: true,
  configurable: true,
});
let optionsGetterRan = false;
try {
  cluster.setupPrimary({
    get custom() {
      optionsGetterRan = true;
      return "c";
    },
  });
} catch (error) {
  console.log("threw", error.message);
}
console.log("options getter ran:", optionsGetterRan);
