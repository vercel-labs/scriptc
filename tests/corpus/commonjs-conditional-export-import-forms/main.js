import lib from './index.cjs';
import { mode } from './index.cjs';
import * as ns from './index.cjs';
import relayed from './relay.cjs';
import member from './member.cjs';
import { mode as reexportedMode } from './reexport.js';
import { now as starNow, clock as starClock } from './member-star.js';
import { now as namedNow, memberClock as namedClock } from './member-named.js';
import consume from './member-relay.cjs';

console.log(lib.mode, mode, ns.mode);
console.log(relayed.mode, reexportedMode);
console.log(member.clock, member.from(), member.now());
console.log(starNow(), starClock, namedNow(), namedClock);
console.log(consume.clock, consume.label);
