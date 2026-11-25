const KEY = Symbol.for('corpus.9407.listed');
const state = globalThis[KEY] ?? { notes: ['listed'] };
export { state };
