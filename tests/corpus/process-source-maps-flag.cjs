// process.sourceMapsEnabled and process.setSourceMapsEnabled: the flag
// starts false, the setter takes a boolean and answers nothing, and every
// other value is Node's ERR_INVALID_ARG_TYPE with the flag unchanged.
function attempt(label, value) {
  try {
    const result = process.setSourceMapsEnabled(value);
    console.log(label, "->", result === undefined ? "undefined" : result, process.sourceMapsEnabled);
  } catch (error) {
    console.log(
      label,
      "|",
      error.constructor.name,
      error.code,
      "|",
      error.message,
      "| kept",
      process.sourceMapsEnabled,
    );
  }
}

console.log("initial", process.sourceMapsEnabled);
attempt("true", true);
attempt("true-again", true);
attempt("false", false);
attempt("number", 1);
attempt("zero", 0);
attempt("string", "true");
attempt("empty-string", "");
attempt("object", {});
attempt("null", null);
attempt("undefined", undefined);
attempt("nan", NaN);
attempt("true-last", true);
console.log("final", process.sourceMapsEnabled);
