// Promise.race over plain entries: JavaScript resolves each entry through
// PromiseResolve, so a settled entry wins over a pending one and, among
// settled entries, the argument order decides.

const pending = new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 25));

async function main(): Promise<void> {
  console.log(await Promise.race([42, pending]));
  console.log(await Promise.race([pending, "fast"]));
  console.log(JSON.stringify(await Promise.race([{ tag: "object" }, pending])));
  console.log(await Promise.race(["first", "second"]));
  try {
    await Promise.race([Promise.reject(new Error("boom")), "value"]);
    console.log("no rejection");
  } catch (error) {
    console.log("rejected:", (error as Error).message);
  }
  const kept = await Promise.race(["value", Promise.reject(new Error("ignored"))]).catch(
    () => "caught",
  );
  console.log(kept);
}

main();
