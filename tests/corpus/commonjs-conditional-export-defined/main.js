// @define: process.env.NODE_ENV="production"
// The same conditional export with NODE_ENV fixed at build time: the build
// folds the test to the production table and the development module never
// joins the program.
import lib from './index.cjs';
import { mode } from './index.cjs';

console.log(lib.mode, mode);
