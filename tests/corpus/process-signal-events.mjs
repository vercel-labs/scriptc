// Signal events: a listener named by the signal receives the signal's own
// name and number, delivered once per signal, and signal listeners keep the
// loop alive while registered. on/once/off follow EventEmitter identity
// rules; removeListener removes by identity; a handler that re-raises its
// signal runs again; an unknown signal name is refused with
// ERR_UNKNOWN_SIGNAL.
const keepAlive = setInterval(() => {}, 1000);
let deliveries = 0;
const removed = () => console.log("removed should not run");
process.on("SIGUSR2", removed);
process.off("SIGUSR2", removed);
const handler = (name, number) => {
  deliveries += 1;
  console.log("signal", name, number > 0, deliveries);
  if (deliveries === 1) process.kill(process.pid, "SIGUSR2");
  else process.kill(process.pid, "SIGTERM");
};
process.on("SIGUSR2", handler);
process.once("SIGTERM", (name) => {
  console.log("once", name);
  process.off("SIGUSR2", handler);
  clearInterval(keepAlive);
});
try {
  process.kill(process.pid, "SIGNOTREAL");
} catch (error) {
  console.log("unknown", error.code);
}
process.kill(process.pid, "SIGUSR2");
