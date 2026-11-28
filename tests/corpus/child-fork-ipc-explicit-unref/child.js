// An explicit unref pins the channel: adding a listener afterwards does not
// ref it again, so the process has nothing left on the loop and exits.
process.channel?.unref();
process.on("message", () => {});
