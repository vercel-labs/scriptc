// A non-recursive fs.watch of a DIRECTORY reports writes to the files
// already inside it: an in-place rewrite and an append, not only entries
// that appear or leave. It reports nothing one directory down. Every
// trigger retries until the event lands, because FSEvents starts
// asynchronously and can coalesce a file's recent creation into a later
// modify; each phase observes "the watcher fired", never an exact count.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watch-dir-"));
const file = join(dir, "a.txt");
const nested = join(dir, "sub");
fs.writeFileSync(file, "one\n");
fs.mkdirSync(nested);
let fired = 0;
const watcher = fs.watch(dir, () => {
  fired += 1;
});

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `action` on an interval until the watcher fires (`want`), or until
 * the bound runs out for the phase that expects silence. */
function phase(label: string, action: () => void, want: boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = fired;
    let kicks = 0;
    const timer = setInterval(() => {
      kicks += 1;
      action();
      if (fired !== start) {
        clearInterval(timer);
        console.log(`${label}: seen`);
        resolve();
      } else if (!want && kicks >= 6) {
        clearInterval(timer);
        console.log(`${label}: none`);
        resolve();
      } else if (kicks > 400) {
        clearInterval(timer);
        console.error(`${label}: never delivered`);
        process.exit(1);
      }
    }, 50);
  });
}

async function main(): Promise<void> {
  await phase("rewrite in place", () => fs.writeFileSync(file, "two\n"), true);
  await phase("append", () => fs.appendFileSync(file, "three\n"), true);
  const created = join(dir, "b.txt");
  await phase(
    "create an entry",
    () => {
      fs.rmSync(created, { force: true });
      fs.writeFileSync(created, "new\n");
    },
    true,
  );
  // Anything the earlier phases had queued drains before the silence check.
  await settle(500);
  await phase(
    "nested write",
    () => fs.appendFileSync(join(nested, "n.txt"), "x\n"),
    false,
  );
  watcher.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("done");
}

main();
