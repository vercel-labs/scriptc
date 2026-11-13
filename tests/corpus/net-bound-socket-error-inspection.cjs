// The BoundSocket constructor renders a path/port conflict with util.inspect,
// which never reads array elements through a program's getter. The extra
// option below is a sparse array whose inherited getter removes that option;
// the error still renders the array's holes, and the option survives.
const net = require("node:net");

const shared = Object.create(Array.prototype);
Object.defineProperty(shared, "0", {
  configurable: true,
  get() {
    delete options.extra;
    return "read";
  },
});

const options = { path: "/tmp/scriptc-bound-error-inspection.sock", port: 0 };
const array = (() => {
  const value = [];
  Object.setPrototypeOf(value, shared);
  value.length = 2;
  return value;
})();
options.extra = array;

try {
  const bound = new net.BoundSocket(options);
  console.log("constructed", typeof bound.address());
  bound.close();
} catch (e) {
  console.log("threw", e.code, JSON.stringify(e.message));
}
console.log("kept", "extra" in options);
