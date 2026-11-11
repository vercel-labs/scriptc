// A listener that reads its Sign stream closes a cycle: the signer holds the
// stream and the stream holds the listener. A dropped signer is reclaimed
// with its stream, which the sanitized lane's exit audit observes.
import * as crypto from "node:crypto";

function build(i: number): void {
  const signer = crypto.createSign("sha256");
  signer.on("finish", () => {
    console.log("finish", i, signer.writableFinished);
  });
  signer.end(`payload ${i}`);
}

for (let i = 0; i < 4; i = i + 1) build(i);
console.log("done");
