const channel = process.channel;
console.log("start typeof", typeof channel, "connected", process.connected);
process.on("message", (message: { kind: string }) => {
  console.log("message", JSON.stringify(message));
  process.disconnect();
  console.log("after disconnect connected", process.connected, "channel", process.channel);
  console.log("channel is null", process.channel === null);
  console.log("captured ref", channel?.ref(), "captured unref", channel?.unref());
});
