// util.getCallSites reads options.sourceMap as a property read: an accessor
// that throws propagates that error to the caller instead of ending the
// process, and an options bag without the key takes the default.
const { getCallSites } = require("node:util");

function attempt(label, fn) {
  try {
    fn();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, String(e.code), e.message);
  }
}

const throwing = {
  get sourceMap() {
    throw new RangeError("no source map");
  },
};
attempt("throwing-source-map", () => getCallSites(3, throwing));
attempt("empty-options", () => getCallSites({}));
attempt("false-options", () => {
  const sites = getCallSites(1, { sourceMap: false });
  if (!Array.isArray(sites)) throw new Error("not an array");
});
