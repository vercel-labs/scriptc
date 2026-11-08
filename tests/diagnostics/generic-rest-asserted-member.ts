// A rest binding inside a generic function whose source is asserted to
// carry a member the pattern leaves in the rest: the rest would hold the
// binding's own fields AND the asserted member, which the binding's layout
// has no slot for. The copy is refused rather than dropping either.
interface Base {
  _meta?: unknown;
  name: string;
}

interface Wide extends Base {
  extra: number;
}

function listed<T extends Base>(item: T): string {
  const { _meta, ...rest } = item as T & { icons?: unknown };
  return JSON.stringify(rest);
}

const wide: Wide = { name: "w", extra: 1 };
console.log(listed(wide));
