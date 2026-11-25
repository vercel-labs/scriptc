const channel = process.channel;
console.log("channel typeof", typeof channel);
console.log("connected", process.connected);
if (channel) {
  console.log("ref returns", channel.ref());
  console.log("unref returns", channel.unref());
  console.log("identity", process.channel === channel);
  console.log("connected after unref", process.connected);
}
process.send?.({ kind: "done" });
