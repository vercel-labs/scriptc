// Parks N async calls on one pending promise and reports how much resident
// memory the suspended calls hold, read from /proc/self/status (Linux).
import { readFileSync } from "node:fs";

function rssKiB(): number {
  for (const line of readFileSync("/proc/self/status", "utf8").split("\n")) {
    if (line.startsWith("VmRSS:")) return Number(line.slice("VmRSS:".length).trim().split(" ")[0]);
  }
  return -1;
}

const gate = Promise.withResolvers<void>();

async function parked(i: number): Promise<number> {
  const label = "call-" + i;
  await gate.promise;
  return label.length;
}

async function main(): Promise<void> {
  const n = Number(process.argv[2]);
  const before = rssKiB();
  const calls: Promise<number>[] = [];
  for (let i = 0; i < n; i++) calls.push(parked(i));
  const suspended = rssKiB();
  gate.resolve();
  let total = 0;
  for (const call of calls) total += await call;
  console.log(`${n} ${total} ${suspended - before}`);
}

main();
