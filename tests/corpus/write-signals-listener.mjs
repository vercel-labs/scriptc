// Node ignores SIGPIPE and SIGXFSZ until a listener is registered: the
// listener then receives each signal, and the process keeps running.
const keepAlive = setInterval(() => {}, 1000);
let received = 0;
for (const signal of ["SIGPIPE", "SIGXFSZ"]) {
  process.on(signal, (name) => {
    console.log("listener", name);
    if (++received === 2) clearInterval(keepAlive);
  });
}
process.kill(process.pid, "SIGPIPE");
setTimeout(() => process.kill(process.pid, "SIGXFSZ"), 20);
