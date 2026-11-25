// The named re-export first: an explicit export wins over the star's.
export { now } from './lib.cjs';
export * from './star.js';
