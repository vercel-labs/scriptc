// @define: process.env.NODE_ENV="production"
// @define: process.env.SCRIPTC_FEATURE="on"
// A program whose async-iteration protocol slots hold an object literal
// implementing Symbol.asyncIterator, built with defined environment values:
// the program sees the defined values and takes only the branches they select.
async function sum(source: AsyncIterable<number>): Promise<number> {
  let total = 0;
  for await (const n of source) total += n;
  return total;
}

async function main(): Promise<void> {
  let step = 0;
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<number>> {
          step++;
          return step <= 3
            ? Promise.resolve({ value: step, done: false })
            : Promise.resolve({ value: undefined as any, done: true });
        },
      };
    },
  };
  console.log("sum", await sum(source));
  if (process.env.NODE_ENV === "production") console.log("mode production");
  else console.log("mode development");
  console.log("env", process.env.NODE_ENV, process.env.SCRIPTC_FEATURE);
}

void main();
