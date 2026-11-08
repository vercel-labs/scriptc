const KEY = Symbol.for('corpus.9407.renamed');
const state = globalThis[KEY] ?? { marks: ['renamed'] };
export { state as shared };
