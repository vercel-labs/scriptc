// `value instanceof Target` for streams, an emitter and an AbortController held as `unknown`.
import {EventEmitter} from 'node:events';
import {PassThrough, Readable, Writable} from 'node:stream';

class Base {
  protected isBase(): boolean {
    return true;
  }
}
class Leaf extends Base {
  n: number = 2;
}
class GNode<Form = unknown> extends Base {
  form: Form | null = null;
}

const values: Array<[string, unknown]> = [
  ['readable', Readable.from(['a'])],
  ['writable', new Writable({write(_chunk: unknown, _encoding: string, done: () => void): void { done(); }})],
  ['pass through', new PassThrough()],
  ['emitter', new EventEmitter()],
  ['abort controller', new AbortController()],
  ['a Leaf', new Leaf()],
];

const targets: Array<[string, (v: unknown) => boolean]> = [
  ['Error', (v: unknown): boolean => v instanceof Error],
  ['Array', (v: unknown): boolean => v instanceof Array],
  ['Map', (v: unknown): boolean => v instanceof Map],
  ['Date', (v: unknown): boolean => v instanceof Date],
  ['Base', (v: unknown): boolean => v instanceof Base],
  ['Leaf', (v: unknown): boolean => v instanceof Leaf],
  ['GNode', (v: unknown): boolean => v instanceof GNode],
];

for (const [target, ask] of targets) {
  for (const [label, value] of values) {
    let line = target + ' <- ' + label + ': ';
    try {
      line += ask(value);
    } catch (x) {
      line += 'THROWS ' + (x instanceof Error ? x.message : 'a value');
    }
    console.log(line);
  }
}
