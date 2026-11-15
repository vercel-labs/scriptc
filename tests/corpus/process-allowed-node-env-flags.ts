// process.allowedNodeEnvironmentFlags is one stable set of the option names
// the compatibility target accepts in NODE_OPTIONS: the read answers a Set,
// the same object on every read, and has() recognizes the names environment
// detection asks about (axios probes --use-env-proxy).
const flags = process.allowedNodeEnvironmentFlags;
console.log(flags instanceof Set);
console.log(flags === process.allowedNodeEnvironmentFlags);
console.log(flags.has("--use-env-proxy"));
console.log(flags.has("--max-old-space-size"));
console.log(flags.has("--experimental-fetch"));
console.log(flags.has("--conditions"));
console.log(flags.has("-r"));
console.log(flags.has("-C"));
console.log(flags.has("--not-a-node-flag"));

// Set iteration and spread walk the same names.
const listed = [...flags];
console.log(listed.includes("--use-env-proxy"));
console.log(listed.includes("--inspect"));
console.log(listed.includes("--not-a-node-flag"));
console.log(flags.has(listed[0]!));
let walked = false;
for (const name of flags) {
  if (name === "--use-env-proxy") walked = true;
}
console.log(walked);
