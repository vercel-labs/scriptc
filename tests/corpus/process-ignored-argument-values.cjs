// A process method ignores the arguments past the ones it uses, but the
// ignored values still evaluate in source order. null and undefined lower to
// nothing at all, and a call among them still runs before the method.
let effects = 0;
const touch = () => {
  effects += 1;
  return effects;
};
console.log("uptime", typeof process.uptime(null, undefined));
console.log("uptime call", typeof process.uptime(touch(), null), "effects", effects);
console.log("memory", typeof process.availableMemory(undefined, null));
console.log("constrained", typeof process.constrainedMemory(null, undefined));
console.log("cwd", typeof process.cwd(undefined, null));
console.log("resources", Array.isArray(process.getActiveResourcesInfo(null)));
console.log("umask", typeof process.umask(0o077, null), typeof process.umask(undefined, undefined));
console.log("effects", effects);
