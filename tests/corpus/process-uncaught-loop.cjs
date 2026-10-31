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
  let observed;
  process.once("uncaughtExceptionMonitor", (value, origin) => {
    observed = value;
    console.log("primitive-monitor", value === "immediate", value instanceof Error, origin);
  });
  process.once("uncaughtException", (value, origin) => {
    console.log("primitive", value, origin);
    console.log("primitive-identity", value === observed, value === "immediate", value instanceof Error);
    process.once("uncaughtExceptionMonitor", (error) => {
      observed = error;
      console.log("error-monitor", error instanceof Error);
    });
    process.once("uncaughtException", (error, origin) => {
      console.log("error-identity", error === observed);
      console.log("error-guard", error instanceof Error);
      if (error instanceof Error) console.log("error-message", error.message, origin);
    });
    setImmediate(() => { throw new Error("guarded"); });
  });
  setImmediate(() => { throw "immediate"; });
}, 10);
