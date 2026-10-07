function invoke(fn:(n:number)=>number, n:number):number { return fn(n); }
function closed(fn:(n:number)=>number, n:number):number { return fn(n)+fn(n+1); }
const twice = (n:number):number => n*2;
function triple(n:number):number { return n*3; }
console.log(closed(twice,3),closed(twice,7));
console.log(invoke(twice,4),invoke(triple,4));
let mutable=twice;
console.log(invoke(mutable,5));
mutable=triple;
console.log(invoke(mutable,5));
function captured(offset:number):(n:number)=>number { return n=>n+offset; }
const first=captured(10), second=captured(20);
console.log(invoke(first,1),invoke(second,1));
function recursive(fn:(n:number)=>number,n:number):number { return n===0 ? fn(n) : recursive(fn,n-1)+fn(n); }
console.log(recursive(twice,4));
const escaped=closed;
console.log(escaped(triple,2));
function fail(n:number):number { if(n===2)throw new Error("stop"); return n; }
try { console.log(invoke(fail,2)); } catch(e) { console.log((e as Error).message); }
interface Reader { base:number; read(n:number):number; }
const receiver:Reader={base:8, read(n:number):number { return this.base+n; }};
console.log(receiver.read(3));
const order:string[]=[];
function select():(n:number)=>number { order.push("callee"); return twice; }
function argument():number { order.push("argument"); return 9; }
console.log(select()(argument()),order.join(","));
