// Scaling probes: promises, timers, console, fs. Usage: async-io <case> <n>
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function awaitChain(n: number): Promise<string> {
  let s = 0;
  for (let i = 0; i < n; i++) s += await Promise.resolve(i);
  return `${s}`;
}
async function asyncCalls(n: number): Promise<string> {
  async function step(i: number): Promise<number> {
    await null;
    return i & 7;
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += await step(i);
  return `${s}`;
}
async function promiseAll(n: number): Promise<string> {
  async function work(i: number): Promise<number> {
    await Promise.resolve();
    return i;
  }
  const ps: Promise<number>[] = [];
  for (let i = 0; i < n; i++) ps.push(work(i));
  const vs = await Promise.all(ps);
  let s = 0;
  for (const v of vs) s += v;
  return `${s}`;
}
async function thenChain(n: number): Promise<string> {
  let p: Promise<number> = Promise.resolve(0);
  for (let i = 0; i < n; i++) p = p.then((v) => v + 1);
  return `${await p}`;
}
async function timersSeq(n: number): Promise<string> {
  let c = 0;
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
    c++;
  }
  return `${c}`;
}
async function timersMany(n: number): Promise<string> {
  // n concurrent timers with spread-out delays (0..19 ms), fired in delay order.
  let c = 0;
  let last = -1;
  let ordered = true;
  await new Promise<void>((resolve) => {
    for (let i = 0; i < n; i++) {
      const d = (i * 7) % 20;
      setTimeout(() => {
        if (d < last) ordered = false;
        last = d;
        c++;
        if (c === n) resolve();
      }, d);
    }
  });
  return `${c} ${ordered}`;
}
async function timersCancel(n: number): Promise<string> {
  let fired = 0;
  const hs = [setTimeout(() => fired++, 50)];
  for (let i = 1; i < n; i++) hs.push(setTimeout(() => fired++, 50 + (i % 10)));
  for (let i = 0; i < hs.length; i++) clearTimeout(hs[i]!);
  await new Promise<void>((r) => setTimeout(r, 1));
  return `${fired}`;
}
async function immediates(n: number): Promise<string> {
  let c = 0;
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => setImmediate(r));
    c++;
  }
  return `${c}`;
}
async function microtasks(n: number): Promise<string> {
  let c = 0;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      c++;
      if (c < n) queueMicrotask(tick);
      else resolve();
    };
    queueMicrotask(tick);
  });
  return `${c}`;
}
async function nextTicks(n: number): Promise<string> {
  let c = 0;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      c++;
      if (c < n) process.nextTick(tick);
      else resolve();
    };
    process.nextTick(tick);
  });
  return `${c}`;
}
function consoleLog(n: number): string {
  for (let i = 0; i < n; i++) console.log("line " + i);
  return "done";
}
function consoleLogMulti(n: number): string {
  for (let i = 0; i < n; i++) console.log("row", i, i * 2, true);
  return "done";
}
function stdoutWrite(n: number): string {
  for (let i = 0; i < n; i++) process.stdout.write("w" + i + "\n");
  return "done";
}
function consoleError(n: number): string {
  for (let i = 0; i < n; i++) console.error("err " + i);
  return "done";
}
function fsSmall(n: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, "f" + i + ".txt"), "content " + i);
  let t = 0;
  for (let i = 0; i < n; i++) t += fs.readFileSync(path.join(dir, "f" + i + ".txt"), "utf8").length;
  const names = fs.readdirSync(dir);
  let e = 0;
  for (let i = 0; i < n; i++) if (fs.existsSync(path.join(dir, "f" + i + ".txt"))) e++;
  for (const nm of names) fs.unlinkSync(path.join(dir, nm));
  fs.rmdirSync(dir);
  return `${t} ${names.length} ${e}`;
}
function fsAppend(n: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const f = path.join(dir, "log.txt");
  for (let i = 0; i < n; i++) fs.appendFileSync(f, "entry " + i + "\n");
  const len = fs.readFileSync(f, "utf8").length;
  fs.unlinkSync(f);
  fs.rmdirSync(dir);
  return `${len}`;
}
function fsBigReadLines(n: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const f = path.join(dir, "big.txt");
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`${i},item${i},${i % 13}`);
  fs.writeFileSync(f, lines.join("\n"));
  const text = fs.readFileSync(f, "utf8");
  let s = 0;
  for (const line of text.split("\n")) s += Number(line.slice(line.lastIndexOf(",") + 1));
  fs.unlinkSync(f);
  fs.rmdirSync(dir);
  return `${s}`;
}
function bufferOps(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const b = Buffer.from("hello " + i, "utf8");
    t += b.length + b.toString("hex").length + b.toString("base64").length;
  }
  return `${t}`;
}

const which = process.argv[2] ?? "";
const n = Number(process.argv[3] ?? "1000");
const t0 = performance.now();
let out = "";
switch (which) {
  case "await-chain": out = await awaitChain(n); break;
  case "async-calls": out = await asyncCalls(n); break;
  case "promise-all": out = await promiseAll(n); break;
  case "then-chain": out = await thenChain(n); break;
  case "timers-seq": out = await timersSeq(n); break;
  case "timers-many": out = await timersMany(n); break;
  case "timers-cancel": out = await timersCancel(n); break;
  case "immediates": out = await immediates(n); break;
  case "microtasks": out = await microtasks(n); break;
  case "next-ticks": out = await nextTicks(n); break;
  case "console-log": out = consoleLog(n); break;
  case "console-log-multi": out = consoleLogMulti(n); break;
  case "stdout-write": out = stdoutWrite(n); break;
  case "console-error": out = consoleError(n); break;
  case "fs-small": out = fsSmall(n); break;
  case "fs-append": out = fsAppend(n); break;
  case "fs-big-read": out = fsBigReadLines(n); break;
  case "buffer-ops": out = bufferOps(n); break;
  default: out = "unknown case";
}
const t1 = performance.now();
console.log(which, n, out);
console.error("T=" + (t1 - t0).toFixed(3));
