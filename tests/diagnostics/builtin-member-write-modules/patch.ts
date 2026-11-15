// Replaces a member that use.ts calls through a typed array.
Array.prototype.reduce = function (this: unknown[]): unknown {
  return 0;
} as typeof Array.prototype.reduce;
export {};
