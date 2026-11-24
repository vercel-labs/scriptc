const cluster = require("cluster");
cluster.worker.send({
  isWorker: cluster.isWorker,
  isPrimary: cluster.isPrimary,
  id: cluster.worker.id,
  role: process.env.ROLE,
  uniqueId: process.env.NODE_UNIQUE_ID,
});
