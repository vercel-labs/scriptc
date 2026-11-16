// The option setters' answers and their documented argument ranges: buffer
// sizes, broadcast, TTL, multicast loopback and the multicast interface.
import dgram from "node:dgram";

const show = (label, run) => {
  try {
    const value = run();
    console.log(label, "ok", value === undefined ? "undefined" : String(value));
  } catch (err) {
    console.log(label, "throw", err.code, err.name, err.message);
  }
};

const socket = dgram.createSocket("udp4");
await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));

show("sendBuffer number", () => typeof socket.getSendBufferSize() === "number");
show("setSendBufferSize", () => socket.setSendBufferSize(128 * 1024));
show("sendBuffer grew", () => socket.getSendBufferSize() >= 128 * 1024);
show("setRecvBufferSize", () => socket.setRecvBufferSize(256 * 1024));
show("recvBuffer grew", () => socket.getRecvBufferSize() >= 256 * 1024);
show("setSendBufferSize fraction", () => socket.setSendBufferSize(1.5));
show("setSendBufferSize negative", () => socket.setSendBufferSize(-1));
show("setSendBufferSize zero", () => socket.setSendBufferSize(0));

show("setBroadcast true", () => socket.setBroadcast(true));
show("setBroadcast false", () => socket.setBroadcast(false));

show("setTTL 5", () => socket.setTTL(5));
show("setTTL 0", () => socket.setTTL(0));
show("setTTL 256", () => socket.setTTL(256));
show("setTTL negative", () => socket.setTTL(-1));
show("setTTL fraction", () => socket.setTTL(1.5));

show("setMulticastTTL 3", () => socket.setMulticastTTL(3));
show("setMulticastTTL 256", () => socket.setMulticastTTL(256));
show("setMulticastLoopback false", () => socket.setMulticastLoopback(false));
show("setMulticastLoopback true", () => socket.setMulticastLoopback(true));

show("setMulticastInterface wildcard", () => socket.setMulticastInterface("0.0.0.0"));
show("setMulticastInterface bogus", () => socket.setMulticastInterface("not-an-address"));

socket.close();
