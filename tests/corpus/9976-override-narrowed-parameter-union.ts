// An override that declares a narrower parameter than the method it overrides (TypeScript checks
// method parameters bivariantly): some arms of the inherited union, or one of them. Every call
// here passes a value the override declares: through the override's class, its base class, an
// interface, `super`, an untyped value and a stored method reference.
class Canvas {
  strokes: string[] = [];
  paint(color: number | boolean | string): string {
    this.strokes.push(`canvas:${typeof color}`);
    return `canvas ${String(color)}`;
  }
  mix(part: number | boolean | null): string {
    return `canvas ${String(part)}`;
  }
  stamp(mark: string | number[]): string {
    return `canvas ${typeof mark === "string" ? mark : mark.length}`;
  }
}
class Sketch extends Canvas {
  paint(color: string | number): string {
    this.strokes.push(`sketch:${typeof color}`);
    return typeof color === "string" ? `sketch ${color.toUpperCase()}` : `sketch #${color + 1}`;
  }
  mix(part: number | null): string {
    return part === null ? "sketch nothing" : `sketch ${part * 2}`;
  }
  stamp(mark: string): string {
    return `sketch ${mark.length}`;
  }
}
class Doodle extends Sketch {
  viaSuper(color: string | number): string {
    return `doodle ${super.paint(color)}`;
  }
  stamp(mark: string): string {
    return `doodle ${mark}`;
  }
}
interface Surface {
  paint(color: number | boolean | string): string;
}
const sketch = new Sketch();
const asCanvas: Canvas = sketch;
const asSurface: Surface = sketch;
const untyped: any = sketch;
console.log(sketch.paint("a"), sketch.paint(1), asCanvas.paint("b"), asCanvas.paint(2));
console.log(asSurface.paint("d"), new Doodle().viaSuper("f"), untyped.paint("g"));
const stored = sketch.paint;
console.log(stored.call(sketch, "i"));
const storedCanvas: (color: number | boolean | string) => string = asCanvas.paint.bind(asCanvas);
console.log(storedCanvas("j"), new Canvas().paint(true), sketch.strokes.join(","));
console.log(sketch.mix(3), sketch.mix(null), asCanvas.mix(4), asCanvas.mix(null), untyped.mix(5));
console.log(new Canvas().mix(false), new Canvas().stamp([1, 2]));
const doodle = new Doodle();
const doodleAsSketch: Sketch = doodle;
const doodleAsCanvas: Canvas = doodle;
console.log(doodle.stamp("abc"), doodleAsSketch.stamp("ab"), doodleAsCanvas.stamp("a"));
const all: Canvas[] = [new Canvas(), sketch, doodle];
console.log(all.map((each) => each.stamp("xy")).join(" | "));
