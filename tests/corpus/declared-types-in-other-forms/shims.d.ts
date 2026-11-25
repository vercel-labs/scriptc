// An ambient module: the project declares the types of a module by name.
declare module "ambient-shapes" {
  export interface Box {
    id: string;
    size: number;
    tags?: string[];
  }
  export type Boxes = { [id: string]: Box };
}
