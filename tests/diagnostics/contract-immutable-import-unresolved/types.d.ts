// What tsconfig.json resolves @scriptc/types to in this project. It is not
// the package's declaration, so the marker this file exports is not the
// contract the annotation names.
export type Immutable<T> = T;
