import { spawnSync } from "node:child_process";

if (process.argv.at(2) === "child") {
  console.log(`child args: ${process.argv.slice(2).join(",")}`);
} else {
  const child = spawnSync(process.execPath, [process.argv[1], "child"], { encoding: "utf8" });
  console.log(`status: ${child.status}`);
  console.log(child.stdout);
  console.log(child.stderr);
}
