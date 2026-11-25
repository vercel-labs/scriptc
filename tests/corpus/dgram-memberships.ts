// Multicast memberships: an unbound socket's implicit wildcard bind (no
// 'listening' emission), the plain and source-specific joins, and the
// argument ladder of the source-specific pair.
import * as dgram from "node:dgram";

function attempt(label: string, op: () => unknown): void {
  try {
    op();
    console.log(label, "ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const events: string[] = [];
const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
socket.on("listening", () => events.push("listening"));

// The join on an unbound socket binds the wildcard on an ephemeral port.
socket.addMembership("224.0.0.114", "127.0.0.1");
const bound = socket.address();
console.log("implicit bind", bound.address, bound.family, typeof bound.port);
socket.addSourceSpecificMembership("127.0.0.1", "232.0.0.1", "127.0.0.1");
socket.dropSourceSpecificMembership("127.0.0.1", "232.0.0.1", "127.0.0.1");
socket.dropMembership("224.0.0.114", "127.0.0.1");
await new Promise<void>((resolve) => setImmediate(resolve));
console.log("events", events.join(","));

attempt("bad source", () => socket.addSourceSpecificMembership("nope", "232.0.0.1"));
attempt("bad group", () => socket.addSourceSpecificMembership("127.0.0.1", "nope"));
attempt("bad interface", () =>
  socket.dropSourceSpecificMembership("127.0.0.1", "232.0.0.1", "nope"),
);
socket.close();
