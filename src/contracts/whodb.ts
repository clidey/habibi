/** Public, normalized WhoDB workspace data. Credentials never enter these envelopes. */
export interface WhoDbScopeItem {
  id: string;
  name: string;
  description?: string;
  role?: string;
}
export interface WhoDbSelection {
  org: string;
  project?: string;
}
export interface WhoDbDataset {
  title: string;
  project: string;
  columns: string[];
  rows: (string | number | boolean)[][];
  sql: string;
  provenance: string[];
  warnings: string[];
  partial: boolean;
  text: string;
}
export interface WhoDbAnswer {
  ok: true;
  readOnly: true;
  answer: string;
  datasets: WhoDbDataset[];
  trace: { tool: string; project: string }[];
  partial: boolean;
  budgetLimited?: boolean;
}
