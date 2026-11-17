// The argument ladders of createSocket's buffer sizes and bindSync's port
// with long Received tails: the messages carry the value's rendering in
// full, never bytes past the formatter's buffer.
const dgram = require("node:dgram");

function attempt(label, op) {
  try {
    const value = op();
    console.log(label, "ok", typeof value);
  } catch (e) {
    console.log(label, e.name, e.code, JSON.stringify(e.message));
  }
}

const big = BigInt("1" + "0".repeat(60));
attempt("bigint recv", () => dgram.createSocket({ type: "udp4", recvBufferSize: big }));
attempt("string recv", () =>
  dgram.createSocket({ type: "udp4", recvBufferSize: "x".repeat(400) }),
);
attempt("fraction recv", () => dgram.createSocket({ type: "udp4", recvBufferSize: 1.5 }));
attempt("range send", () => dgram.createSocket({ type: "udp4", sendBufferSize: -1 }));

const fresh = dgram.createSocket("udp4");
attempt("string port", () => fresh.bindSync({ port: "x".repeat(400) }));
attempt("bigint port", () => fresh.bindSync({ port: big }));
fresh.close();
