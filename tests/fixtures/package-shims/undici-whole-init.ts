// The init a program holds for the global fetch, spread whole into the
// undici package's fetch and into a wrapper's init that names the
// package's dispatch(): both type-check and compile.
import { Agent, fetch, type Dispatcher } from "undici";

interface WrapperInit extends Omit<RequestInit, "dispatcher"> {
  dispatcher?: Pick<Dispatcher, "dispatch">;
}

function forWrapper(init: RequestInit): WrapperInit {
  return { ...init };
}

async function send(url: string, init: RequestInit): Promise<number> {
  const wrapped = forWrapper(init);
  const lines = new Agent();
  wrapped.dispatcher = lines;
  const answered = (await fetch(url, { ...init, dispatcher: lines })) as Response;
  await lines.close();
  return answered.status + (wrapped.method === undefined ? 0 : 1);
}

console.log(typeof send);
