/* node:cluster — the primary-probe slice. A compiled binary never runs
 * as a cluster worker (cluster forks the node binary itself — the
 * mechanism is na for compiled programs), so isPrimary lowers to `true`
 * and isWorker to `false`; everything else is undeclared. */
declare module "cluster" {
  const cluster: {
    readonly isPrimary: boolean;
    readonly isMaster: boolean;
    readonly isWorker: boolean;
  };
  export = cluster;
}

declare module "node:cluster" {
  import cluster = require("cluster");
  export = cluster;
}
