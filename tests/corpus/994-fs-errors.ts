// fs failures are CATCHABLE — the payoff of the exceptions phase: a try
// around each failing call recovers and execution continues after the
// catch, exactly like Node. The message text itself cannot be observed here
// (the supported catch form is bindingless); its Node-matching format
// ("ENOENT: no such file or directory, open 'x'") is asserted by the
// runtime C tests instead.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") {
    i = i - 1;
  }
  return path.slice(i + 1);
}
function freshDir(dir: string): void {
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      rmSync(dir + "/" + name);
    }
    rmdirSync(dir);
  }
  mkdirSync(dir);
}
const scratch = "tmp-994-" + tail(process.argv[1]) + "-" + process.pid;
freshDir(scratch);

let caught = 0;
try {
  const text = readFileSync(scratch + "/missing.txt", "utf8");
  console.log("unreachable", text);
} catch {
  caught = caught + 1;
  console.log("caught: read of a missing file");
}
try {
  mkdirSync(scratch); // already exists → EEXIST
} catch {
  caught = caught + 1;
  console.log("caught: mkdir of an existing path");
}
try {
  mkdirSync(scratch + "/nope/deep"); // missing parent → ENOENT
} catch {
  caught = caught + 1;
  console.log("caught: mkdir under a missing parent");
}
try {
  rmSync(scratch + "/missing.txt");
} catch {
  caught = caught + 1;
  console.log("caught: rm of a missing path");
}
try {
  rmdirSync(scratch + "/missing");
} catch {
  caught = caught + 1;
  console.log("caught: rmdir of a missing path");
}
try {
  const names = readdirSync(scratch + "/missing");
  console.log("unreachable", names.length);
} catch {
  caught = caught + 1;
  console.log("caught: readdir of a missing path");
}
console.log("total caught:", caught);

// existsSync never throws — a missing path is simply false.
console.log(existsSync(scratch + "/missing.txt"));

// Errors propagate through call chains to the nearest catch, like any throw.
function readOrDefault(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}
console.log(readOrDefault(scratch + "/missing.txt", "the default"));
writeFileSync(scratch + "/real.txt", "the real content");
console.log(readOrDefault(scratch + "/real.txt", "the default"));

// finally runs on the exception path of a failing fs call.
try {
  try {
    readFileSync(scratch + "/also-missing.txt", "utf8");
  } finally {
    console.log("finally ran");
  }
} catch {
  console.log("caught after finally");
}

rmSync(scratch + "/real.txt");
rmdirSync(scratch);
console.log(existsSync(scratch));
