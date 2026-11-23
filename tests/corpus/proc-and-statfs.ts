// statfsSync and /proc reads, the filesystem slice an Ink-style terminal
// dashboard leans on: the statfs record's fields agree with Node's, and a
// /proc file reads back the same text both ways. /proc is Linux-only, so
// the reads run behind the platform test; macOS programs take the other
// branch in both the oracle and the binary.
import { readFileSync, statfsSync } from "node:fs";

const stats = statfsSync("/");
console.log(typeof stats.type, typeof stats.bsize, typeof stats.blocks);
console.log(typeof stats.bfree, typeof stats.bavail, typeof stats.files, typeof stats.ffree);
console.log(stats.bsize > 0, stats.blocks > 0, stats.bfree >= 0, stats.bavail >= 0);
console.log(stats.files >= 0, stats.ffree >= 0);

if (process.platform === "linux") {
  const mounts = readFileSync("/proc/self/mounts", "utf8");
  const rootLine = mounts.split("\n").find((line) => {
    const fields = line.split(" ");
    return fields[1] === "/";
  });
  console.log(rootLine?.split(" ").slice(0, 3).join(" "));

  const ostype = readFileSync("/proc/sys/kernel/ostype", "utf8").trim();
  console.log(ostype);
  const version = readFileSync("/proc/version", "utf8");
  console.log(version.startsWith("Linux version "), version.length > 0);
} else {
  console.log("proc reads skipped outside linux");
}
