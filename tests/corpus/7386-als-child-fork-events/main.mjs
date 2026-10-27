// AsyncLocalStorage contexts of a forked child's IPC events. The child's
// 'message', 'disconnect', 'exit' and 'close' events run in the context of
// the fork() call, whatever context registered the listener; a send()
// callback runs in the context of the send() call.
import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";

const store = new AsyncLocalStorage();
const lines = [];
const log = (what) => lines.push(`${what}: ${store.getStore() ?? "none"}`);

const child = store.run("fork", () =>
  childProcess.fork(new URL("./worker.mjs", import.meta.url), []),
);
store.run("listen", () => {
  child.on("message", (message) => log(`message ${JSON.stringify(message)}`));
});
child.on("disconnect", () => log("disconnect"));
store.run("send", () => child.send("hi", () => log("send callback")));
setTimeout(() => store.run("send-bye", () => child.send("bye")), 50);
child.on("exit", () => log("exit"));
child.on("close", () => {
  log("close");
  for (const line of lines) console.log(line);
});
