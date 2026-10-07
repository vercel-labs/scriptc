class Cell { value = 3; parent:Cell|undefined=undefined; }
function read(items:Cell[]):number {
  let sum=0;
  for(let i=0;i<items.length;i++){let cell=items[i]!;sum+=cell.value;}
  for(let i=0;i<items.length;i++){const cell=items[i]!;sum+=cell.value;}
  return sum;
}
function scalar(cell:Cell):number { return cell.value; }
function forward(items:Cell[]):number {
  let sum=0;
  for(let i=0;i<items.length;i++){let cell=items[i]!;sum+=scalar(cell);}
  return sum;
}
function iterate(items:Cell[]):number {
  let sum=0;
  for (let cell of items) sum += scalar(cell);
  for (const cell of items) { if(cell.value===7) continue; sum += cell.value; }
  return sum;
}
function mutateIteration(items:Cell[]):number {
  let sum=0;
  for (const cell of items) { items.length=0; sum += cell.value; }
  return sum;
}
function mutate(items:Cell[]):number {
  let sum=0;
  for(let i=0;i<items.length;i++){const cell=items[i]!;items.length=0;sum+=cell.value;}
  return sum;
}
function callbacks(items:Cell[],callback:()=>void):number {
  let sum=0;
  for(let i=0;i<items.length;i++){const cell=items[i]!;callback();sum+=cell.value;}
  return sum;
}
const parent=new Cell();
const child=new Cell();child.value=7;child.parent=parent;
const items=[parent,child];
console.log(read(items),forward(items));
console.log(iterate(items),mutateIteration(items.slice()));
console.log(mutate(items.slice()),read(items));
const mutable=items.slice();
console.log(callbacks(mutable,()=>{mutable.length=0;}),mutable.length);
const captured:(()=>number)[]=[];
for(let i=0;i<items.length;i++){let cell=items[i]!;captured.push(()=>cell.value);}
items.length=0;
console.log(captured[0]!(),captured[1]!());
function readProperties(items:Cell[],indices:number[]):number {
  let sum=0;
  for(const index of indices){const cell=items[index];if(cell)sum+=cell.value;}
  return sum;
}
const properties:Cell[]=[];
properties[0]=parent;
properties[2]=child;
properties[1048577]=child;
properties[-1]=parent;
properties[0.5]=child;
properties[NaN]=parent;
properties[Infinity]=child;
console.log(readProperties(properties,[0,-0,1,2,3,1048577,1048578,-1,0.5,NaN,Infinity]));
