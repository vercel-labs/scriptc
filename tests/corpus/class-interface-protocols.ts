// @transform-types
interface Shape { area(): number; side: number; resize(size:number): void; }
class Square implements Shape {
  side = 3;
  area(): number { return this.side * this.side; }
  resize(size: number): void { this.side = size; }
}
class Rectangle implements Shape {
  side = 2;
  width = 5;
  area(): number { return this.side * this.width; }
  resize(size: number): void { this.side = size; }
}
function read(shape: Shape): number { return shape.area(); }
function resize(shape:Shape): Shape { shape.resize(4); return shape; }
const square = new Square();
const rectangle = new Rectangle();
const shapes:Shape[] = [square, rectangle];
console.log(read(shapes[0]!),read(shapes[1]!));
console.log(resize(square) === square, square.side, read(square));
shapes[1]!.side = 7;
console.log(rectangle.side, read(rectangle));
console.log(shapes[0] instanceof Square,shapes[1] instanceof Rectangle);
const literal: Shape = { side: 2, area():number { return this.side * 10; }, resize(size:number):void { this.side = size; } };
console.log(read(literal), resize(literal) === literal, literal.side, read(literal));
interface Scaled extends Shape { scale(factor:number):number; }
class LargeSquare extends Square implements Scaled {
  scale(factor:number):number { this.side *= factor; return this.area(); }
}
function scaled(value:Scaled):number {
  if(value instanceof LargeSquare) return value.scale(2);
  return value.area();
}
console.log(scaled(new LargeSquare()));
interface Meter { stored:number; value:number; read():number; }
const meter:Meter = {
  stored: 1,
  get value():number { return this.stored; },
  set value(value:number) { this.stored = value; },
  read():number { const captured = ():number => this.value; return captured(); },
};
meter.value = 7;
console.log(meter.read(), meter.value);

type TaggedShape = Shape & { label: string };
const tagged:TaggedShape = { side:5, label:"tag", area():number { return this.side; }, resize(size:number):void { this.side=size; } };
console.log(read(tagged),resize(tagged)===tagged,tagged.label,tagged.side);

interface Position { x:number; y:number; }
class Point implements Position { x=1; y=2; }
interface NamedPosition extends Position { name:string; }
class NamedPoint implements NamedPosition { x=3; y=4; name="point"; }
function move(position:Position):Position { position.x+=10; return position; }
const point=new Point();
const positions:Position[]=[point,new NamedPoint(),{x:5,y:6}];
console.log(move(point)===point,point.x,positions.map(p=>p.x+p.y).join(","));
console.log(positions[0] instanceof Point,positions[1] instanceof NamedPoint);

interface Measure { area: () => number; }
function measured(value: Measure): number { return value.area(); }
console.log(measured(square), measured(rectangle), measured(literal));

class ProtocolStore {
  static value: Shape = new Square();
  stored: Shape;
  constructor(public current: Shape, public optional: Shape | undefined = undefined) {
    this.stored = current;
  }
  read(): number { return this.current.area() + this.stored.area(); }
}
const store = new ProtocolStore(square, rectangle);
store.current.resize(6);
console.log(store.read(), store.current === square, store.stored === square);
console.log(store.optional === rectangle, ProtocolStore.value.area());

interface Identity { id<T>(value: T): T; }
class IdentityValue implements Identity { id<T>(value: T): T { return value; } }
const identity: Identity = new IdentityValue();
console.log(identity.id(3), identity.id("text"));
interface LiveIdentity extends Identity { value(): number; }
class LiveValue implements LiveIdentity {
  value(): number { return 4; }
  id<T>(value: T): T { return value; }
}
const live: LiveIdentity = new LiveValue();
console.log(live.id(7), live.value(), live instanceof LiveValue);

interface LabeledShape extends Shape { label:string; }
class LabeledSquare extends Square { label="inherited"; }
function readLabeled(value:LabeledShape):number { value.resize(5); return value.area(); }
const labeled=new LabeledSquare();
console.log(readLabeled(labeled),labeled.side,labeled.label);
