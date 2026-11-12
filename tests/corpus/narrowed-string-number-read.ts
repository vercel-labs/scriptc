// A `string | number` binding read through a `typeof` guard is the arm the
// checker proved, not the declared union: `Number.parseInt` takes the
// string here, and the number arm returns the number itself.
interface Options {
  port?: string | number;
}

function ternaryPort(options: Options): number {
  const candidate = options.port ?? 3000;
  return typeof candidate === "number" ? candidate : Number.parseInt(candidate, 10);
}

function guardPort(options: Options): number {
  const candidate = options.port ?? 3000;
  if (typeof candidate === "number") return candidate;
  return Number.parseInt(candidate, 10);
}

function aliasPort(candidate: string | number): number {
  const copy = candidate;
  return typeof copy === "number" ? copy : Number.parseInt(copy, 10);
}

function annotatedPort(candidate: string | number): number {
  let copy: string | number = candidate;
  return typeof copy === "number" ? copy : Number.parseInt(copy, 10);
}

console.log(ternaryPort({}), guardPort({}));
console.log(ternaryPort({ port: 8080 }), guardPort({ port: "9090" }));
console.log(aliasPort(7000), aliasPort("12px"));
console.log(annotatedPort(4000), annotatedPort("77"));
