// @requires-libnode
// stdin of a child process a Node island started, written natively through the child's own writer:
// strings and bytes, backpressure ('drain' after a write that answered false), end and 'finish',
// writable, destroy, and string chunks after setEncoding.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function closed(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("close", (code) => resolve(code)));
}

async function main(): Promise<void> {
  // Strings and bytes, then end.
  const upper: ChildProcess = lib.start("tr a-z A-Z");
  let out = "";
  upper.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  const input = upper.stdin!;
  console.log("writable", input.writable);
  console.log("write string", input.write("hello "));
  console.log("write bytes", input.write(Buffer.from("world\n")));
  input.on("finish", () => console.log("finish, writable", input.writable));
  input.end();
  console.log("close", await closed(upper), JSON.stringify(out));

  // Backpressure: a child that does not read until told to.
  const slow: ChildProcess = lib.start("sleep 0.3; wc -c");
  let count = "";
  slow.stdout?.on("data", (chunk: Buffer) => {
    count += chunk.toString();
  });
  const chunk = "x".repeat(65536);
  let writes = 0;
  let refused = 0;
  const sink = slow.stdin!;
  const fill = (): void => {
    while (writes < 8) {
      writes++;
      if (!sink.write(chunk)) {
        refused++;
        sink.once("drain", fill);
        return;
      }
    }
    sink.end();
  };
  fill();
  console.log("close", await closed(slow), "bytes", count.trim(), "writes", writes, "refused at least once", refused > 0);

  // String chunks after setEncoding, split across a multibyte character by the child.
  const text: ChildProcess = lib.start("printf 'gr\\303'; sleep 0.1; printf '\\274n\\n'");
  const pieces: string[] = [];
  text.stdout?.setEncoding("utf8");
  text.stdout?.on("data", (piece: string) => pieces.push(piece));
  console.log("close", await closed(text), JSON.stringify(pieces.join("")), pieces.every((p) => typeof p === "string"));

  // destroy closes the pipe: the child sees end of input.
  const cat: ChildProcess = lib.start("cat; echo done");
  let echoed = "";
  cat.stdout?.on("data", (piece: Buffer) => {
    echoed += piece.toString();
  });
  cat.stdin?.write("kept\n");
  setTimeout(() => {
    cat.stdin?.destroy();
  }, 50);
  console.log("close", await closed(cat), JSON.stringify(echoed));
}
main();
