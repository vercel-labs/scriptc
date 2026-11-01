// A method read off the value's prototype object: Node's class provides its
// instance methods there (FormData.prototype.append), which native code does
// not; the prototype carries the constructor link only (SC2020,
// host-global).
interface HostBody {
  append(value: string): void;
}
declare var FormData: { new (): HostBody; readonly prototype: HostBody };
FormData.prototype.append("value");
