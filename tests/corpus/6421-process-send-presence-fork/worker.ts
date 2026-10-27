const sink = process.send ? "ipc" : "stdout";
if (process.send) {
  process.send({ sink, send: typeof process.send, disconnect: typeof process.disconnect });
}
if (!process.send) console.log("unreachable");
process.disconnect();
