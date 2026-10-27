// `??` with a function fallback whose signature differs from the optional
// callback's (fewer parameters, narrower result).
interface Opts {
  tags?: (a: number, b: number) => Record<string, unknown>;
  label?: (n: number) => string;
}
function run(o: Opts, x: number, y: number): string {
  const tags = o.tags ?? (() => ({}));
  const label = o.label ?? ((n: number) => `#${n}`);
  return `${label(x)} ${JSON.stringify(tags(x, y))}`;
}
console.log(run({}, 1, 2));
console.log(run({ tags: (a, b) => ({ a, b }), label: (n) => `n${n}` }, 3, 4));
