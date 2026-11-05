// Optional reads through a snapshot of a global Node always defines: the
// browser-guard idiom `(globalThis as { process?: ... }).process?.env`,
// directly and through a const binding.
type Env = Record<string, string | undefined>;

function viaBinding(): Env | undefined {
  const proc = (globalThis as { process?: { env?: Env } }).process;
  return proc?.env;
}
function direct(): Env | undefined {
  return (globalThis as { process?: { env?: Env } }).process?.env;
}
function viaGlobal(): Env | undefined {
  return globalThis.process?.env;
}
function platform(): string {
  const proc = (globalThis as { process?: { platform?: string } }).process;
  return proc?.platform ?? "browser";
}

process.env.SNAPSHOT_PROBE = "yes";
console.log(viaBinding()?.SNAPSHOT_PROBE, direct()?.SNAPSHOT_PROBE, viaGlobal()?.SNAPSHOT_PROBE);
console.log(viaBinding()?.["SNAPSHOT_MISSING"] ?? "(unset)");
console.log(typeof viaBinding(), platform() === process.platform);
// Each call reads the current environment.
process.env.SNAPSHOT_PROBE = "changed";
console.log(viaBinding()?.SNAPSHOT_PROBE);
