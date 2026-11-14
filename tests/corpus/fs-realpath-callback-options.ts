// fs.realpath(path[, options], callback) and fs.realpath.native: the callback
// forms answer the path text for a string or { encoding } option, the native
// binding walks the same realpath(2) on POSIX, and a missing entry reports
// ENOENT through the callback.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-realpath-cb-"));
const file = path.join(dir, "file.txt");
const link = path.join(dir, "link.txt");
const missing = path.join(dir, "missing.txt");

function clean(text: string): string {
  return text.split(dir).join("<dir>");
}

function report(
  label: string,
  error: NodeJS.ErrnoException | null,
  resolved: string | undefined,
): void {
  if (error) {
    console.log(label, "error", error.code);
  } else {
    console.log(label, "resolved", clean(resolved ?? ""));
  }
}

async function main(): Promise<void> {
  fs.writeFileSync(file, "payload");
  fs.symlinkSync(file, link);

  await new Promise<void>((resolve) => {
    fs.realpath(link, (error, resolved) => {
      report("plain", error, resolved);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    fs.realpath.native(link, (error, resolved) => {
      report("native", error, resolved);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    fs.realpath(link, "utf8", (error, resolved) => {
      report("utf8", error, resolved);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    fs.realpath(link, { encoding: "utf8" }, (error, resolved) => {
      report("object", error, resolved);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    fs.realpath.native(link, { encoding: "utf8" }, (error, resolved) => {
      report("native object", error, resolved);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    fs.realpath(missing, (error) => {
      console.log("plain missing", error ? error.code : "resolved");
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    fs.realpath.native(missing, (error) => {
      console.log("native missing", error ? error.code : "resolved");
      resolve();
    });
  });

  // Another known encoding re-encodes the resolved path.
  const roundTrip = await new Promise<boolean>((resolve) => {
    fs.realpath(link, "base64", (error, resolved) => {
      resolve(error === null && resolved !== undefined && Buffer.from(resolved, "base64").toString("utf8") === file);
    });
  });
  console.log("base64 round trip", roundTrip);
}

main();
