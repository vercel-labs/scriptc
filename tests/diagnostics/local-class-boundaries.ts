function privateBrand() { return class { #value = 1; has(other: object): boolean { return #value in other; } }; }
class Base {}
function derived() { return class extends Base {}; }
function generic() { return class { read<T>(value: T): T { return value; } }; }
privateBrand();
derived();
generic();
// End of unsupported local-class forms.
