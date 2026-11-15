// A signal that only looks like an AbortSignal (`'aborted' in signal`) passes
// Node's validateAbortSignal; the listener install then calls
// signal.addEventListener, and the TypeError it throws must leave nothing
// dialing or registered behind a caller that only sees the exception.
const net = require("node:net");

function attempt(label, fn) {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    console.log(label, error.name, error.code === undefined ? "-" : error.code, error.message);
  }
}

attempt("tcp", () => net.connect({ host: "127.0.0.1", port: 1, signal: { aborted: false } }));
attempt("path", () => net.connect({ path: "/tmp/scriptc-missing.sock", signal: { aborted: false } }));
attempt("listen", () => net.createServer().listen({ port: 0, signal: { aborted: false } }));
console.log("done");
