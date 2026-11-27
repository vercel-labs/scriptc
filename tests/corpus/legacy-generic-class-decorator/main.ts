// @tsc-legacy-decorators
// A generic class decorator whose signature mirrors the standard
// library's ClassDecorator (<T>(target: T) => T | void): the class value
// goes through the checked-dynamic call, an undefined result keeps the
// class, and every direct path stays exact.
type LegacyClassDecorator = <T>(target: T) => T | void;
function Injectable(): LegacyClassDecorator {
  console.log("factory");
  return <T>(target: T): T | void => {
    console.log("apply", typeof target);
    return undefined;
  };
}
@Injectable()
class Svc {
  static kind = "svc";
}
console.log("name", Svc.name, Svc.kind);
const s = new Svc();
console.log("instance", s instanceof Svc);
