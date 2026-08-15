import {
  splitImageRegions,
  SplitCancelledError,
} from "../lib/splitter";
import type { SplitWorkerRequest, SplitWorkerResponse } from "../lib/splitter-worker-protocol";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<SplitWorkerRequest>) => void) | null;
  postMessage: (message: SplitWorkerResponse, transfer?: Transferable[]) => void;
};

const cancelledJobs = new Set<number>();
let activeJobId: number | null = null;

async function runSplit(request: Extract<SplitWorkerRequest, { type: "split" }>) {
  activeJobId = request.jobId;
  try {
    const result = await splitImageRegions({
      width: request.width,
      height: request.height,
      lines: request.lines,
      shouldCancel: () => cancelledJobs.has(request.jobId),
      onProgress: (progress) => {
        workerScope.postMessage({ type: "progress", jobId: request.jobId, progress });
      },
    });
    workerScope.postMessage(
      {
        type: "complete",
        jobId: request.jobId,
        width: request.width,
        height: request.height,
        labels: result.labels.buffer,
        components: result.components,
      },
      [result.labels.buffer],
    );
  } catch (error) {
    if (error instanceof SplitCancelledError) {
      workerScope.postMessage({ type: "cancelled", jobId: request.jobId });
    } else {
      workerScope.postMessage({
        type: "error",
        jobId: request.jobId,
        message: error instanceof Error ? error.message : "分割失败，请调整线条后再试",
      });
    }
  } finally {
    cancelledJobs.delete(request.jobId);
    if (activeJobId === request.jobId) activeJobId = null;
  }
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "cancel") {
    if (activeJobId === request.jobId) cancelledJobs.add(request.jobId);
    return;
  }

  if (activeJobId !== null) cancelledJobs.add(activeJobId);
  void runSplit(request);
};
