// An explicit ref pins the channel: removing the last listener does not
// unref it, so the channel keeps the process alive.
const listener = () => {};
process.on("message", listener);
process.channel?.ref();
process.off("message", listener);
