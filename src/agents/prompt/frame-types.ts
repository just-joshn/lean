export type TerminalSize = {
  readonly columns: number;
  readonly rows: number;
};

export type HeightFact =
  | { readonly kind: "unknown" }
  | { readonly kind: "known"; readonly minimumAvailable: number };

export type ColorDepth = "1" | "4" | "8" | "24";
