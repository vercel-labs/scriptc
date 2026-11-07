// A write flag is arbitrary input: its refusal names the argument 'flags'
// and prints the text the way inspect does — escaped, clipped to 128
// UTF-16 units plus "..." — whatever its length. The sync, promises, open
// callback and stream entry points all report the same refusal, and no
// file is created for one.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-long-flags-"));
const file = (name: string): string => path.join(dir, name);

const report = (label: string, e: unknown): void => {
  if (e instanceof Error) {
    console.log(label, e.name, (e as NodeJS.ErrnoException).code, e.message.split(dir).join("<dir>"));
  } else console.log(label, "non-error", String(e));
};

const long = "x".repeat(1024);
// Long enough to clip, and carrying the characters inspect escapes: the
// apostrophe, double quote and backtick pick the quoting pair, and the
// controls and non-ASCII character's own boundary count in UTF-16 units.
const mixed = "z".repeat(300) + "'\"\n\\\u0007é";

try {
  fs.writeFileSync(file("long-sync.txt"), "a", { flag: long });
} catch (e) {
  report("long-sync", e);
}
try {
  fs.appendFileSync(file("long-append.txt"), "a", { flag: long });
} catch (e) {
  report("long-append", e);
}
try {
  fs.writeFileSync(file("mixed-sync.txt"), "a", { flag: mixed });
} catch (e) {
  report("mixed-sync", e);
}
console.log("created:", fs.existsSync(file("long-sync.txt")), fs.existsSync(file("long-append.txt")));

// The clip boundary sits where the quoted text reaches 128 units: 126
// characters still print whole with their closing quote, 127 clip.
for (const size of [126, 127, 129]) {
  try {
    fs.writeFileSync(file(`boundary-${size}.txt`), "a", { flag: "q".repeat(size) });
  } catch (e) {
    report(`boundary-${size}`, e);
  }
}

try {
  fs.openSync(file("long-open.txt"), long);
} catch (e) {
  report("long-open", e);
}

await fsp.writeFile(file("long-promise.txt"), "a", { flag: long }).catch((e: unknown) => {
  report("long-promise", e);
});
console.log("promise created:", fs.existsSync(file("long-promise.txt")));

const stream = fs.createWriteStream(file("long-stream.txt"), { flags: long });
await new Promise<void>((resolve) => {
  stream.on("error", (e: unknown) => {
    report("long-stream", e);
    resolve();
  });
});

// The descriptor's utf8 arm parses the flag it carries.
const fd = fs.openSync(file("long-fd.txt"), "w");
try {
  fs.writeFileSync(fd, "fd", { encoding: "utf8", flag: long });
} catch (e) {
  report("long-fd", e);
}
try {
  fs.appendFileSync(fd, "fd", { encoding: "utf8", flag: long });
} catch (e) {
  report("long-fd-append", e);
}
fs.closeSync(fd);
console.log("fd text:", JSON.stringify(fs.readFileSync(file("long-fd.txt"), "utf8")));

// A short invalid flag keeps its ordinary rendering.
try {
  fs.writeFileSync(file("short.txt"), "a", { flag: "p" });
} catch (e) {
  report("short", e);
}
