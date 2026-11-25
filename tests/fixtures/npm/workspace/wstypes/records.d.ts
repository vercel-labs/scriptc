// A workspace member that holds only the record types its siblings share.
export interface Entry {
  id: string;
  title: string;
  tags?: string[];
}
export interface Summary {
  count: number;
  titles: string;
}
