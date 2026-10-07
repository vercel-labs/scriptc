function scan(source:string,start:number,end:number,substring:boolean):number {
  let slice = substring ? source.substring(start,end) : source.slice(start,end);
  let sum = slice.length;
  for (let i=0;i<slice.length;i++) sum += slice.charCodeAt(i);
  return sum;
}
function sliceOnly(source:string,start:number,end:number):number {
  const piece=source.slice(start,end);
  let result=piece.length;
  for(let i=0;i<piece.length;i++) result+=piece.charCodeAt(i);
  return result;
}
function substringOnly(source:string,start:number,end:number):number {
  let piece=source.substring(start,end);
  let result=piece.length;
  for(let i=0;i<piece.length;i++) result+=piece.charCodeAt(i);
  return result;
}
const source="Aé水xyz";
for(const start of [-Infinity,-8,-2,-0,0,1,2,3,5,7,10,Infinity,NaN]) {
  for(const end of [0,1,2,3,5,7,10,Infinity,NaN]) {
    console.log(sliceOnly(source,start,end),scan(source,start,end,false));
    console.log(substringOnly(source,start,end),scan(source,start,end,true));
  }
}
function snapshots():void {
  let source="old";
  const piece=source.substring(0,(source="new",3));
  source += "!";
  console.log(piece.length,piece.charCodeAt(0),source);
  const result=source.slice(1);
  console.log(result.length,result.charCodeAt(0),result.charCodeAt(-1),result.charCodeAt(Infinity));
}
function escaped(source:string):string {
  const piece=source.substring(1,4);
  console.log(piece.length,piece.charCodeAt(0));
  return piece;
}
function captures():void {
  let source="abcdef";
  const piece=source.substring(1,4);
  const read=():string=>piece;
  source="other";
  console.log(read(),source);
}
console.log(escaped("abcdef"));
snapshots();captures();

console.log(sliceOnly("a😀b",1,3),substringOnly("a😀b",1,3));
