// A JavaScript override may narrow the class a parameter accepts and return
// `this`: Node dispatches on the receiver and never checks the argument
// against the narrowed type, so a base-typed call may pass a base instance
// and the body reads whatever properties it has (undefined here).

class Texture {
  constructor(name) {
    this.name = name;
    this.wrap = 1;
  }
  /** @param {Texture} source */
  copy(source) {
    this.name = source.name;
    return this;
  }
}
class DataArrayTexture extends Texture {
  /** @param {DataArrayTexture} source */
  copy(source) {
    super.copy(source);
    this.depth = source.depth;
    return this;
  }
}
/** @param {Texture} view */
function viaBase(view) {
  return view.copy(new Texture("x"));
}
const a = new DataArrayTexture("a");
console.log("base-typed", viaBase(a).name, a.depth);
