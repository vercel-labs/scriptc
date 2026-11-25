// An untaken branch's var declarations still exist, holding undefined.
if (process.env.NODE_ENV !== "production") {
  var esmLabel = "debug";
}
export const label = esmLabel === undefined ? "esm: no debug label" : esmLabel;
