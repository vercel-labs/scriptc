// A ferry terminal and its booths. The terminal starts each booth as a
// child with Node's IPC channel through the two forms that hand the channel
// to another executable: fork() with an execPath and a module path known
// only when the call runs, and spawn() with a fourth stdio entry "ipc".
// The booth is this same program started with "--booth <name>": under Node
// that is Node running this file, compiled it is the executable itself, so
// both ends of the channel are exercised. The terminal prints one line per
// booth when the booth's 'close' (or 'exit') arrives.
import { fork, spawn } from "node:child_process";

type Note = { kind: string; n: number; text: string };

const at = process.argv.indexOf("--booth");
const booth = at < 0 ? "" : (process.argv[at + 1] ?? "");
const self = process.argv[1] ?? "";

function note(kind: string, n: number, text = ""): Note {
  return { kind, n, text };
}

// ── the booths ────────────────────────────────────────────────────────
if (booth === "echo") {
  let seen = 0;
  process.on("message", (got: Note) => {
    seen++;
    process.send?.(note("echo:" + got.kind, got.n, String(process.connected)));
    if (seen === 5) process.disconnect();
  });
  process.send?.(note("ready", 0));
} else if (booth === "bulk") {
  // The terminal says when it has the sheet: a disconnect() with the reply
  // still queued would drop it.
  process.on("message", (got: Note) => {
    if (got.kind === "bye") process.disconnect();
    else process.send?.(note("bulk", got.text.length, got.text.slice(0, 1).repeat(250000)));
  });
  process.send?.(note("ready", 0));
} else if (booth === "early") {
  const kinds: string[] = [];
  process.on("message", (got: Note) => {
    kinds.push(got.kind);
    if (kinds.length === 2) {
      process.send?.(note(kinds.join("+"), kinds.length));
      process.disconnect();
    }
  });
} else if (booth === "leaves") {
  process.send?.(note("last", 1));
  process.send?.(note("last", 2), () => {
    process.disconnect();
    console.log("booth left", process.connected);
  });
} else if (booth === "stays") {
  process.on("disconnect", () => {
    console.log("booth saw the terminal leave", process.connected);
  });
  process.send?.(note("ready", 0));
} else if (booth === "internal") {
  process.send?.({ cmd: "NODE_FERRY", n: 1 });
  process.send?.({ cmd: "NODE_", n: 2 });
  process.send?.({ cmd: "FERRY", n: 3 });
  process.disconnect();
} else if (booth === "report") {
  process.send?.(
    note(
      [
        typeof process.send,
        String(process.connected),
        String(process.env.NODE_CHANNEL_FD),
        String(process.env.NODE_CHANNEL_SERIALIZATION_MODE),
        String(process.env.FERRY),
        process.cwd(),
        process.argv.slice(at).join(" "),
      ].join("|"),
      0,
    ),
  );
  console.log("booth prints to its stdout");
  process.disconnect();
}

// ── the terminal ──────────────────────────────────────────────────────
const sailings: Array<(done: () => void) => void> = [];
function sail(at: number): void {
  const next = sailings[at];
  if (next === undefined) {
    console.log("terminal closed");
    return;
  }
  next(() => sail(at + 1));
}

sailings.push((done) => {
  const child = fork(self, ["--booth", "echo"], {
    execPath: process.execPath,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const log: string[] = [];
  child.on("message", (got: Note) => {
    log.push(got.kind + ":" + got.n + ":" + got.text);
    if (got.kind === "ready") {
      for (let n = 1; n <= 5; n++) child.send(note("ticket", n));
    }
  });
  child.on("disconnect", () => log.push("disconnect:" + child.connected));
  child.on("exit", (code, signal) => log.push("exit:" + code + ":" + signal));
  child.on("close", (code) => {
    console.log("echo", log.join(" "), code, child.connected);
    done();
  });
});

sailings.push((done) => {
  const child = fork(self, ["--booth", "bulk"], {
    execPath: process.execPath,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const log: string[] = [];
  child.on("message", (got: Note) => {
    if (got.kind === "ready") {
      child.send(note("sheet", 0, "m".repeat(400000)));
    } else {
      log.push(got.kind + ":" + got.n + ":" + got.text.length + ":" + got.text.slice(0, 2));
      child.send(note("bye", 0));
    }
  });
  child.on("close", (code) => {
    console.log("bulk", log.join(" "), code);
    done();
  });
});

sailings.push((done) => {
  const child = fork(self, ["--booth", "early"], {
    execPath: process.execPath,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const queued = [child.send(note("first", 1)), child.send(note("second", 2))];
  const log: string[] = [];
  child.on("message", (got: Note) => log.push(got.kind + ":" + got.n));
  child.on("close", (code) => {
    console.log("early", queued.join(","), log.join(" "), code);
    done();
  });
});

sailings.push((done) => {
  const child = fork(self, ["--booth", "leaves"], { execPath: process.execPath });
  const log: string[] = [];
  child.on("message", (got: Note) => log.push(got.kind + ":" + got.n));
  // A send without a callback on the closed channel is an 'error' event.
  child.on("error", (error) => log.push("error:" + error.message));
  child.on("disconnect", () => {
    log.push("disconnect:" + child.connected + ":" + child.send(note("late", 0)));
  });
  child.on("close", (code) => {
    console.log("leaves", log.join(" "), code);
    done();
  });
});

sailings.push((done) => {
  const child = fork(self, ["--booth", "stays"], {
    execPath: process.execPath,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const log: string[] = [];
  child.on("message", (got: Note) => {
    log.push(got.kind);
    child.disconnect();
    log.push("connected:" + child.connected);
    child.send(note("late", 0), (error) => {
      log.push("callback:" + (error === null ? "null" : error.message));
    });
  });
  child.on("disconnect", () => log.push("disconnect"));
  child.on("exit", (code) => {
    setTimeout(() => {
      console.log("stays", log.join(" "), code);
      done();
    }, 20);
  });
});

sailings.push((done) => {
  const child = fork(self, ["--booth", "internal"], {
    execPath: process.execPath,
    silent: true,
  });
  const log: string[] = [];
  child.on("message", (got: { cmd: string; n: number }) => log.push(got.cmd + ":" + got.n));
  child.on("close", (code) => {
    console.log("internal", log.join(" "), code);
    done();
  });
});

sailings.push((done) => {
  const started = [...process.execArgv, self, "--booth", "report", "north pier"];
  const child = spawn(process.execPath, started, {
    stdio: ["ignore", "pipe", "inherit", "ipc"],
    env: { ...process.env, FERRY: "north" },
    cwd: "/",
  });
  let printed = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    printed += chunk.toString();
  });
  const log: string[] = [];
  child.on("message", (got: Note) => log.push(got.kind));
  child.on("close", (code) => {
    console.log("report", log.join(" "), JSON.stringify(printed), code);
    done();
  });
});

if (booth === "") sail(0);
