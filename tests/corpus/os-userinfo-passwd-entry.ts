// os.userInfo() reads the passwd entry of the effective uid, so uid and
// gid are the entry's pw_uid and pw_gid (the user's primary group, which
// can differ from the process gid). os.homedir() answers $HOME whenever it
// is set, an empty value included. The program re-runs itself with HOME
// set to "" and with HOME removed, and prints each child's answer.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";

const mode = process.argv[2];
if (mode === "home") {
  console.log(JSON.stringify(os.homedir()));
} else {
  const info = os.userInfo();
  console.log(Object.keys(info).join(","));
  // The /etc/passwd line for this user, when the file lists it.
  let entry: string[] | undefined;
  if (existsSync("/etc/passwd")) {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":");
      if (fields.length >= 7 && fields[0] === info.username) entry = fields;
    }
  }
  if (entry) {
    console.log("uid matches entry:", String(info.uid) === entry[2]);
    console.log("gid matches entry:", String(info.gid) === entry[3]);
    console.log("homedir matches entry:", info.homedir === entry[5]);
    console.log("shell matches entry:", info.shell === entry[6]);
  } else {
    console.log("no passwd entry");
  }
  const empty = spawnSync(process.execPath, [process.argv[1], "home"], {
    encoding: "utf8",
    env: { ...process.env, HOME: "" },
  });
  console.log("HOME empty:", empty.status, empty.stdout.trim());
  const env = { ...process.env };
  delete env.HOME;
  const unset = spawnSync(process.execPath, [process.argv[1], "home"], { encoding: "utf8", env });
  const fromPasswd = entry ? JSON.stringify(entry[5]) : JSON.stringify(info.homedir);
  console.log("HOME unset is passwd home:", unset.status, unset.stdout.trim() === fromPasswd);
}
