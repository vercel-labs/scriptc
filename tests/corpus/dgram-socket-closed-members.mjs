// Every socket member after close(): which ones answer ERR_SOCKET_DGRAM_NOT_RUNNING,
// which ones reach Node's null handle (a plain TypeError), and which keep working
// (ref/unref/type).
import dgram from "node:dgram";

const show = (label, run) => {
  try {
    const value = run();
    const shown =
      value === undefined
        ? "undefined"
        : typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : String(value);
    console.log(label, "ok", shown);
  } catch (err) {
    console.log(label, "throw", err.code, err.name, err.message);
  }
};

const socket = dgram.createSocket("udp4");
await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
socket.close();

show("address", () => socket.address());
show("send", () => socket.send("x", 1, "127.0.0.1"));
show("send no port", () => socket.send("x"));
show("connectSync", () => socket.connectSync(1, "127.0.0.1"));
show("bind", () => socket.bind(0));
show("bindSync", () => socket.bindSync({ port: 0 }));
show("getSendQueueSize", () => socket.getSendQueueSize());
show("getSendQueueCount", () => socket.getSendQueueCount());
show("getRecvBufferSize", () => socket.getRecvBufferSize());
show("setRecvBufferSize", () => socket.setRecvBufferSize(65536));
show("setTTL", () => socket.setTTL(1));
show("setMulticastTTL", () => socket.setMulticastTTL(1));
show("setBroadcast", () => socket.setBroadcast(true));
show("setMulticastLoopback", () => socket.setMulticastLoopback(true));
show("setMulticastInterface", () => socket.setMulticastInterface("0.0.0.0"));
show("addMembership", () => socket.addMembership("224.0.0.1"));
show("dropMembership", () => socket.dropMembership("224.0.0.1"));
show("addSourceSpecificMembership", () =>
  socket.addSourceSpecificMembership("127.0.0.1", "232.0.0.1"),
);
show("dropSourceSpecificMembership", () =>
  socket.dropSourceSpecificMembership("127.0.0.1", "232.0.0.1"),
);
show("disconnect", () => socket.disconnect());
show("remoteAddress", () => socket.remoteAddress());
show("ref", () => socket.ref() === socket);
show("unref", () => socket.unref() === socket);
show("close again", () => socket.close());
show("type", () => socket.type);
