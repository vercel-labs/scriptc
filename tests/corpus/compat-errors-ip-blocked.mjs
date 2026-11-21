// A net.Socket connecting to an address its BlockList refuses answers
// ERR_IP_BLOCKED with Node's message, before any dial.
import net from "node:net";

const blocked = new net.BlockList();
blocked.addAddress("127.0.0.1", "ipv4");
await new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port: 9, blockList: blocked });
  socket.on("error", (error) => {
    console.log("connect", error.name, error.code, JSON.stringify(error.message));
    resolve(undefined);
  });
  socket.on("close", () => resolve(undefined));
});
