// for await over untyped values in a JavaScript dependency, and yield* in
// async generators: a recursive async generator the checker types `any`,
// custom async iterators (return() on break and on a throw), synchronous
// iterables of promises, delegation with its completion value, and the
// not-iterable TypeError.
import { collect, protocols } from 'async-walk';

const tree = { root: ['a.func', 'nested'], 'root/nested': ['b.func', 'skip.txt', 'deep'], 'root/nested/deep': ['c.func'] };
console.log((await collect('root', tree)).join(' '));
for (const line of await protocols()) console.log(line);

async function* letters(): AsyncGenerator<string, number> {
  yield 'a';
  yield 'b';
  return 2;
}

async function* typed(): AsyncGenerator<string> {
  const count = yield* letters();
  yield `count ${count}`;
}

const seen: string[] = [];
for await (const value of typed()) seen.push(value);
console.log(seen.join(','));
