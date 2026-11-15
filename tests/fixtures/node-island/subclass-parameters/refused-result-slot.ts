// A function literal whose result is an instance of a class that extends an
// island class, in an array beside one that returns a native Error. The
// island's declarations derive the island class from Error, so the checker
// gives the array the element type `() => Error`; an island object is not a
// native Error, and every call through that slot would throw a TypeError
// that a catch-all takes for the program's own error. Refused by name.
import { Packet } from "seed-kit";

class Blend extends Packet {
  parts: string[];
  constructor(parts: string[], note?: string) {
    super({ code: "BLEND", message: note || "A blend." });
    this.parts = parts;
  }
}

for (const brew of [() => new Blend(["x"]), () => new Error("plain")]) {
  try {
    throw brew();
  } catch (problem) {
    console.log(problem instanceof Blend ? "blend" : "other");
  }
}
