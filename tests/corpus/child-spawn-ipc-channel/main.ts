// A spawn with an "ipc" stdio slot: the child gets process.send through the
// channel, the parent reads its message and answers over the same channel.
// The child is a Node process (`node -e`), the MCP bridge's own shape.
import { spawn } from "node:child_process";

const script = `
process.send({ ready: true });
process.on("message", (message) => {
  process.send({ echoed: message.stop });
  process.disconnect();
});
`;
const child = spawn("node", ["-e", script], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
console.log("channel", child.connected, child.stdio.length);
child.on("message", (message: unknown) => {
  const seen = message as { ready?: boolean; echoed?: string };
  console.log("message", JSON.stringify(seen));
  if (seen.ready === true) child.send({ stop: "now" });
});
child.on("exit", (code: number | null) => {
  console.log("exit", code);
  closedChannelCase();
});

// A failed launch with the ipc slot still answers connected === true: Node
// builds the channel from the configured slot, not the live child.
const failed = spawn("/definitely/not/a/binary", [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
console.log("failed", failed.connected);
failed.on("error", (error: NodeJS.ErrnoException) => console.log("failed error", error.code));

// A send over a closed channel answers false and reports Node's
// ERR_IPC_CHANNEL_CLOSED as an asynchronous 'error' event, so the return
// value is logged before the error. It runs after the first child's exit so
// the interleaving of two live children cannot make the output racy.
function closedChannelCase(): void {
  const closed = spawn("node", ["-e", ""], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  closed.on("error", (error: NodeJS.ErrnoException) => console.log("closed error", error.code));
  closed.on("exit", () => {
    console.log("send", closed.send({ late: 1 }));
  });
}
