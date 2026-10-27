// node:dns/promises and dns.promises: lookup and lookupService as promises
// over the same resolution as the callback forms. Literal addresses settle
// without a resolver; argument errors throw synchronously, as Node
// validates before it creates the promise; failures reject with the
// callback form's errors.
import { lookup } from "node:dns/promises";
import * as dns from "node:dns";

function attempt(label: string, f: () => unknown): void {
  try {
    f();
    console.log(label, "ok");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log(label, e.name, e.code, e.message);
  }
}

attempt("family 5", () => lookup("localhost", 5));
attempt("options.family", () => lookup("localhost", { family: 3 }));
attempt("hostname", () => lookup(42 as unknown as string));

(async () => {
  const one = await lookup("127.0.0.1");
  console.log("literal", one.address, one.family);
  const all = await dns.promises.lookup("::1", { all: true });
  console.log("literal all", JSON.stringify(all));
  const four = await lookup("localhost", 4);
  console.log("family 4", four.address, four.family);
  const v4 = await lookup("localhost", { family: 4, all: true });
  console.log("all", JSON.stringify(v4));
  try {
    await lookup("no-such-host.invalid");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log("missing", e.name, e.code, e.syscall, e.message);
  }
  console.log("order", dns.promises.getDefaultResultOrder());
})();
process.nextTick(() => console.log("tick before the first settlement"));
