// node:cluster's setupPrimary merge builds a fresh settings object from the
// defaults, the current settings, and the options, reading the options' own
// enumerable properties the way an object spread does. An own accessor runs
// its getter when the merge reads it, a Proxy answers through its get trap,
// and an inherited accessor is not an own property, so it is not copied.
const cluster = require("cluster");

let accessorRuns = 0;
let proxyRuns = 0;
let functionRuns = 0;
let inheritedRuns = 0;
let classRuns = 0;

cluster.on("setup", (settings) => {
  console.log(
    "setup",
    settings.silent,
    settings.serialization,
    settings.custom,
    settings.proxyValue,
    settings.proxyGetter,
    settings.mode,
    settings.functionGetter,
    settings[0],
    settings.field,
    settings.inherited,
  );
});

// An own accessor on a plain settings object.
const accessor = { serialization: "advanced" };
Object.defineProperty(accessor, "custom", {
  get() {
    accessorRuns += 1;
    return "accessor-" + accessorRuns;
  },
  enumerable: true,
  configurable: true,
});
cluster.setupPrimary(accessor);
console.log("accessor runs", accessorRuns);

// A Proxy settings object: the merge enumerates the target's own keys and
// reads each one through the get trap.
const target = { proxyValue: "direct" };
Object.defineProperty(target, "proxyGetter", {
  get() {
    proxyRuns += 1;
    return "trap-" + proxyRuns;
  },
  enumerable: true,
  configurable: true,
});
const proxied = new Proxy(target, {
  get(t, key) {
    return t[key];
  },
});
cluster.setupPrimary(proxied);
console.log("proxy runs", proxyRuns);

// A function and an array are spread through their own enumerable entries
// too: the function's assigned members and accessor, the array's elements.
function settingsFunction() {}
settingsFunction.mode = "fn";
Object.defineProperty(settingsFunction, "functionGetter", {
  get() {
    functionRuns += 1;
    return "fn-" + functionRuns;
  },
  enumerable: true,
  configurable: true,
});
cluster.setupPrimary(settingsFunction);
console.log("function runs", functionRuns);

cluster.setupPrimary(["first", "second"]);
console.log("array done");

// An inherited accessor is not an own property, so the merge does not read
// it; an own data property beside it is copied.
const proto = {};
Object.defineProperty(proto, "inherited", {
  get() {
    inheritedRuns += 1;
    return "proto";
  },
  enumerable: true,
  configurable: true,
});
const inherited = Object.create(proto);
inherited.serialization = "json";
cluster.setupPrimary(inherited);
console.log("inherited runs", inheritedRuns);

// A class instance: the prototype getter is not an own property; the own
// field is copied.
class Settings {
  constructor() {
    this.field = "own";
  }
  get inherited() {
    classRuns += 1;
    return "class";
  }
}
cluster.setupPrimary(new Settings());
console.log("class runs", classRuns);
