import type { SplitComponent, SplitLine, SplitProgress } from "./splitter";

export type SplitWorkerRequest =
  | { type: "split"; jobId: number; width: number; height: number; lines: SplitLine[] }
  | { type: "cancel"; jobId: number };

export type SplitWorkerResponse =
  | { type: "progress"; jobId: number; progress: SplitProgress }
  | {
      type: "complete";
      jobId: number;
      width: number;
      height: number;
      labels: ArrayBuffer;
      components: SplitComponent[];
    }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

