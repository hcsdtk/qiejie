export type Point = { x: number; y: number };

export type SplitLine = {
  start: Point;
  end: Point;
};

export type SplitComponent = {
  label: number;
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type SplitProgressPhase = "rasterize" | "regions" | "restore";

export type SplitProgress = {
  phase: SplitProgressPhase;
  progress: number;
};

export type SplitResult = {
  labels: Int32Array;
  components: SplitComponent[];
};

export const MAX_SPLIT_REGIONS = 256;

export class SplitCancelledError extends Error {
  constructor() {
    super("分割已取消");
    this.name = "SplitCancelledError";
  }
}

type SplitOptions = {
  width: number;
  height: number;
  lines: SplitLine[];
  onProgress?: (progress: SplitProgress) => void;
  shouldCancel?: () => boolean;
};

function reportProgress(
  onProgress: SplitOptions["onProgress"],
  phase: SplitProgressPhase,
  progress: number,
) {
  onProgress?.({ phase, progress: Math.max(0, Math.min(1, progress)) });
}

function assertNotCancelled(shouldCancel?: SplitOptions["shouldCancel"]) {
  if (shouldCancel?.()) throw new SplitCancelledError();
}

function yieldToWorker() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function rasterizeLine(
  mask: Uint8Array,
  width: number,
  height: number,
  line: SplitLine,
  shouldCancel?: SplitOptions["shouldCancel"],
) {
  let x0 = Math.round(line.start.x);
  let y0 = Math.round(line.start.y);
  const x1 = Math.round(line.end.x);
  const y1 = Math.round(line.end.y);
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  const radius = Math.max(1, Math.round(Math.max(width, height) / 1_600));
  let step = 0;

  while (true) {
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        if (ox * ox + oy * oy > radius * radius + 1) continue;
        const x = x0 + ox;
        const y = y0 + oy;
        if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = 1;
      }
    }
    if (x0 === x1 && y0 === y1) break;
    const doubled = error * 2;
    if (doubled >= dy) {
      error += dy;
      x0 += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y0 += sy;
    }
    step += 1;
    if ((step & 8_191) === 0) {
      assertNotCancelled(shouldCancel);
      await yieldToWorker();
    }
  }
}

/**
 * Finds the connected image regions separated by the user-drawn lines.
 * This is intentionally browser-runtime agnostic so it can run in a Worker.
 */
export async function splitImageRegions({
  width,
  height,
  lines,
  onProgress,
  shouldCancel,
}: SplitOptions): Promise<SplitResult> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("图片尺寸无效");
  }

  const total = width * height;
  const barrier = new Uint8Array(total);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    assertNotCancelled(shouldCancel);
    await rasterizeLine(barrier, width, height, lines[lineIndex], shouldCancel);
    reportProgress(onProgress, "rasterize", (lineIndex + 1) / Math.max(1, lines.length));
    if ((lineIndex & 3) === 3) await yieldToWorker();
  }

  const labels = new Int32Array(total);
  labels.fill(-1);
  const queue = new Int32Array(total);
  const components: SplitComponent[] = [];
  let visitedCount = 0;
  let nextYieldAt = 16_384;

  for (let seed = 0; seed < total; seed += 1) {
    if (barrier[seed] || labels[seed] !== -1) continue;
    assertNotCancelled(shouldCancel);
    const label = components.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    labels[seed] = label;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index / width) | 0;
      count += 1;
      visitedCount += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const next = index - 1;
        if (!barrier[next] && labels[next] === -1) {
          labels[next] = label;
          queue[tail++] = next;
        }
      }
      if (x < width - 1) {
        const next = index + 1;
        if (!barrier[next] && labels[next] === -1) {
          labels[next] = label;
          queue[tail++] = next;
        }
      }
      if (y > 0) {
        const next = index - width;
        if (!barrier[next] && labels[next] === -1) {
          labels[next] = label;
          queue[tail++] = next;
        }
      }
      if (y < height - 1) {
        const next = index + width;
        if (!barrier[next] && labels[next] === -1) {
          labels[next] = label;
          queue[tail++] = next;
        }
      }

      if (visitedCount >= nextYieldAt) {
        assertNotCancelled(shouldCancel);
        reportProgress(onProgress, "regions", Math.min(0.98, visitedCount / Math.max(1, total)));
        nextYieldAt += 16_384;
        await yieldToWorker();
      }
    }

    components.push({ label, count, minX, minY, maxX, maxY });
    if (components.length > MAX_SPLIT_REGIONS) {
      throw new Error(`分割区域超过 ${MAX_SPLIT_REGIONS} 个，请减少线条后再试`);
    }
  }

  if (components.length < 2) {
    throw new Error("线条还没有把图片切开。请让线条连接两侧边缘，或与已有线条相交");
  }

  // Put the thin guide-line pixels back into their closest region, so exported pieces have no seams.
  let nextRestoreYieldAt = 16_384;
  for (let index = 0; index < total; index += 1) {
    if (!barrier[index]) continue;
    const x = index % width;
    const y = (index / width) | 0;
    let assigned = -1;
    for (let radius = 1; radius <= 8 && assigned < 0; radius += 1) {
      const points = [
        [x - radius, y],
        [x + radius, y],
        [x, y - radius],
        [x, y + radius],
      ];
      for (const [px, py] of points) {
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const candidate = labels[py * width + px];
          if (candidate >= 0) {
            assigned = candidate;
            break;
          }
        }
      }
    }
    labels[index] = assigned >= 0 ? assigned : 0;

    if (index >= nextRestoreYieldAt) {
      assertNotCancelled(shouldCancel);
      reportProgress(onProgress, "restore", 0.98 + (index / Math.max(1, total)) * 0.02);
      nextRestoreYieldAt += 16_384;
      await yieldToWorker();
    }
  }

  reportProgress(onProgress, "restore", 1);
  return { labels, components };
}
