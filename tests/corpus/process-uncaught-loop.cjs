let count = 0;
const late = (error) => console.log("late", error.message);
const removed = (error) => console.log("snapshot", error.message);
const handler = (error, origin) => {
  console.log("handled", error.message, origin);
  process.off("uncaughtException", removed);
  if (count === 1) process.once("uncaughtException", late);
  process.nextTick(() => console.log("tick", count));
};
process.on("uncaughtException", handler);
process.on("uncaughtException", removed);
process.once("uncaughtExceptionMonitor", (error, origin) => console.log("monitor", error.message, origin));
const interval = setInterval(() => {
  count++;
  if (count < 3) throw new Error("interval " + count);
  clearInterval(interval);
  process.off("uncaughtException", handler);
  process.once("uncaughtException", (value, origin) => console.log("primitive", value, origin));
  setImmediate(() => { throw "immediate"; });
}, 10);
