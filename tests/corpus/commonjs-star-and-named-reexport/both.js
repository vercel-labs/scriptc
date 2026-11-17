// The same binding arrives through a star and a named re-export. Node
// resolves both to lib.cjs's member; it is ambiguous only when the paths name
// different bindings.
export * from './star.js';
export * from './named.js';
