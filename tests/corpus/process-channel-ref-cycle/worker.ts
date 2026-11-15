const channel = process.channel;
if (channel) {
  channel.unref();
  console.log("unref'd at start; connected", process.connected);
  setTimeout(() => {
    channel.ref();
    console.log("ref'd again; connected", process.connected);
    process.send?.({ kind: "alive" });
    process.disconnect();
    console.log("disconnected; connected", process.connected, "channel", process.channel);
  }, 10);
} else {
  console.log("no channel");
}
