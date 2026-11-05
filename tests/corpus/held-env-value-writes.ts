// A value HELD from process.env aliases the live environment, exactly as
// Node's one process.env object does: writes, deletes and reads through the
// hold reach the real environment table (setenv/unsetenv/getenv), so a
// later direct read, `in` test, and a spawned child's inherited environment
// all observe them. A COPY made from the hold stays a copy.
import { spawnSync } from "node:child_process";

const env: Record<string, string | undefined> = process.env;
env.SCRIPTC_HELD_WRITE = "one";
console.log("direct:", process.env.SCRIPTC_HELD_WRITE ?? "(unset)");
console.log("held:", env.SCRIPTC_HELD_WRITE ?? "(unset)");

// A computed key writes the same variable.
const key = "SCRIPTC_HELD_" + "computed";
env[key] = "two";
console.log("computed:", process.env[key] ?? "(unset)", env[key] ?? "(unset)");

// The write reaches children through the inherited environment.
const child = spawnSync("sh", ["-c", 'printf %s "$SCRIPTC_HELD_WRITE"'], { encoding: "utf8" });
console.log("child sees:", child.stdout);

// A write made directly is visible through the hold (one object, not a copy).
process.env.SCRIPTC_HELD_LATE = "late";
console.log("late via hold:", env.SCRIPTC_HELD_LATE ?? "(unset)");

// Deletes through the hold unset the real variable.
delete env.SCRIPTC_HELD_WRITE;
console.log(
  "deleted:",
  process.env.SCRIPTC_HELD_WRITE === undefined,
  env.SCRIPTC_HELD_WRITE === undefined,
  "SCRIPTC_HELD_WRITE" in process.env,
);
delete env[key];
console.log("computed deleted:", process.env[key] === undefined, key in process.env);

// An absent key deletes as a no-op, like JS.
delete env.SCRIPTC_HELD_NEVER;
console.log("absent delete:", process.env.SCRIPTC_HELD_NEVER === undefined);

// The VALUE form of a delete through the hold unsets the real variable and
// answers Node's boolean.
env.SCRIPTC_HELD_VALUE = "three";
console.log(delete env.SCRIPTC_HELD_VALUE, process.env.SCRIPTC_HELD_VALUE === undefined);

// A COPY of the hold keeps copy semantics: its writes never touch the
// environment, and its own entries stay. The copy sees the environment as
// it is at the spread, including writes made after the hold.
const copy = { ...env };
copy.SCRIPTC_HELD_COPY = "copy-only";
console.log(
  "copy:",
  copy.SCRIPTC_HELD_COPY,
  process.env.SCRIPTC_HELD_COPY === undefined,
  copy.SCRIPTC_HELD_LATE ?? "(unset)",
);
// Every other bare use of the hold reads the environment at that point too.
console.log(
  "bare:",
  Object.keys(env).includes("SCRIPTC_HELD_LATE"),
  JSON.stringify({ ...env }).includes('"SCRIPTC_HELD_LATE":"late"'),
);
// Holds and process.env are the one environment object: identity
// comparisons between them are equal, and with a primitive never.
const alias = env;
console.log(
  "identity:",
  env === env,
  env === alias,
  alias == process.env,
  env !== process.env,
  env === undefined,
  env != null,
);
console.log("done");
