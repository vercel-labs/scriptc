// fs/promises round-trips (readFile/writeFile/mkdir/readdir/rm/stat) plus
// statSync and Stats members — in a scratch directory derived from
// argv[1]'s tail so the concurrently-running Node and native sides never
// collide (see 992). Rejections are catchable at the await; printed error
// details are path-free (the scratch name differs between the sides).
import { existsSync, rmdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") {
    i = i - 1;
  }
  return path.slice(i + 1);
}

async function main(): Promise<void> {
  const scratch = "tmp-1357-" + tail(process.argv[1]) + "-" + process.pid;
  if (existsSync(scratch)) {
    if (existsSync(scratch + "/a.txt")) {
      rmSync(scratch + "/a.txt");
    }
    rmdirSync(scratch);
  }
  await mkdir(scratch);
  console.log("mkdir", existsSync(scratch));

  await writeFile(scratch + "/a.txt", "héllo 🌍\n");
  const text = await readFile(scratch + "/a.txt", "utf8");
  console.log("read", text === "héllo 🌍\n", text.length);

  const st = await stat(scratch + "/a.txt");
  console.log("stat", st.isFile(), st.isDirectory(), st.size);
  const sd = statSync(scratch);
  console.log("statSync", sd.isDirectory(), sd.isFile());

  const names = await readdir(scratch);
  console.log("readdir", names.length, names[0]);

  // A rejected promise re-throws at the await — catchable, an Error
  // instance with Node's ENOENT message shape.
  try {
    await readFile(scratch + "/missing.txt", "utf8");
    console.log("no-throw");
  } catch (e) {
    if (e instanceof Error) {
      console.log("caught", e.message.startsWith("ENOENT"), e.message.includes("missing.txt"));
    } else {
      console.log("not-an-error");
    }
  }
  try {
    await stat(scratch + "/nope");
    console.log("no-throw");
  } catch (e) {
    console.log("stat-rejects", e instanceof Error);
  }

  await rm(scratch + "/a.txt");
  console.log("rm", existsSync(scratch + "/a.txt"));
  rmdirSync(scratch);
  console.log("done", existsSync(scratch));
}

main();
