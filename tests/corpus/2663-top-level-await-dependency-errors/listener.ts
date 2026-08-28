process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error) console.log("unexpected unhandled", reason.message);
});

console.log("listener armed");
