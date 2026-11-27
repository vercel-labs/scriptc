// cluster.setupPrimary reads the settings options while it merges them. A
// getter can call setupPrimary or setupMaster again, or read cluster.settings,
// and every call installs its own settings object and keeps its own queued
// 'setup' event.
const cluster = require("cluster");

cluster.on("setup", (settings) => {
  console.log(
    "setup",
    settings.silent,
    settings.args ? settings.args.length : "none",
    settings.custom,
    settings.outer,
    settings.inner,
  );
});

// One reentry, which also reads the settings object that is installed at that
// moment.
cluster.setupPrimary({ silent: true });
let reentered = false;
cluster.setupPrimary({
  get custom() {
    if (!reentered) {
      reentered = true;
      console.log("during merge", cluster.settings.silent);
      cluster.setupPrimary({ silent: false, args: ["inner"] });
    }
    return "outer";
  },
});
console.log("reentry", reentered);

// Two reentry levels, the inner one through setupMaster.
cluster.setupPrimary({
  get outer() {
    cluster.setupMaster({
      get inner() {
        cluster.setupPrimary({ silent: true, args: ["deep"] });
        return "inner-value";
      },
    });
    return "outer-value";
  },
});
console.log("nested done");

// A throw after a reentry leaves the reentrant call's settings installed.
try {
  cluster.setupPrimary({
    get failing() {
      cluster.setupPrimary({ silent: true });
      throw new Error("boom");
    },
  });
} catch (error) {
  console.log("threw", error.message);
}
console.log("done");
