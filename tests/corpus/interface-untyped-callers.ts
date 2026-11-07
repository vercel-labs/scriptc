// A typed callback reached through an untyped object and called with a value built without a type.
interface Sink { put(value: number): number }
class Sum implements Sink { total = 0; put(value: number): number { this.total += value; return this.total; } }
const feed = (sink: Sink): number => sink.put(2) + sink.put(3);
const holder: any = { feed };
const built: any = {};
built.put = (value: number) => value * 10;
console.log(holder.feed(new Sum()), holder.feed(built));
// A write through an untyped view of an instance.
class Pipe { sink: Sink = new Sum(); run(): number { return this.sink.put(2); } }
const pipe = new Pipe();
const loose: any = pipe;
loose.sink = built;
console.log(pipe.run());
