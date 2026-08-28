console.log("async bad");
if (false) await Promise.resolve();
throw new Error("async dependency failed");

export {};
