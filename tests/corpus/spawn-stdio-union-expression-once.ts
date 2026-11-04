// A union-typed stdio expression that has a side effect is read ONCE at the
// call: Node evaluates the options value once, so the three slots it feeds
// must agree, and the counter stays at one read. Node also evaluates the
// options members in source order, so a cwd expression before the stdio
// member runs first and a detached expression after it runs last.
import { spawn } from "node:child_process";

type Mode = "ignore" | "pipe";

let reads = 0;

function nextMode(): Mode {
  reads++;
  return "ignore";
}

const order: string[] = [];

function note(label: string): string {
  order.push(label);
  return label;
}

function runOrdered(): void {
  const child = spawn("/bin/sh", ["-c", "exit 0"], {
    cwd: (order.push("cwd"), process.cwd()),
    stdio: (order.push("stdio"), "pipe" as Mode),
    detached: (order.push("detached"), false),
  });
  child.on("exit", () => {
    console.log(order.join(","));
    runTuple();
  });
}

function runTuple(): void {
  const child = spawn("/bin/sh", ["-c", "exit 0"], {
    cwd: (order.push("cwd2"), process.cwd()),
    stdio: ["ignore", (order.push("out2"), "pipe" as Mode), "ignore"],
  });
  child.on("exit", () => {
    console.log(order.slice(3).join(","));
  });
}

function run(): void {
  const child = spawn("/bin/sh", ["-c", "printf 'hidden\\n' 1>&2; exit 3"], {
    stdio: nextMode(),
  });
  child.on("exit", (code) => {
    console.log("code=" + String(code), "reads=" + String(reads));
    runOrdered();
  });
}

run();
