// Installs one handler per method name with a computed-key write, the way
// router classes attach `get`, `post`, ... in their constructor. The
// compiler cannot tell which names such a write replaces.
const METHODS = ["get", "post"];

export class Registry {
  constructor() {
    METHODS.forEach((method) => {
      this[method] = (...args) => `${method}:${args.length}`;
    });
  }
}

export function describe(registry) {
  return `${registry.get(1, 2)} ${registry.post()}`;
}

export const titleIndex = {
  name: "title",
  key: (row) => row.title.toLowerCase(),
};
