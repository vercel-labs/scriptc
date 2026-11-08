// A function passed BY NAME as a child's 'exit' or 'close' listener may
// declare the exit code as `number` (TypeScript accepts it through
// ChildProcess's catch-all `on` overload). The function keeps its type: it
// registers as it is, a child that exits by itself calls it with the code,
// `removeListener` and `off` find it by identity, and the program can still
// call it directly.
import { spawn, type ChildProcess } from "node:child_process";

interface Chore {
  label: string;
  script: string;
  attach: (chore: ChildProcess) => void;
}

const chores: Chore[] = [];

// One child at a time, so the lines come in the order of the list.
function runFrom(index: number): void {
  const next = chores[index];
  if (next === undefined) return;
  const chore = spawn("sh", ["-c", next.script]);
  next.attach(chore);
  // Registered last: runs after every listener the case attached.
  chore.on("close", () => {
    console.log(`${next.label}: closed`);
    runFrom(index + 1);
  });
}

// A const arrow, on 'close'.
const tally = (code: number) => {
  console.log(`tally ${code + 1}`);
};
chores.push({
  label: "arrow",
  script: "exit 4",
  attach: (chore) => {
    chore.on("close", tally);
  },
});

// A function declaration, on 'exit', with the signal as Node types it.
function report(code: number, signal: NodeJS.Signals | null): void {
  console.log(`report ${code} ${signal}`);
}
chores.push({
  label: "declaration",
  script: "exit 2",
  attach: (chore) => {
    chore.on("exit", report);
  },
});

// A member of a record, registered once.
const hooks = {
  done: (code: number): void => {
    console.log(`hook ${code === 0 ? "clean" : "failed"}`);
  },
};
chores.push({
  label: "member",
  script: "exit 0",
  attach: (chore) => {
    chore.once("close", hooks.done);
  },
});

// A function value that arrives as a parameter.
function watch(chore: ChildProcess, listener: (code: number) => void): void {
  chore.on("close", listener);
}
chores.push({
  label: "parameter",
  script: "exit 7",
  attach: (chore) => {
    watch(chore, (code: number) => {
      console.log(`watched ${code}`);
    });
  },
});

// Removed by identity before the child ends: never called.
const dropped = (code: number) => {
  console.log(`dropped ${code}`);
};
chores.push({
  label: "removed",
  script: "exit 5",
  attach: (chore) => {
    chore.on("close", dropped);
    chore.on("exit", dropped);
    chore.removeListener("close", dropped);
    chore.off("exit", dropped);
  },
});

// Registered twice, removed once: called once.
const twice = (code: number) => {
  console.log(`twice ${code}`);
};
chores.push({
  label: "twice",
  script: "exit 6",
  attach: (chore) => {
    chore.on("close", twice);
    chore.on("close", twice);
    chore.removeListener("close", twice);
  },
});

// Removed from inside another listener, after the child started.
const late = (code: number) => {
  console.log(`late ${code}`);
};
chores.push({
  label: "late",
  script: "exit 1",
  attach: (chore) => {
    chore.on("close", late);
    chore.on("spawn", () => {
      chore.removeListener("close", late);
    });
  },
});

// The same functions are still ordinary functions.
tally(40);
report(9, "SIGHUP");
runFrom(0);
