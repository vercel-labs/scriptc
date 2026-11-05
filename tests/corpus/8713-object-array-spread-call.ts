// Spreading an `object[]` (`array<dyn>`) into `push`: the receiver's method
// value is checked-dynamic, so the call takes the runtime-arity lane — a
// fresh checked-dynamic argument array, exactly JS's own spread-call
// argument packing (holes and present undefined included).
function fromOptional(make?: () => readonly object[]): number {
  const arr: object[] = [];
  arr.push(...[{ a: 1 }]);
  const objs: object[] = [{ b: 2 }, { c: 3 }];
  arr.push(...objs);
  arr.push(...(make?.() ?? []));
  return arr.length;
}
console.log(fromOptional(() => [{ d: 4 }]));
console.log(fromOptional());

// The generic-list shape: a `T[]` spread whose element type is only known at
// the instantiation (a union of records), through `.filter` and `.map`.
interface Server {
  name: string;
}

function listed(server: string, item: { _meta?: unknown; uri?: string }): Record<string, unknown> {
  return { server, uri: item.uri ?? "" };
}

async function list<T extends { _meta?: unknown }>(
  servers: Server[],
  all: (server: Server) => Promise<T[]>,
  visible: (item: T) => boolean,
): Promise<Record<string, unknown>[]> {
  const results = await Promise.allSettled(servers.map((server) => all(server)));
  const items: Record<string, unknown>[] = [];
  results.forEach((result, index) => {
    const server = servers[index]!.name;
    if (result.status === "fulfilled") {
      items.push(...result.value.filter(visible).map((item) => listed(server, item)));
    }
  });
  return items;
}

list([{ name: "s" }], async () => [{ _meta: 1, uri: "u1" }, { uri: "u2" }], () => true).then((r) =>
  console.log(JSON.stringify(r)),
);
list([{ name: "t" }, { name: "u" }], async () => [{ _meta: null, uri: "u3" }], () => false).then((r) =>
  console.log(JSON.stringify(r)),
);
