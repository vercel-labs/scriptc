// An override whose signature the inherited slot cannot carry (fewer parameters and a body that
// reads `arguments`) is refused without rejecting its class: instances of the subclass are
// constructed, their other members work, and the base method keeps working on base instances. The
// refused override is never called here. The override with a narrower parameter beside it compiles.
class Printer {
  sheets = 1;
  print(text: string, copies: number): string {
    return `printer ${text} x${copies} (${this.sheets})`;
  }
  pad(width: string | number): string {
    return `printer pad ${width}`;
  }
  feed(): number {
    return ++this.sheets;
  }
}
class Plotter extends Printer {
  print(): string {
    return `plotter ${arguments.length}`;
  }
  pad(width: string): string {
    return `plotter pad ${width.length}`;
  }
  twice(): number {
    return this.sheets * 2;
  }
}
class Engraver extends Plotter {
  twice(): number {
    return this.sheets * 20;
  }
}
const plotter = new Plotter();
console.log(plotter.feed(), plotter.twice(), plotter instanceof Printer, plotter.sheets);
const printer = new Printer();
console.log(printer.print("x", 2), printer.pad(3), printer.feed());
const plotters: Plotter[] = [plotter, new Engraver()];
console.log(plotters.map((each) => each.twice()).join(","), plotters[1] instanceof Plotter);
const printers: Printer[] = [printer, plotter, new Engraver()];
console.log(printers.map((each) => each.feed()).join(","));
