// A listener registry whose callbacks take a wider signature than the
// handlers callers pass in. Removal and lookup compare function identity.
export type Listener = (value: number, index: number) => void;

const listeners: Listener[] = [];

export function on(listener: Listener): void {
  listeners.push(listener);
}

export function off(listener: Listener): boolean {
  const at = listeners.indexOf(listener);
  if (at < 0) return false;
  listeners.splice(at, 1);
  return true;
}

export function has(listener: Listener): boolean {
  return listeners.includes(listener);
}

export function without(listener: Listener): number {
  return listeners.filter((entry) => entry !== listener).length;
}

export function emit(value: number): void {
  listeners.forEach((listener, index) => listener(value, index));
}

export function count(): number {
  return listeners.length;
}

export function widen(handler: (value: number) => void): Listener {
  return handler;
}
