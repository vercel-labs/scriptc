// A subtree moved out of a recursive watch must stop delivering: its
// directories' watches go with it. After `a` leaves the watched root, writes
// at the new location must not be reported under the old `a/...` name, and
// moving it back in must join the watch again under the new name.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-rec-move-"));
const outside = fs.mkdtempSync(join(tmpdir(), "scr-rec-outside-"));
const names: string[] = [];
let step = "initial";
let ticks = 0;
let settle = 0;
let initial = false;
let movedBack = false;
let stale = 0;

const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
  if (typeof filename === "string") names.push(filename.replaceAll("\\", "/"));
});

const kick = setInterval(() => {
  ticks += 1;
  if (ticks > 500) {
    console.error(`move watch stayed at ${step}`);
    process.exit(1);
  }
  if (step === "initial") {
    if (ticks === 1) {
      fs.mkdirSync(join(dir, "a"));
      fs.mkdirSync(join(dir, "a", "b"));
    }
    fs.writeFileSync(join(dir, "a", "b", "y.txt"), String(ticks));
    if (names.includes("a/b/y.txt")) {
      initial = true;
      step = "drain";
      settle = 0;
    }
  } else if (step === "drain") {
    // Let the last deliveries of the initial writes land, then start from a
    // clean list: only the events after this point are judged.
    settle += 1;
    if (settle < 5) return;
    names.length = 0;
    fs.renameSync(join(dir, "a"), join(outside, "a"));
    step = "moved out";
    settle = 0;
  } else if (step === "moved out") {
    // Give the rename a moment to be processed before writing below the new
    // location; those writes are outside the watched root.
    settle += 1;
    if (settle < 6) return;
    fs.writeFileSync(join(outside, "a", "b", "y.txt"), String(ticks));
    if (settle === 30) {
      stale = names.filter((name) => name.startsWith("a/")).length;
      names.length = 0;
      fs.renameSync(join(outside, "a"), join(dir, "a2"));
      step = "moved back";
      settle = 0;
    }
  } else if (step === "moved back") {
    settle += 1;
    if (settle < 6) return;
    fs.writeFileSync(join(dir, "a2", "b", "y.txt"), String(ticks));
    if (names.includes("a2/b/y.txt")) {
      movedBack = true;
      clearInterval(kick);
      watcher.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      console.log("initial", initial);
      console.log("moved out", stale === 0, "stale", stale);
      console.log("moved back", movedBack);
      console.log("done");
    }
  }
}, 20);
