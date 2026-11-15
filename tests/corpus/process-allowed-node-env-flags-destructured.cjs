// JavaScript destructures the process global's members as values: the
// binding is the same set the spelled read answers.
const { allowedNodeEnvironmentFlags: flags } = process;
console.log(flags.has("--use-env-proxy"));
console.log(flags === process.allowedNodeEnvironmentFlags);
console.log([...flags].includes("--experimental-fetch"));
