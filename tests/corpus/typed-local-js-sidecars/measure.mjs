/** @typedef {import("./measure.d.mts").Factory} Factory */
/** @typedef {import("./measure.d.mts").Result} Result */
console.log("measure init");

/** @param {Factory} Type @returns {Result} */
export function measure(Type) {
  const meter = new Type(7);
  return { amount: meter.read() };
}
export default measure;
