// A class method read as a value in a JavaScript program has the name it is
// declared under: from an instance, from the prototype, passed on, printed.
class Kettle {
  boil(litres, degrees) {
    return "boil " + litres + "/" + degrees;
  }
  pour() {
    return 0;
  }
  async steep() {
    return 1;
  }
  *drip() {
    yield 1;
  }
  static rinse(times) {
    return times;
  }
}
class Samovar extends Kettle {
  boil(litres, degrees) {
    return "samovar " + litres + degrees;
  }
}

function nameOf(f) {
  return f.name;
}

const samovar = new Samovar();
const held = samovar.boil;
console.log("instance:", typeof held, held.name, samovar.pour.name, samovar.steep.name, samovar.drip.name);
console.log("prototype:", Kettle.prototype.boil.name, Samovar.prototype.boil.name, Samovar.prototype.pour.name);
console.log("passed:", nameOf(samovar.boil), nameOf(Samovar.prototype.boil), nameOf(new Kettle().pour));
console.log("printed:", samovar.boil, samovar.pour);
console.log("static:", Kettle.rinse.name, Samovar.rinse.name);
console.log("length:", samovar.boil.length, Samovar.prototype.pour.length);
console.log("called:", held.call(samovar, 2, 90), samovar.boil(1, 80));
