// A class field whose union type reaches itself through its array arm and
// an index signature, and admits a bare undefined: the class compiles, and
// JSON.stringify of the field is refused by name, since Node's answer for
// undefined is not a string.
type Sheet = string | number | boolean | null | undefined | Sheet[] | { [name: string]: Sheet };

class Notebook {
  latest: Sheet = undefined;
  add(page: Sheet): void {
    this.latest = page;
  }
}

const notebook = new Notebook();
notebook.add({ k: [1, undefined] });
console.log(JSON.stringify(notebook.latest));
