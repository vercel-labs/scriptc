// The JavaScript implementation: registers the hook under a registry symbol
// on a holder object, which a compiled program does not need.
const holder: Record<symbol, unknown> = {};

export const register = (hook: () => string): string => {
  Object.defineProperty(holder, Symbol.for("dispose"), { value: hook, configurable: true });
  return "registered";
};
