// `const [a, b] = pair ?? []` reads the tuple's positions when each binding
// is reached, or undefined from the empty array
// (tests/corpus/destructure-default-writes-later-position.ts). Declarations
// take that lowering. These neighbours keep a refusal: the same source in an
// assignment pattern, a parameter's default and a `for...of` head, and an
// object pattern in a position, which would destructure undefined.
const shelves: Record<string, [string, number]> = { top: ["jars", 4] };

// An assignment to names declared before.
function assigned(shelf: string): string {
  let label: string | undefined;
  let count: number | undefined;
  [label, count] = shelves[shelf] ?? [];
  return `${label} ${count}`;
}

// A parameter pattern whose default is the fallback.
function defaulted(shelf: string, [label, count] = shelves[shelf] ?? []): string {
  return `${label} ${count}`;
}

// A `for...of` head over one such source.
function looped(shelf: string, stocked: boolean): string {
  let line = "";
  for (const [label, count] of [stocked ? shelves[shelf] : []]) line += `${label} ${count}`;
  return line;
}

// An object pattern in a position.
const bins: Record<string, [{ tag: string }, number]> = { top: [{ tag: "nails" }, 9] };
function tagged(bin: string): string {
  const [{ tag } = { tag: "none" }, count] = bins[bin] ?? [];
  return `${tag} ${count}`;
}

console.log(assigned("top"), defaulted("top"), looped("top", true), tagged("top"));
