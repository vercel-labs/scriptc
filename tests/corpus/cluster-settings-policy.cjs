// node:cluster's settings and scheduling policy: the empty settings object
// before setupPrimary, the merge the call performs, the 'setup' event it
// emits on the next tick, and the module's scheduling constants.
const cluster = require("cluster");

console.log("before", JSON.stringify(cluster.settings));
console.log("policy", cluster.schedulingPolicy, cluster.SCHED_NONE, cluster.SCHED_RR);
cluster.on("setup", (settings) => {
  console.log("setup", Array.isArray(settings.args), settings.args.length, settings.silent);
});
cluster.setupPrimary({ silent: true, args: ["one", "two"] });
console.log("after", JSON.stringify(cluster.settings.args), cluster.settings.silent);
console.log("is", cluster.isPrimary, cluster.isWorker, cluster.isMaster);
console.log("workers", JSON.stringify(cluster.workers), JSON.stringify(cluster.worker));
