// Two modules reach one object through a registered symbol on the global
// object: whichever runs first creates it, and each keeps it in a binding
// its exported functions read.
import './setter.mjs';
import { read, seen } from './reader.mjs';
import { again } from './setter.mjs';

console.log(read(), seen(), again());
