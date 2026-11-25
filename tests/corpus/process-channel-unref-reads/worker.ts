// The channel is unref'd before the parent's message can arrive, so only
// the referenced timer keeps this process alive; the message proves the
// unref'd channel still reads. process.connected stays true: unref is a
// keep-alive call, not a disconnect.
const channel = process.channel;
console.log("connected", process.connected, typeof channel);
channel?.unref();

setTimeout(() => {
  console.log("timer fired; no message");
  process.exit(0);
}, 150);

process.on("message", (message: unknown) => {
  console.log("message", JSON.stringify(message));
  process.exit(0);
});
