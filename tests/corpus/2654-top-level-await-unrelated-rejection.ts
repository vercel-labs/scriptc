// @exit: 1
console.log("before rejections");

process.on("unhandledRejection", (err) => {
  if (err instanceof Error) console.log("unhandled", err.message);
});

void Promise.reject(new Error("other"));
await new Promise<void>((_resolve, reject) => {
  setTimeout(() => reject(new Error("top")), 5);
});

export {};
