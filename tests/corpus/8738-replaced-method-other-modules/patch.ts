// Writes through values of unknown type.
export function patchInstance(target: unknown, key: string): void {
  (target as Record<string, unknown>)[key] = () => 42;
}

export function restore(target: unknown, key: string): void {
  delete (target as Record<string, unknown>)[key];
}

export function patchPrototype(target: unknown, key: string): void {
  let prototype: unknown = Object.getPrototypeOf(target);
  // The topmost prototype below Object.prototype.
  for (;;) {
    const next: unknown = Object.getPrototypeOf(prototype);
    if (next === Object.prototype || next === null) break;
    prototype = next;
  }
  (prototype as Record<string, unknown>)[key] = () => 4200;
}
