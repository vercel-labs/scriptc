// The BoundSocket constructor renders a path/port conflict with util.inspect,
// which never reads array elements through a program's getter. The extra
// option below is a sparse array whose inherited getter removes that option;
// the error still renders the array's holes, and the option survives. A
// second attempt puts an array with a near-limit length in the message: its
// hole run renders as one entry, not one step per hole.
const net = require("node:net");

function conflict(options) {
  try {
    const bound = new net.BoundSocket(options);
    console.log("constructed", typeof bound.address());
    bound.close();
  } catch (e) {
    console.log("threw", e.code, JSON.stringify(e.message));
  }
}

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
conflict(options);
console.log("kept", "extra" in options);

const wideArray = (() => {
  const value = [];
  Object.setPrototypeOf(value, Object.create(Array.prototype));
  value.length = 2;
  return value;
})();
wideArray.length = 1000000;
const wide = {
  path: "/tmp/scriptc-bound-error-inspection-wide.sock",
  port: 0,
  extra: wideArray,
};
conflict(wide);
console.log("wide", wide.extra.length);
