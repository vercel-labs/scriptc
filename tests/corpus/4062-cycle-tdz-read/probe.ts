import { limit, used, record, reset } from "./limits.ts";

export function probe(): string {
  try {
    return `${used}/${limit}`;
  } catch (e) {
    const err = e as Error;
    return `${err.name}: ${err.message} (${e instanceof ReferenceError})`;
  }
}

export function spend(n: number): string {
  try {
    record(n);
    return "ok " + used;
  } catch (e) {
    return (e as Error).message;
  }
}

export function clear(): string {
  try {
    reset();
    return "cleared";
  } catch (e) {
    return (e as Error).name;
  }
}
