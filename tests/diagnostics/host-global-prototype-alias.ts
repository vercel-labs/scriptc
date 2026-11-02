// A method read through a constant holding the value's prototype object: the
// alias is the same prototype, so the class's instance method refuses there
// too (SC2020, host-global), where Node's FormData.prototype carries append.
interface HostBody {
  append(value: string): void;
}
declare var FormData: { new (): HostBody; readonly prototype: HostBody };
const body = FormData.prototype;
body.append("value");
