// Calls that resolve to OVERLOAD signatures of a generic method or
// function: the implementation monomorphizes under what the overload
// proves for its type parameters (a parameter the overload never mentions
// is unknown), directly and through a `Pick` view of the class, whose
// live receiver keeps the instance's state. `T | Promise<T>` callbacks
// bind T from either arm.
interface Reply {
  code: number;
  text: string;
}
type Mapper<T> = (reply: Reply) => T | Promise<T>;

class Store {
  loads = 0;
  async load<T>(key: string, map: Mapper<T>): Promise<T>;
  async load(key: string): Promise<Reply>;
  async load<T>(key: string, map?: Mapper<T>): Promise<T | Reply> {
    this.loads++;
    const reply: Reply = { code: 200, text: key };
    if (map === undefined) return reply;
    return await map(reply);
  }
}

interface Services {
  store: Pick<Store, "load">;
}

function pick<T>(items: T[], index: number): T;
function pick<T>(items: T[]): T;
function pick<T>(items: T[], index = 0): T {
  return items[index]!;
}

async function settle<T>(reply: Reply, map?: Mapper<T>): Promise<T | Reply> {
  return map ? await map(reply) : reply;
}

async function main(): Promise<void> {
  const store = new Store();
  const plain = await store.load("alpha");
  console.log(plain.code, plain.text);
  const length = await store.load("beta", (reply) => reply.text.length);
  console.log(length * 2);
  const services: Services = { store };
  const viaView = await services.store.load("gamma");
  const upper = await services.store.load("delta", async (reply) => reply.text.toUpperCase());
  console.log(viaView.text, upper, store.loads);
  console.log(pick(["x", "y"]), pick([1, 2, 3], 2));
  console.log(JSON.stringify(await settle<Reply>({ code: 1, text: "s" })));
  console.log(await settle({ code: 2, text: "tt" }, (reply) => reply.code + reply.text.length));
}

main();
