/* createRequire's argument is Node's: a file URL object, a file URL string
 * or an absolute path string. Every other statically known shape is Node's
 * TypeError with ERR_INVALID_ARG_VALUE at the factory call. */
const { createRequire } = require("node:module");

function attempt(label, run) {
  try {
    console.log(label, "ok", JSON.stringify(typeof run()));
  } catch (error) {
    console.log(label, "threw", error.name, error.code, error.message);
  }
}

attempt("number", () => createRequire(42));
attempt("relative", () => createRequire("./x.cjs"));
attempt("null", () => createRequire(null));
attempt("empty object", () => createRequire({}));
attempt("empty array", () => createRequire([]));
attempt("boolean", () => createRequire(true));
attempt("undefined", () => createRequire(undefined));
attempt("url object", () => createRequire(new URL("file:///tmp/a.cjs")));
attempt("absolute", () => createRequire("/tmp/a.cjs"));
attempt("file url", () => createRequire("file:///tmp/a.cjs"));
