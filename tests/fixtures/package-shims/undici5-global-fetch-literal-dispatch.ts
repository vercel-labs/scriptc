// The global fetch with an init that writes out a dispatcher which cannot
// be one of the undici package: an object in place. Refused when the
// program is built.
import { Agent } from "undici";

async function main(): Promise<void> {
  const answer = await fetch("http://127.0.0.1:9/orders", {
    dispatcher: {
      dispatch(): boolean {
        return true;
      },
    },
  } as RequestInit);
  console.log(answer.status);
  await new Agent().close();
}

void main();
