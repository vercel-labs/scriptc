import { fork } from "node:child_process";

const child = fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});

// Start the deadline after the child is ready so process startup is not part
// of the bound. Queued IPC must not wait for the idle poll timeout (1 second
// per handoff), or for this timer to wake the loop. No periodic wakeups.
let replies = 0;
let sent = 0;
let disconnected = false;
let closed = false;
let exit: number | null = null;
// 'disconnect' belongs to the channel and 'close' to the process, and Node
// emits each when its own descriptor reports: on a busy machine 'close' can
// come first. The exchange is complete once both have happened.
const report = (): void => {
  if (disconnected && closed)
    console.log("replies", replies, "sent", sent, "disconnected", disconnected, "exit", exit);
};
child.once("message", () => {
  const deadline = setTimeout(() => {
    console.log("IPC stalled");
  }, 500);
  child.on("message", (message: { value: number }) => {
    replies++;
    if (message.value < 3) {
      child.send({ value: message.value + 1 }, (error) => {
        if (error) throw error;
        sent++;
      });
    }
  });
  child.once("disconnect", () => {
    disconnected = true;
    clearTimeout(deadline);
    report();
  });
  child.send({ value: 1 }, (error) => {
    if (error) throw error;
    sent++;
  });
});
// Exit can precede delivery of the last IPC message. Close waits for the
// channel to drain before observing the completed exchange.
child.once("close", (code) => {
  closed = true;
  exit = code;
  report();
});
