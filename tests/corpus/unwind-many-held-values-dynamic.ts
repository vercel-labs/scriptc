// One statement that holds many values when a step throws: dynamic values.
// Every step of one statement leaves a value alive until the statement ends, and
// any step can throw. A throw site that holds many values releases them through
// blocks it shares with the statement's other throw sites; a site that holds few
// releases them in place. Each run makes the throw come after a different number
// of steps, on both sides of that limit, and the program goes on afterwards: the
// values made before the throw are released once (the sanitized lane checks), and
// the handler, the finally block and the caller see what Node shows.
let budget = -1;
let strung = 0;
function bead(i: number): string {
  if (strung === budget) throw new RangeError("out of thread at bead " + i);
  strung++;
  return "b" + i.toString(36);
}
const STOPS = [-1, 0, 1, 2, 31, 32, 33, 34, 35, 39, 40];
function attempt(name: string, make: () => string | number): void {
  for (const stop of STOPS) {
    budget = stop;
    strung = 0;
    try {
      console.log(name, stop, "made", make(), strung);
    } catch (error) {
      console.log(name, stop, "threw", (error as Error).message, strung);
    }
  }
  budget = -1;
}

function pouch(): any {
  return {
    k0: bead(0), k1: bead(1), k2: bead(2), k3: bead(3), k4: bead(4), k5: bead(5), k6: bead(6), k7: bead(7),
    k8: bead(8), k9: bead(9), k10: bead(10), k11: bead(11), k12: bead(12), k13: bead(13), k14: bead(14), k15: bead(15),
    k16: bead(16), k17: bead(17), k18: bead(18), k19: bead(19), k20: bead(20), k21: bead(21), k22: bead(22), k23: bead(23),
    k24: bead(24), k25: bead(25), k26: bead(26), k27: bead(27), k28: bead(28), k29: bead(29), k30: bead(30), k31: bead(31),
    k32: bead(32), k33: bead(33), k34: bead(34), k35: bead(35), k36: bead(36), k37: bead(37), k38: bead(38), k39: bead(39),
  };
}
function row(): any {
  return [
    bead(0), bead(1), bead(2), bead(3), bead(4), bead(5), bead(6), bead(7),
    bead(8), bead(9), bead(10), bead(11), bead(12), bead(13), bead(14), bead(15),
    bead(16), bead(17), bead(18), bead(19), bead(20), bead(21), bead(22), bead(23),
    bead(24), bead(25), bead(26), bead(27), bead(28), bead(29), bead(30), bead(31),
    bead(32), bead(33), bead(34), bead(35), bead(36), bead(37), bead(38), bead(39),
  ];
}
// Members that cannot throw between ones that can.
function mixed(): any {
  return {
    m0: bead(0), m1: "plain1", m2: 2, m3: bead(3), m4: "plain4", m5: 5, m6: bead(6), m7: "plain7",
    m8: 8, m9: bead(9), m10: "plain10", m11: 11, m12: bead(12), m13: "plain13", m14: 14, m15: bead(15),
    m16: "plain16", m17: 17, m18: bead(18), m19: "plain19", m20: 20, m21: bead(21), m22: "plain22", m23: 23,
    m24: bead(24), m25: "plain25", m26: 26, m27: bead(27), m28: "plain28", m29: 29, m30: bead(30), m31: "plain31",
    m32: 32, m33: bead(33), m34: "plain34", m35: 35, m36: bead(36), m37: "plain37", m38: 38, m39: bead(39),
  };
}
let shelf: any = null;
// The literal is the function's last statement: the ordinary end of the
// statement and its throw sites reach the same return.
function stock(): void {
  shelf = {
    s0: bead(0), s1: bead(1), s2: bead(2), s3: bead(3), s4: bead(4), s5: bead(5), s6: bead(6), s7: bead(7),
    s8: bead(8), s9: bead(9), s10: bead(10), s11: bead(11), s12: bead(12), s13: bead(13), s14: bead(14), s15: bead(15),
    s16: bead(16), s17: bead(17), s18: bead(18), s19: bead(19), s20: bead(20), s21: bead(21), s22: bead(22), s23: bead(23),
    s24: bead(24), s25: bead(25), s26: bead(26), s27: bead(27), s28: bead(28), s29: bead(29), s30: bead(30), s31: bead(31),
    s32: bead(32), s33: bead(33), s34: bead(34), s35: bead(35), s36: bead(36), s37: bead(37), s38: bead(38), s39: bead(39),
  };
}
function guardedPouch(): any {
  let bag: any = null;
  try {
    bag = {
      g0: bead(0), g1: bead(1), g2: bead(2), g3: bead(3), g4: bead(4), g5: bead(5), g6: bead(6), g7: bead(7),
      g8: bead(8), g9: bead(9), g10: bead(10), g11: bead(11), g12: bead(12), g13: bead(13), g14: bead(14), g15: bead(15),
      g16: bead(16), g17: bead(17), g18: bead(18), g19: bead(19), g20: bead(20), g21: bead(21), g22: bead(22), g23: bead(23),
      g24: bead(24), g25: bead(25), g26: bead(26), g27: bead(27), g28: bead(28), g29: bead(29), g30: bead(30), g31: bead(31),
      g32: bead(32), g33: bead(33), g34: bead(34), g35: bead(35), g36: bead(36), g37: bead(37), g38: bead(38), g39: bead(39),
    };
  } catch (error) {
    bag = { caught: (error as Error).message };
  }
  return bag;
}
// A table of plain strings, as a module of constants declares one.
const names: any = {
  n0: "name0", n1: "name1", n2: "name2", n3: "name3", n4: "name4", n5: "name5", n6: "name6", n7: "name7",
  n8: "name8", n9: "name9", n10: "name10", n11: "name11", n12: "name12", n13: "name13", n14: "name14", n15: "name15",
  n16: "name16", n17: "name17", n18: "name18", n19: "name19", n20: "name20", n21: "name21", n22: "name22", n23: "name23",
  n24: "name24", n25: "name25", n26: "name26", n27: "name27", n28: "name28", n29: "name29", n30: "name30", n31: "name31",
  n32: "name32", n33: "name33", n34: "name34", n35: "name35", n36: "name36", n37: "name37", n38: "name38", n39: "name39",
  n40: "name40", n41: "name41", n42: "name42", n43: "name43", n44: "name44", n45: "name45", n46: "name46", n47: "name47",
  n48: "name48", n49: "name49", n50: "name50", n51: "name51", n52: "name52", n53: "name53", n54: "name54", n55: "name55",
  n56: "name56", n57: "name57", n58: "name58", n59: "name59", n60: "name60", n61: "name61", n62: "name62", n63: "name63",
  n64: "name64", n65: "name65", n66: "name66", n67: "name67", n68: "name68", n69: "name69", n70: "name70", n71: "name71",
  n72: "name72", n73: "name73", n74: "name74", n75: "name75", n76: "name76", n77: "name77", n78: "name78", n79: "name79",
};

attempt("pouch", () => Object.keys(pouch()).length);
attempt("row", () => row().length);
attempt("mixed", () => {
  const bag = mixed();
  return String(bag.m0) + bag.m1 + bag.m2 + Object.keys(bag).length;
});
attempt("stock", () => {
  shelf = null;
  stock();
  return Object.keys(shelf).length + ":" + shelf.s39;
});
attempt("guarded-pouch", () => {
  const bag = guardedPouch();
  return Object.keys(bag).length + ":" + String(bag.caught ?? bag.g39);
});
console.log(Object.keys(names).length, names.n0, names.n79);
