// @requires-libnode
// The message channel of a child a Node island forked, used natively: send, 'message', connected,
// disconnect and 'disconnect' are the island child's.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface Reply {
  echo: { n: number; text: string };
}

async function main(): Promise<void> {
  const child: ChildProcess = lib.echo();
  console.log("has a channel", "send" in child, "connected", child.connected);
  const replies: string[] = [];
  child.on("message", (message) => {
    const reply = message as Reply;
    replies.push(`${reply.echo.n}:${reply.echo.text}`);
    if (reply.echo.n === 1) console.log("send", child.send({ n: 2, text: "again" }));
    else if (reply.echo.n === 2) child.send({ n: 3, text: "last" }, (error) => console.log("send callback", error === null));
    else child.send({ bye: true });
  });
  child.on("disconnect", () => console.log("disconnect, connected", child.connected));
  child.send({ n: 1, text: "first" });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  console.log("replies", replies.join(" "), "exitCode", child.exitCode);
}
main();
