// performance.toJSON(): nodeTiming, timeOrigin and the event-loop
// utilization, in that key order, and how the whole answer serializes —
// stringify reaches the nested nodeTiming's own toJSON.
import { performance } from "node:perf_hooks";

const answer = performance.toJSON();
console.log("keys:", Object.keys(answer).join(","));
console.log("nodeTiming keys:", Object.keys(answer.nodeTiming).join(","));
console.log("origin:", answer.timeOrigin === performance.timeOrigin, answer.timeOrigin > 1e12);
console.log("elu:", Object.keys(answer.eventLoopUtilization).join(","));
console.log(
  "elu values:",
  typeof answer.eventLoopUtilization.idle,
  typeof answer.eventLoopUtilization.active,
  typeof answer.eventLoopUtilization.utilization,
);
console.log("nodeTiming fields:", answer.nodeTiming.name, answer.nodeTiming.entryType);
console.log("nodeTiming toJSON keys:", Object.keys(answer.nodeTiming.toJSON()).join(","));
console.log("stringify keys:", Object.keys(JSON.parse(JSON.stringify(answer))).join(","));
console.log(
  "stringify nested keys:",
  Object.keys(JSON.parse(JSON.stringify(answer)).nodeTiming).join(","),
);
console.log("stringify drops metrics:", JSON.stringify(answer).includes("uvMetricsInfo"));
console.log(
  "stringify elu keys:",
  Object.keys(JSON.parse(JSON.stringify(answer)).eventLoopUtilization).join(","),
);

// The same answer read as one checked-dynamic value: key order and the
// nested toJSON answer alike.
const dyn: any = performance.toJSON();
console.log("dyn keys:", Object.keys(dyn).join(","));
console.log("dyn nested keys:", Object.keys(dyn.nodeTiming).join(","));
console.log(
  "dyn nested json:",
  Object.keys(JSON.parse(JSON.stringify(dyn)).nodeTiming).join(","),
);
console.log("dyn origin:", dyn.timeOrigin > 1e12, typeof dyn.eventLoopUtilization.utilization);

// A key walk over the answer and a spread of it both see the three keys.
console.log("walk:", Object.entries(answer).length, Object.entries(answer).map(([k]) => k).join(","));
console.log("spread:", Object.keys({ ...answer }).join(","));
