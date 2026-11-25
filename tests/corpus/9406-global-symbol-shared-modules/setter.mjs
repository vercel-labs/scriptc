const KEY = Symbol.for('corpus.9406.shared');
globalThis[KEY] ??= { from: 'setter', seen: [] };
globalThis[KEY].seen.push('setter');
const mine = globalThis[KEY];
export function again() {
  return mine.from + mine.seen.length;
}
