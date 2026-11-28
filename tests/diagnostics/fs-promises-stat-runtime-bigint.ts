// fs.promises.stat with a bigint flag only the runtime knows would choose
// between Stats and BigIntStats at the call, and a union of both has no
// static member table to read: refused by name, with the literal forms that
// work.
import { stat } from "node:fs/promises";

async function main(): Promise<void> {
  const bigint = process.argv.length > 2;
  await stat("/tmp", { bigint });
}

main();
