// The default export snapshots the function the statement saw: a later
// assignment to the declaration's binding does not change what was exported.
function pick() {
  return "original";
}
export default pick;
export { pick };
pick = function () {
  return "replacement";
};
