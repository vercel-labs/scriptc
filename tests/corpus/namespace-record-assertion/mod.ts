export let hits = 0;
const seen: string[] = [];

export function note(entry: string): number {
  seen.push(entry);
  hits++;
  return hits;
}

export function entries(): string {
  return seen.join(",");
}
