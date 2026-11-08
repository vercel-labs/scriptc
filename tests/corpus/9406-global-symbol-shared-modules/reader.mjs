const KEY = Symbol.for('corpus.9406.shared');
const shared = (globalThis[KEY] ??= { from: 'reader', seen: [] });
shared.seen.push('reader');
export function read() {
  return shared.from + ':' + shared.seen.join(',');
}
export function seen() {
  return shared === globalThis[KEY];
}
