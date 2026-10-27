// util.promisify over dns.lookup and dns.lookupService: lookup's promise
// settles with { address, family }, or the address array with options.all,
// and lookupService's with { hostname, service }, after the call returns. A
// failed lookup rejects with the callback's error, and an argument error
// rejects the promise instead of throwing.
import * as dns from "node:dns";
import { lookup } from "node:dns";
import { promisify } from "node:util";

const lookupAsync = promisify(lookup);
const lookupServiceAsync = promisify(dns.lookupService);

async function rejects(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(label, "fulfilled");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "rejected", err.name, err.code, err.message);
  }
}

async function main(): Promise<void> {
  let returned = false;
  const pending = lookupAsync("127.0.0.1");
  returned = true;
  const one = await pending;
  console.log("literal", returned, one.address, one.family);
  const six = await lookupAsync("::1", 6);
  console.log("family", six.address, six.family);
  const all = await lookupAsync("::1", { all: true });
  console.log("all", all.length, all[0]!.address, all[0]!.family);
  const local = await lookupAsync("localhost", { family: 4 });
  console.log("localhost", local.address, local.family);
  const local4 = await lookupAsync("localhost", { family: 4, all: true });
  console.log("localhost all", JSON.stringify(local4));

  await rejects("missing host", async () => {
    await lookupAsync("no-such-host.invalid");
  });
  await rejects("bad family", async () => {
    await lookupAsync("localhost", 5);
  });
  await rejects("bad hostname", async () => {
    await lookupAsync(42 as unknown as string);
  });
  await rejects("bad address", async () => {
    await lookupServiceAsync("not-an-address", 22);
  });
  await rejects("bad port", async () => {
    await lookupServiceAsync("127.0.0.1", 70000);
  });
  const service = await lookupServiceAsync("127.0.0.1", 22);
  console.log("service", typeof service.hostname, typeof service.service);
}

main().catch((e) => console.log("unexpected", String(e)));
