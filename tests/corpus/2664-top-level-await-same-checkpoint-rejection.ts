// @exit: 1
// The executable module's fatal rejection wins over an unrelated rejection
// created in the same promise-job checkpoint. Node never delivers the
// unhandledRejection listener before terminating on the module error.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error) console.log("unexpected", reason.message);
});

void Promise.reject(new Error("same checkpoint"));
if (false) await Promise.resolve();
throw new Error("module failed");

export {};
