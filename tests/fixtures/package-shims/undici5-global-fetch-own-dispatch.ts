// The global fetch given an object that implements dispatch() itself and
// is no dispatcher of the undici package, through a record: the request is
// refused, by name, where the call runs, and the fetch rejects with the
// reason. (Under Node such an object receives the request; this fixture
// pins the refusal, not Node's output.)
import { Agent } from "undici";

interface Order {
  method?: string;
  dispatcher?: unknown;
}

async function main(): Promise<void> {
  const order: Order = { method: "GET" };
  order.dispatcher = {
    dispatch(): boolean {
      return true;
    },
  };
  try {
    await fetch("http://127.0.0.1:9/orders", order as RequestInit);
    console.log("sent");
  } catch (err) {
    console.log(`${(err as Error).name} | ${(err as Error).message}`);
  }
  await new Agent().close();
}

void main();
