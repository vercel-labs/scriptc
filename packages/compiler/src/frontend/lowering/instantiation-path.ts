/** Queued bodies preserve their demand ancestry. Independent concrete uses
 * do not consume a recursion budget; only fresh instances on one path do. */
export interface InstantiationPath {
  declaration: object;
  parent: InstantiationPath | null;
}

export const MAX_INSTANTIATION_RECURSION = 100;

export function extendInstantiationPath(
  parent: InstantiationPath | null,
  declaration: object,
): InstantiationPath | null {
  let repetitions = 0;
  for (let path = parent; path; path = path.parent) {
    if (path.declaration === declaration && ++repetitions >= MAX_INSTANTIATION_RECURSION)
      return null;
  }
  return { declaration, parent };
}
