// @requires-libnode
// Static fields of a native class that extends an island class are properties
// of the JavaScript class object the island host builds, in declaration order,
// with a static field's own property attributes: clipanion declares its
// routing table as `static paths = [...]`.
import { Fixture } from "fixture-pkg";

class Room extends Fixture {
  static paths = [
    ["greet"],
    ["say", "hi"],
  ];
  static count = 0;
  static label: string | undefined;
  static readonly kind = "room";
  private level = 0;
  raise(steps: number): string {
    this.level += steps;
    return `${this.room}:${this.level}`;
  }
}

console.log(JSON.stringify(Room.paths), Room.count, Room.label, Room.kind);
console.log(Object.keys(Room).join(","));

Room.count += 1;
Room.label = Room.kind.toUpperCase();
console.log(Room.count, Room.label, JSON.stringify(Room.paths));

const desk = new Room("desk");
console.log(desk.describe(), desk.raise(2), desk.raise(3));
console.log(Object.keys(desk).join(","));
console.log(Room.paths === Room.paths, Room.paths[0] !== Room.paths[1]);
