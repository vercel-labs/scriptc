export function optional(value?: string): string {
  return `${arguments.length}:${String(value)}`;
}

export function defaulted(value: string = "x"): number {
  return arguments.length;
}

export class Counter {
  set(value: string = "x"): string {
    return `${arguments.length}:${value}`;
  }
}
