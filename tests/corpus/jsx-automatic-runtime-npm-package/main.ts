// @tsc-jsx
// JSX with the automatic runtime imports `react/jsx-runtime`, a package
// entry the file's own import list does not name: the build must compile it
// statically (no Node island) and type JSX from the package's declarations.
import { classic } from './classic.js';
import { page } from './page.js';

console.log(page());
console.log(classic());
