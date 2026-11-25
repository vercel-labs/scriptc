// `Object.assign(record, dynamicSource)` converts each source value into the record's field type, and that conversion runs the value's own getters. A getter that deletes a source property the copy has not reached yet must not leave the copy reading a released entry: the copy holds its own reference to the value it stores, so the program runs and answers what Node answers.
interface Inner {
  a: number;
}
interface Options {
  first: Inner;
  second: Inner;
}
const source: any = {
  first: {
    get a(): number {
      delete source.second;
      return 1;
    },
  },
  second: { a: 2 },
};
const opts: Options = { first: { a: 0 }, second: { a: 0 } };
Object.assign(opts, source);
console.log(opts.first.a, opts.second.a);
