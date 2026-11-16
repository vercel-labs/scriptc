// net's argument ladders with long or non-number values: the messages carry
// the value's rendering in full, or Node's own truncated string form.
const net = require("node:net");

function attempt(label, op) {
  try {
    op();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, e.name, e.code, JSON.stringify(e.message));
  }
}

const big = BigInt("1" + "0".repeat(60));
attempt("net bigint port", () => net.connect(big));
attempt("net bigint option", () => net.connect({ port: big }));
attempt("socket bigint port", () => new net.Socket().connect(big));
attempt("socket string port", () => new net.Socket().connect({ port: "x".repeat(400) }));
attempt("net long string port", () => net.connect({ port: "y".repeat(400) }));
attempt("missing", () => new net.Socket().connect());
