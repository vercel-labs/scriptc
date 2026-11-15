// A sloppy-mode function called without a receiver writes through `this` onto
// the top-level object, so a bare name reads the property afterwards. This
// source never spells that object's name: the write is visible only as
// `this`. A feature-detection guard after it must see the property.

function installProbe() {
  this.Probe = function Probe() {
    return "probed";
  };
}

console.log(typeof Probe);
if (typeof Probe === "function") console.log("guard then");
else console.log("guard else");
console.log(typeof Probe !== "undefined");

installProbe();

console.log(typeof Probe);
if (typeof Probe === "function") console.log("guard then");
else console.log("guard else");
console.log(typeof Probe !== "undefined", Probe());

// A write by a computed key names its property only when the call runs, so
// no name's `typeof` may fold to absent after it.
function installByKey(key) {
  this[key] = "by key";
}
installByKey("KeyProbe");
console.log(typeof KeyProbe, KeyProbe);

// Strict code's `this` is the receiver the caller passed, never the top-level
// object: the same write inside a strict function does not land there.
function strictInstall() {
  "use strict";
  this.StrictProbe = 1;
}
try {
  strictInstall();
} catch (error) {
  console.log(error instanceof TypeError);
}
console.log(typeof StrictProbe);
