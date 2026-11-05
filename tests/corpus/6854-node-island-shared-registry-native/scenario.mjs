// Island code. Imports the shared module both as ESM (named + namespace) and via require().
import { createRequire } from 'node:module';
import * as ns from './registry.mjs';
import { counter, bump, Plugin, register, list, find, describeAll, noop } from './registry.mjs';
const require = createRequire(import.meta.url);

export function run(log) {
  log(`island list: ${list().join(',')}`);
  log(`island counter: named=${counter} ns=${ns.counter}`);
  bump();
  log(`after island bump: named=${counter} ns=${ns.counter}`);
  log(`require() sees same instance: ${require('./registry.mjs').list().join(',')}`);
  const p = new Plugin('island-b');
  register(p);
  log(`instanceof (island-constructed): ${p instanceof Plugin}`);
  log(`instanceof (owner-constructed): ${find('owner-a') instanceof Plugin}`);
  log(`find returns same object twice: ${find('owner-a') === find('owner-a')}`);
  register({ name: 'island-plain', describe() { return 'plain-from-island'; } });
  log(`describeAll from island: ${describeAll()}`);
  log(`Object.keys(owner object): ${Object.keys(find('owner-a') ?? {}).join(',')}`);
}

