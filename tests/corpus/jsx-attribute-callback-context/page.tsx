import type { Element } from "#jsx/jsx-runtime";

// A project's own type names shadow the standard library's; the generated
// constraints use names the file does not declare.
type Parameters<T> = [T];
type Partial<T> = { wrapped: T };
type NonNullable<T> = T;
type InstanceType<T> = T;
export type ShadowedUtilities = [
  Parameters<number>,
  Partial<string>,
  NonNullable<boolean>,
  InstanceType<object>,
];

export function render(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(render).join("");
  const element = value as Element;
  if (typeof element.type === "function") return render(element.type(element.props));
  const { children, ...rest } = element.props;
  const inner = render(children);
  if (element.type === "#fragment") return inner;
  let attributes = element.key === undefined ? "" : ` key="${String(element.key)}"`;
  for (const [name, item] of Object.entries(rest)) {
    if (typeof item === "function") continue;
    attributes += ` ${name}=${JSON.stringify(item)}`;
  }
  return `<${element.type}${attributes}>${inner}</${element.type}>`;
}

interface RowProps {
  label: string;
  onPick?: (item: { id: number; name: string }) => void;
  config?: { onOpen?: (depth: number) => void; tag?: string };
  children?: unknown;
}

function Row(props: RowProps): Element {
  props.onPick?.({ id: 1, name: props.label });
  props.config?.onOpen?.(2);
  return (
    <li id={props.label}>
      <span id={props.config?.tag}>{props.children}</span>
    </li>
  );
}

function Slot(props: { children: (index: number) => Element }): Element {
  return <div id="slot">{props.children(3)}</div>;
}

interface LeftEvent {
  left: number;
}
interface RightEvent {
  right: string;
}
type ChoiceProps =
  | { kind: "left"; onPick?: (event: LeftEvent) => void }
  | { kind: "right"; onPick?: (event: RightEvent) => void };

function Choice(props: ChoiceProps): Element {
  if (props.kind === "left") props.onPick?.({ left: 4 });
  else props.onPick?.({ right: "R" });
  return <span id={`choice-${props.kind}`} />;
}

interface First {
  one: number;
}
interface Second {
  two: string;
}

function Pair(props: { children: [(event: First) => void, (event: Second) => void] }): Element {
  props.children[0]({ one: 1 });
  props.children[1]({ two: "two" });
  return <div id="pair" />;
}

function Many(props: { children: ((event: First) => void)[] }): Element {
  for (const child of props.children) child({ one: 2 });
  return <div id="many" />;
}

export function drive(): string[] {
  const log: string[] = [];
  const useHandler = true;
  const annotated = (item: { id: number }) => log.push(`annotated:${item.id}`);

  const button = (
    <button
      id="intrinsic"
      onClick={(event) => {
        log.push(`intrinsic:${event.x}:${event.label}`);
      }}
    />
  );
  (button.props.onClick as (event: { x: number; label: string }) => void)({ x: 4, label: "L" });

  const destructured = <button id="destructured" onClick={({ x }) => log.push(`destructured:${x}`)} />;
  (destructured.props.onClick as (event: { x: number; label: string }) => void)({ x: 5, label: "D" });

  const focus = (
    <button
      id="this"
      onFocus={function (event) {
        log.push(`this:${this.tag}:${event.x}`);
      }}
    />
  );
  const onFocus = focus.props.onFocus as (this: { tag: string }, event: { x: number }) => void;
  onFocus.call({ tag: "T" }, { x: 7 });

  const component = <Row label="component" onPick={(item) => log.push(`component:${item.name}`)} />;
  const nested = (
    <Row
      label="nested"
      config={{ onOpen: (depth) => log.push(`nested:${depth}`), tag: "cfg" }}
    />
  );
  const spread = <Row label="spread" {...{ onPick: (item) => log.push(`spread:${item.id}`) }} />;
  const conditional = (
    <Row
      label="conditional"
      onPick={useHandler ? (item) => log.push(`conditional:${item.id}`) : undefined}
    />
  );
  const annotatedRow = <Row label="annotated" onPick={annotated} />;

  const slot = <Slot>{(index) => <span id={`slot-${index}`}>{index * 2}</span>}</Slot>;

  const left = <Choice kind="left" onPick={(event) => log.push(`left:${event.left}`)} />;
  const right = <Choice kind="right" onPick={(event) => log.push(`right:${event.right}`)} />;
  const pair = (
    <Pair>
      {(event) => log.push(`pair0:${event.one}`)}
      {(event) => log.push(`pair1:${event.two}`)}
    </Pair>
  );
  const many = (
    <Many>
      {(event) => log.push(`many0:${event.one}`)}
      {(event) => log.push(`many1:${event.one + 1}`)}
    </Many>
  );

  const list = (
    <ul>
      {["ada", "lin"].map((name, index) => (
        <li key={name} id={name}>
          {`${index}:${name}`}
        </li>
      ))}
    </ul>
  );

  const elements = [
    button,
    destructured,
    focus,
    component,
    nested,
    spread,
    conditional,
    annotatedRow,
    slot,
    list,
    left,
    right,
    pair,
    many,
  ];
  const markup = elements.map(render);
  return [...markup, ...log];
}
