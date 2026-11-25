// A member read through a constant holding the value's prototype object: the
// alias is the same prototype, so the class's instance member refuses there
// too (SC2020, host-global).
interface HostNavigator {
  hardwareConcurrency: number;
}
declare var Navigator: { new (): HostNavigator; readonly prototype: HostNavigator };
const proto = Navigator.prototype;
console.log(proto.hardwareConcurrency);
