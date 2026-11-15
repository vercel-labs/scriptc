// pi's env-api-keys.ts:8 shape: a module holding a computed dynamic import.
// Nothing loads it: the only clause that names it anywhere is read.ts's
// type-only import, which Node's type stripping erases.
export type DynamicImport = (specifier: string) => Promise<unknown>;

export type Loader = DynamicImport;

const dynamicImport: DynamicImport = (specifier) => import(specifier);

export const load = dynamicImport;
