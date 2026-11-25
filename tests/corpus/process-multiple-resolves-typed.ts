// @normalize-pid
// Typed promises and 'multipleResolves': each second settle reports the
// losing value with its dynamic shape — number, string, boolean, undefined
// for a void resolve — and an executor that throws after resolving reports
// the thrown Error as the rejection reason.
process.on("multipleResolves", (type, promise, value) => {
  const text = value instanceof Error ? `Error: ${value.message}` : String(value);
  console.log(type, text, typeof promise);
});
const settled: Array<Promise<unknown>> = [];
settled.push(
  new Promise<number>((resolve) => {
    resolve(1);
    resolve(2);
  }),
);
settled.push(
  new Promise<string>((resolve) => {
    resolve("kept");
    resolve("late");
  }),
);
settled.push(
  new Promise<boolean>((resolve) => {
    resolve(true);
    resolve(false);
  }),
);
settled.push(
  new Promise<void>((resolve) => {
    resolve();
    resolve();
  }),
);
settled.push(
  new Promise<number>((resolve) => {
    resolve(5);
    throw new Error("executor throw after resolve");
  }),
);
