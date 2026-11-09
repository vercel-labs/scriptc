const prefix = ["named"];
export const counter = { count: 0 };
console.log("named module evaluates");

export const answer = prefix.length + 41;

export function describe(what: string): string {
  counter.count += 1;
  return `${prefix.join("")} ${what} ${counter.count}`;
}

export function pair<T>(first: T, second: T): T[] {
  return [first, second];
}

export function scale(n: number, by: number = prefix.length + 2): number {
  return n * by;
}
