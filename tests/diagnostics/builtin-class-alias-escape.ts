// A Map or Set alias owns no runtime value in a TypeScript file:
// construction, instanceof, typeof and .name compile, other uses report
// at the use. Aliases of EventEmitter, the stream classes and the error
// classes are class values.
const M = Map;
const boxed: unknown = M;
console.log(boxed !== undefined);
