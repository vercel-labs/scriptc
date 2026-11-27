/* createRequire's argument check runs where the factory call stands, in every
 * shape the call takes: a const declaration over a run-time loader, a chained
 * `createRequire(base)(id)` call, and a destructured factory binding. Arguments
 * after the base still run before the throw, a local `undefined` is an ordinary
 * base, and numbers print as util.inspect prints them. */
const { createRequire } = require("node:module");
const { createRequire: makeRequire } = require("node:module");

function attempt(label, run) {
  try {
    console.log(label, "ok", JSON.stringify(typeof run()));
  } catch (error) {
    console.log(label, "threw", error.name, error.code, error.message);
  }
}

attempt("declaration", () => {
  const r = createRequire(42);
  return r;
});
attempt("chained", () => createRequire(42)("node:fs"));
attempt("factory binding", () => makeRequire(42));
attempt("factory binding chained", () => makeRequire(42)("node:fs"));
attempt("no argument", () => createRequire());
attempt("void", () => createRequire(void 0));
attempt("hex", () => createRequire(0x1));
attempt("separators", () => createRequire(1_000));
attempt("negative", () => createRequire(-1));
attempt("negative zero", () => createRequire(-0));
attempt("template", () => createRequire(`x`));
attempt("local undefined", () => {
  const undefined = "/tmp/a.cjs";
  return createRequire(undefined);
});

const order = [];
try {
  createRequire(42, order.push("second argument"));
} catch (error) {
  console.log("arguments", JSON.stringify(order), error.code);
}

const voidOrder = [];
try {
  createRequire(void voidOrder.push("operand"));
} catch (error) {
  console.log("void argument", JSON.stringify(voidOrder), error.code);
}

attempt("void literal", () => createRequire(void 0));
attempt("void undefined", () => createRequire(void undefined));
