// A member NAME is not a binding: `options.servers()` reads the member
// `servers` of the parameter's inline object type, whose property signature
// lives in the enclosing frame. A generic function's capture scan must skip
// such names — resolving one finds the MEMBER's symbol, and the frame
// binding it would "capture" is a type node with no lowering.
interface Server {
  name: string;
  count: number;
}

function summarize(options: { prefix: string; servers: () => readonly Server[] }): string[] {
  const lines = <T extends { tag?: string }>(items: readonly T[]): string[] => {
    const servers = options.servers();
    return items.map((item) => `${options.prefix}/${item.tag ?? "none"}=${servers.length}`);
  };
  return lines([{ tag: "alpha" }, {}]);
}

console.log(summarize({ prefix: "mcp", servers: () => [{ name: "alpha", count: 2 }] }).join(","));

// A nested function reads the member too: the capture belongs to the outer
// frame's `options`, and the member name still is no binding.
function summarizeNested(options: { label: string; servers: () => readonly Server[] }): string {
  const count = (): number => options.servers().length;
  const render = <T extends { name?: string }>(item: T): string =>
    `${options.label}/${item.name ?? "-"}=${count()}`;
  return render({ name: "beta" });
}

console.log(summarizeNested({ label: "tools", servers: () => [{ name: "beta", count: 3 }] }));

// The same shapes as property keys, method declarations and record members:
// every one of these names is a member, never a frame value.
const record = { servers: 1, value: (n: number): number => n + 1 };
const handlers = {
  value<T>(n: T): T {
    return n;
  },
  servers: () => record.value(record.servers),
};
console.log(handlers.value("kept"), handlers.servers());
