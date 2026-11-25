// Runs in the Node island. The child is a Node program with a message channel: it answers every
// message and leaves when told to. `node` comes from PATH (in the island process.execPath is the
// compiled program itself).
const { spawn } = require("node:child_process");
const CHILD = `process.on("message", (message) => {
  if (message && message.bye) process.disconnect();
  else process.send({ echo: message });
});`;
exports.echo = () => spawn("node", ["-e", CHILD], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
