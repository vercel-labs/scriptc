import type { Element } from "#jsx/jsx-runtime";

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

  const list = (
    <ul>
      {["ada", "lin"].map((name, index) => (
        <li key={name} id={name}>
          {`${index}:${name}`}
        </li>
      ))}
    </ul>
  );

  const elements = [button, destructured, focus, component, nested, spread, conditional, annotatedRow, slot, list];
  const markup = elements.map(render);
  return [...markup, ...log];
}
