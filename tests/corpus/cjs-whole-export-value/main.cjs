var gopd = require("./index.cjs");
var descriptor = gopd({ a: 1 }, "a");
console.log(typeof gopd, gopd.name, gopd.length);
console.log(descriptor.value, descriptor.writable, descriptor.enumerable, descriptor.configurable);

var direct = require("./descriptor.cjs");
console.log(typeof direct, direct.name, direct.length);
console.log(direct === Object.getOwnPropertyDescriptor);
console.log(direct({ b: 2 }, "b").value);

var snap = require("./snapshot.cjs");
console.log(typeof snap, snap.name, snap());
