// A write/end payload held as an untyped value applies its encoding when
// it is a string at run time (a Buffer ignores the encoding).
const net = require("node:net");

function payload(value) {
  return value;
}

const chunks = [];
const server = net.createServer((socket) => {
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  socket.on("end", () => {
    console.log("received", Buffer.concat(chunks).toString("hex"));
    socket.end();
  });
});
server.listen(0, "127.0.0.1", () => {
  const client = new net.Socket();
  client.connect(server.address().port, "127.0.0.1", () => {
    console.log("write hex", client.write(payload("6869"), "hex"));
    console.log("write bytes ignores encoding", client.write(payload(Buffer.from("raw")), "base64"));
    client.end(payload("aGk="), "base64");
  });
  client.on("close", () => server.close(() => console.log("closed")));
  client.on("data", () => {});
});
