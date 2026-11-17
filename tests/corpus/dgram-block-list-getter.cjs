// createSocket's block lists are options members like any other: a getter
// runs, and the list it answers gates the socket's sends.
const dgram = require("node:dgram");
const net = require("node:net");

const options = { type: "udp4" };
const blockList = new net.BlockList();
blockList.addAddress("127.0.0.1", "ipv4");
let reads = 0;
Object.defineProperty(options, "sendBlockList", {
  get() {
    reads += 1;
    return blockList;
  },
  enumerable: true,
});

const socket = dgram.createSocket(options);
socket.bind(0, "127.0.0.1", () => {
  socket.send("payload", 9, "127.0.0.1", (err) => {
    console.log("block list", reads > 0, err ? err.code : "sent");
    socket.close();
  });
});
