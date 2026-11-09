declare const columnsBrand: unique symbol;
declare const rowsBrand: unique symbol;

export type TerminalColumns = number & { readonly [columnsBrand]: "columns" };
export type TerminalRows = number & { readonly [rowsBrand]: "rows" };

export type TerminalSize = {
  readonly columns: TerminalColumns;
  readonly rows: TerminalRows;
};

export type HeightFact =
  | { readonly kind: "unknown" }
  | { readonly kind: "known"; readonly minimumAvailable: number };

export type ColorDepth = "1" | "4" | "8" | "24";
