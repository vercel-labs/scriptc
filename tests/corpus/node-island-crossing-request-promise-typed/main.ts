// @requires-libnode
// A request promise from a typed island package (a Promise subclass with
// its own methods and a `then` that starts the request): typed code calls
// `asResponse()` and `withResponse()` on it, awaits it, and holds it as the
// class and as a value typed `any`.
import { create, failing, log, retries } from "api-pkg";

interface Message {
  id: number;
  text: string;
}

async function main(): Promise<void> {
  const request = create<Message>({ id: 1, text: "one" });
  console.log("held", request.pending, `[${log()}]`);
  const response = await request.asResponse();
  console.log("asResponse", response.status, response.body, `[${log()}]`);
  const both = await create<Message>({ id: 2, text: "two" }).withResponse();
  console.log("withResponse", both.data.id, both.data.text, both.response.status, `[${log()}]`);
  const message = await create<Message>({ id: 3, text: "three" });
  console.log("awaited", message.id, message.text, `[${log()}]`);
  const r = create<Message>({ id: 4, text: "four" });
  console.log("retry", r.retry() === r, r.retries, retries(r));
  // The same promise held without its type.
  const untyped: any = create<Message>({ id: 5, text: "five" });
  const viaAny = await untyped.asResponse();
  console.log("any", viaAny.status, typeof untyped.withResponse, (await untyped).text);
  try {
    await failing("request failed").asResponse();
  } catch (e) {
    console.log("rejected", (e as Error).message);
  }
  try {
    await failing("await failed");
  } catch (e) {
    console.log("await rejected", (e as Error).message);
  }
}

void main();
