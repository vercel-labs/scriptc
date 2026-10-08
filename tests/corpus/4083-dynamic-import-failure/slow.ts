console.log("evaluating slow");
await Promise.resolve();
throw new Error("slow module failed");
export const ready = true;
