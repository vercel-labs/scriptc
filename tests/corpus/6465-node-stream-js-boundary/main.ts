// NodeJS.ReadableStream values crossing into untyped JavaScript and into
// 'unknown': a file stream and a child's stdout share one helper with a
// JavaScript stream consumer, which sees ordinary Node streams.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeStream, streamToText } from "./consume.js";

function open(file: string): NodeJS.ReadableStream {
  return fs.createReadStream(file);
}

function textOf(stream: NodeJS.ReadableStream): Promise<string> {
  return streamToText(stream);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-node-stream-js-"));
  const file = path.join(dir, "input.txt");
  fs.writeFileSync(file, "through javascript\n");
  const held: unknown = open(file);
  console.log(typeof held);
  describeStream(held);
  console.log(JSON.stringify(await textOf(open(file))));
  const child = spawn("sh", ["-c", "printf 'child output\\n'"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (child.stdout !== null) console.log(JSON.stringify(await textOf(child.stdout)));
  fs.rmSync(dir, { recursive: true });
}

void main();
