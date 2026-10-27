/* What runs right after a build disposes its frontend. The native compiler
 * sets it to a full cycle collection (native/cli.ts): the frontend's syntax
 * trees and program state refer to each other, so disposing them leaves
 * cyclic garbage that reference counting cannot free. Under Node it is
 * unset. */
let afterDispose: (() => void) | null = null;

export function setFrontendDisposedHook(hook: () => void): void {
  afterDispose = hook;
}

export function frontendDisposed(): void {
  if (afterDispose !== null) afterDispose();
}
