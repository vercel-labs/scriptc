// cluster.setupPrimary follows the object spread: it snapshots the own keys
// and checks each key's descriptor when it reads the value. A getter that
// deletes a later key or makes it non-enumerable leaves it out, and a key an
// earlier getter makes enumerable is copied.
const cluster = require("cluster");

cluster.on("setup", (settings) => {
  console.log(
    "setup",
    settings.a,
    settings.b,
    settings.c,
    settings.d,
    settings.reveal,
    settings.hidden,
  );
});

cluster.setupPrimary({
  get a() {
    delete this.b;
    Object.defineProperty(this, "c", { enumerable: false });
    return "a";
  },
  b: "b",
  c: "c",
  d: "d",
});

const options = {};
Object.defineProperty(options, "reveal", {
  get() {
    Object.defineProperty(options, "hidden", { enumerable: true });
    return "r";
  },
  enumerable: true,
  configurable: true,
});
Object.defineProperty(options, "hidden", {
  value: "h",
  enumerable: false,
  configurable: true,
});
cluster.setupPrimary(options);
console.log("done");
