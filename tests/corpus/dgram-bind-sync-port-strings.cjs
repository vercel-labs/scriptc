// bindSync's port string arm: JavaScript's ToNumber ('0x10000' is 65536,
// "12abc" is NaN) then Node's integer/range test.
const dgram = require("node:dgram");

function attempt(label, op) {
  try {
    op();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, "throws", e.name, e.code, JSON.stringify(e.message));
  }
}

attempt("trailing text", () => dgram.createSocket("udp4").bindSync({ port: "12abc" }));
attempt("hex over range", () => dgram.createSocket("udp4").bindSync({ port: "0x10000" }));
attempt("exponent over range", () => dgram.createSocket("udp4").bindSync({ port: "1e9" }));
attempt("fraction", () => dgram.createSocket("udp4").bindSync({ port: "1.5" }));
attempt("empty", () => dgram.createSocket("udp4").bindSync({ port: "" }));

const socket = dgram.createSocket("udp4");
attempt("whitespace zero", () => {
  socket.bindSync({ port: "  0  " });
  console.log("bound", socket.address().family, socket.address().address);
});
socket.close();
