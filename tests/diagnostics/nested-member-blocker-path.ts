// A record blocked by a member deep inside it names the member's path:
// through a function's result (`()`), the promise and union around it,
// record members (`.name`) and array elements (`[]`).
interface Job {
  id: string;
  handle: Promise<number> & { cancel(): void };
}
interface Order {
  id: string;
  jobs: Job[];
}
interface Provider {
  name: string;
  poll: () => Promise<Order | undefined>;
}
function makeProvider(): Provider {
  return { name: "p", poll: async () => undefined };
}
console.log(makeProvider().name);
