// `value as never` makes an unknown value fit any parameter: the argument
// is checked against the parameter's type like any unknown value the
// checker admits there, and a typed value passes unchanged.
type Out = { routes: { src: string; dest?: string }[]; count: number };

function show(tags: Record<string, unknown>): void {
  console.log(JSON.stringify(tags));
}

function report(tag: (result: Out) => Record<string, unknown>, value: unknown): void {
  show(tag(value as never));
}

const describe = (r: Out): Record<string, unknown> => ({ count: r.count, first: r.routes[0]?.src });
report(describe, JSON.parse('{"routes":[{"src":"/a"},{"src":"/b","dest":"/c"}],"count":2}'));

// Through a promise of unknown, the way a wrapper tags an async result.
function later(value: Out): Promise<unknown> {
  return Promise.resolve(value);
}
later({ routes: [], count: 7 }).then((value) => {
  show(describe(value as never));
});

// A typed value keeps its identity through the assertion.
function bump(target: Out): void {
  target.count++;
}
const typed: Out = { routes: [{ src: "/x" }], count: 1 };
bump(typed as never);
console.log(typed.count);
