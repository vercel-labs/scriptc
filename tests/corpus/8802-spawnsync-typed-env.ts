// SpawnSyncOptionsWithStringEncoding carries `env` as a real record member:
// a present member REPLACES the child's environment (undefined values drop,
// exactly as the inline literal's pairs do) and an absent one inherits ours.
// The two entry points differ only in that argument, so the member's runtime
// presence picks one at the call.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

const run = (options: SpawnSyncOptionsWithStringEncoding): string =>
  spawnSync("printenv", [], options).stdout;
const value = (out: string, name: string): string => {
  const line = out.split("\n").find((l) => l.startsWith(`${name}=`));
  return line === undefined ? "<absent>" : line.slice(name.length + 1);
};

const env: { [key: string]: string | undefined } = { PI_TEST: "1", PI_DROP: undefined };

// A present `env` replaces the child's environment: the variable rides
// through and the undefined member drops out.
const replaced: SpawnSyncOptionsWithStringEncoding = { encoding: "utf-8", env };
const replacedOut = run(replaced);
console.log(`kept:${value(replacedOut, "PI_TEST")}`);
console.log(`dropped:${value(replacedOut, "PI_DROP")}`);
console.log(`parent:${value(replacedOut, "PATH") === "<absent>"}`);

// An absent member inherits the parent's environment.
const inherited: SpawnSyncOptionsWithStringEncoding = { encoding: "utf-8" };
const inheritedOut = run(inherited);
console.log(`has-path:${value(inheritedOut, "PATH") !== "<absent>"}`);
console.log(`no-pi-test:${value(inheritedOut, "PI_TEST")}`);

// The record member composes with the other runtime members.
const quiet: SpawnSyncOptionsWithStringEncoding = {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
  env: { PI_TEST: "2" },
};
console.log(`quiet:${value(run(quiet), "PI_TEST")}`);
