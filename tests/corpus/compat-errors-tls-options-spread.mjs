// A spread of union-typed TLS options into tls.connect: Node builds the
// plain options object and validates its members, so an invalid
// minVersion/maxVersion throws ERR_TLS_INVALID_PROTOCOL_VERSION.
import tls from "node:tls";

function attempt(label, options) {
  try {
    tls.connect({ port: 1, host: "127.0.0.1", ...options }).on("error", () => {});
    console.log(label, "constructed");
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
}

const flip = Math.random() < -1;
attempt("ternary", flip ? { maxVersion: "bogus" } : { minVersion: "TLSv9" });

const pairs = [
  ["min", { minVersion: "TLSv9" }],
  ["max", { maxVersion: "bogus" }],
  ["bad", { minVersion: "tls1.3" }],
];
for (const [label, options] of pairs) attempt(label, options);

const simple = { minVersion: "TLSv9" };
attempt("simple", simple);
