// Answer every request with its payload and whether Node handed the message
// listener a second argument (a sent handle): no handle is transferred, so
// it is always undefined. The eighth answer drops the channel, so the child
// exits on its own and the parent sees 'close'.
let seen = 0;
process.on("message", (message: { echo: string }, sendHandle: any) => {
  process.send?.({ echo: message.echo, handle: sendHandle === undefined }, null, () => {});
  seen++;
  if (seen === 8) process.disconnect();
});
