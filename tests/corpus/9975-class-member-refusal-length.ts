// A refused override keeps the slot of the method it overrides, and the
// function in that slot reports the length of the override's own
// declaration, as every method value does. These are the reads the build
// cannot refuse by name: through the prototype, an untyped value and an
// interface. (Calling the refused member throws; see the harness test.)
interface Playable {
  play(note: string, beats: number): string;
}
class Instrument implements Playable {
  play(note: string, beats: number): string {
    return `${note}/${beats}`;
  }
}
class Drum extends Instrument {
  // refused: fewer parameters than the slot, and the body reads `arguments`
  play(): string {
    return `hit ${arguments.length}`;
  }
}
// a refused method that overrides nothing keeps its own parameter count
class Shelf {
  count = 0;
  watch(ref: WeakRef<object>, extra: number): number {
    return ref.deref() === undefined ? extra : 1;
  }
}
const loose: any = new Drum();
const viewed: Playable = new Drum();
console.log(Drum.prototype.play.length, loose.play.length, viewed.play.length);
console.log(typeof Drum.prototype.play, typeof loose.play, typeof viewed.play);
const plain: any = new Instrument();
console.log(Instrument.prototype.play.length, plain.play.length, plain.play("a", 2));
const shelf: any = new Shelf();
console.log(shelf.count, Shelf.prototype.watch.length, shelf.watch.length, typeof shelf.watch);
