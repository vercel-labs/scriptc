// Answer the single request and drop the IPC channel, so the child exits on
// its own and the parent observes the channel turning null.
process.once("message", (message: { go: boolean }) => {
  process.send?.({ ack: message.go });
  process.disconnect();
});
