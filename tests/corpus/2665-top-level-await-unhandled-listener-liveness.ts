// @exit: 13
// Node delivers unhandledRejection at the checkpoint boundary, before
// deciding that the still-pending module has no ref'd work. Work scheduled
// by the listener therefore gets its own turn before the final status 13.
process.on("unhandledRejection", () => {
  console.log("unhandled");
  setTimeout(() => console.log("listener timer"), 0);
});

void Promise.reject(new Error("handled by listener"));
await new Promise<void>(() => {});

export {};
