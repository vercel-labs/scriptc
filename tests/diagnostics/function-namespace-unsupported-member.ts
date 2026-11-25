// A merged namespace may only export values the function's own-property
// table can hold; a class member is refused by name rather than silently
// kept in module-global storage the function object does not share.
function tool(): string {
  return "t";
}
namespace tool {
  export const version = 1;
  export class Runner {
    run(): number {
      return version;
    }
  }
}
console.log(tool(), tool.version, new tool.Runner().run());
