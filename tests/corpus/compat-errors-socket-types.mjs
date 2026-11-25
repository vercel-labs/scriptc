// ERR_SOCKET_BAD_TYPE: dgram.createSocket accepts udp4 and udp6 only, and
// answers Node's type error for any other type, given as a string or as the
// options object's `type`.
import dgram from "node:dgram";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (e) {
    console.log(label, kind(e), e.name, e.code, JSON.stringify(e.message));
  }
}

shape("string", () => dgram.createSocket("udp9"));
shape("options", () => dgram.createSocket({ type: "sctp" }));
shape("upper", () => dgram.createSocket("UDP4"));
shape("number", () => dgram.createSocket(4));
