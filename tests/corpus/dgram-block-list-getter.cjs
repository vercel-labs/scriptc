// createSocket's block lists are options members like any other: a getter
// runs, and the option family this runtime does not implement is refused
// instead of silently skipped.
const dgram = require("node:dgram");
const net = require("node:net");

const native = process.versions.v8 === undefined;
const options = { type: "udp4" };
const blockList = new net.BlockList();
let reads = 0;
Object.defineProperty(options, "receiveBlockList", {
  get() {
    reads += 1;
    return blockList;
  },
  enumerable: true,
});

let outcome = "created";
try {
  const socket = dgram.createSocket(options);
  socket.close();
} catch (err) {
  outcome = err.code || err.message;
}
console.log("block list", reads > 0, outcome === (native ? "SC2020" : "created"));
