// process.debugPort: 9229 until a write; the write converts with
// ToInt32, accepts 0 or 1024..65535, and a refused write throws Node's
// RangeError and leaves the previous value in place.
function attempt(label, value) {
  try {
    process.debugPort = value;
    console.log(label, "->", process.debugPort);
  } catch (error) {
    console.log(
      label,
      "|",
      error.constructor.name,
      error.code,
      "|",
      error.message,
      "| kept",
      process.debugPort,
    );
  }
}

console.log("initial", process.debugPort);
attempt("5000", 5000);
attempt("hex-string", "0x1000");
attempt("fraction", 9229.5);
attempt("negative-fraction", -0.5);
attempt("zero", 0);
attempt("negative-zero", -0);
attempt("null", null);
attempt("undefined", undefined);
attempt("nan", NaN);
attempt("nan-string", "abc");
attempt("true", true);
attempt("false", false);
attempt("1024", 1024);
attempt("65535", 65535);
attempt("1023", 1023);
attempt("65536", 65536);
attempt("negative", -1);
attempt("2**32", 4294967296);
attempt("2**32+5000", 4294967296 + 5000);
attempt("1e10", 1e10);
attempt("large", 704000000);
attempt("object", { valueOf: () => 3000 });
attempt("array", [4000]);
attempt("symbol", Symbol("port"));
attempt("last", 9229);
console.log("final", process.debugPort);
