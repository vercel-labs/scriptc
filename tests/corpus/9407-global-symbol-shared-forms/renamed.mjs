const KEY = Symbol.for('corpus.9407.renamed');
const state = globalThis[KEY] ?? { notes: ['renamed'] };
export { state as shared };
