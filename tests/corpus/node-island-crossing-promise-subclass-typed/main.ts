// @requires-libnode
// An island class that extends Promise (an SDK's request promise): the
// program awaits it as a promise and reads, writes and calls the members
// the class adds, through the types the package declares.
import { attempts, failing, isRequest, request } from "request-pkg";

interface Rec {
  n: number;
  tag: string;
}

async function main(): Promise<void> {
  const r = request<Rec>("/a", { n: 1, tag: "t" });
  const label: string = r.label;
  console.log(label, r.url, r.attempts);
  console.log(r.describe());
  console.log(r.retry() === r, r.attempts, attempts(r));
  r.attempts = 5;
  r.note = "from the program";
  console.log(r.attempts, attempts(r), r.note, r.describe(), isRequest(r));
  const whole = await r.withResponse();
  console.log(whole.status, whole.data.n, whole.data.tag);
  const rec = await r;
  console.log(rec.n, rec.tag);
  const f = failing("/b");
  console.log(f.label);
  try {
    await f;
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
  const g = failing("/c");
  console.log(await g.then(() => "resolved", (e: Error) => `handled ${e.message}`));
}

void main();
