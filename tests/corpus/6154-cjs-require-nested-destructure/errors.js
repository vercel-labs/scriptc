console.log("errors: evaluated");
const codes = {
  ERR_ONE: { code: "ERR_ONE" },
  ERR_TWO: { code: "ERR_TWO" },
};
class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}
module.exports = { codes, AbortError, version: "4.0" };
