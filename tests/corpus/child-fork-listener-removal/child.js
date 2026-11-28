function reply(kind) { process.send({ kind }); }

// Removed before any message arrives: neither 'off' nor its
// 'removeListener' alias leaves a listener behind.
const first = () => { reply("first"); };
process.on("message", first);
process.off("message", first);

// Registered twice, removed once: one registration still runs, as Node's
// removeListener removes at most one instance.
const twice = () => { reply("twice"); };
process.on("message", twice);
process.on("message", twice);
process.removeListener("message", twice);

// Removing a listener that was never registered changes nothing.
process.off("message", () => { reply("never-registered"); });

const third = () => { reply("third"); };
process.on("message", third);

// The disconnect listener is removed too, so the channel closes silently.
const gone = () => { reply("disconnect-listener"); };
process.on("disconnect", gone);
process.off("disconnect", gone);

process.on("message", (message) => {
  if (message.type === "stop") process.disconnect();
});
