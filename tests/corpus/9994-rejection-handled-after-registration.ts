// A rejection reported as unhandled and handled a timer later by a reaction without a
// rejection handler: `finally` on the promise itself, `then` with one handler on an untyped
// receiver, and an answer that is the rejected promise. `rejectionHandled` fires after the
// registering call has returned, never inside it.
function text(e: unknown): string {
  return e instanceof Error ? e.name + ': ' + e.message : String(e);
}
async function fail(tag: string): Promise<unknown> {
  throw new Error(tag);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loose(v: unknown): any {
  return v;
}
function pause(): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}
process.on('unhandledRejection', (reason: unknown) => {
  console.log('unhandled: ' + text(reason));
});
process.on('rejectionHandled', () => {
  console.log('handled late');
});

async function main(): Promise<void> {
  const first = fail('finally');
  await pause();
  first
    .finally(() => {})
    .catch((e: unknown): number => {
      return text(e).length;
    });
  console.log('registered finally');
  await pause();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let second: any = loose(fail('then'));
  await pause();
  second = second.then((v: number): number => v);
  console.log('registered then');
  second = second.catch((e: unknown): number => text(e).length);
  await pause();
  console.log(typeof (await second));

  const third = fail('answer');
  await pause();
  const derived = Promise.resolve(1).then((): unknown => third);
  console.log('registered answer');
  await derived.catch((e: unknown): number => text(e).length);
  await pause();
  console.log('done');
}
main();
