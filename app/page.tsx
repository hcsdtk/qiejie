"use client";

import {
  ChangeEvent,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { zip } from "fflate";

type Point = { x: number; y: number };
type CutLine = { id: number; start: Point; end: Point };
type ImageInfo = {
  name: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  scale: number;
};
type Piece = {
  id: number;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  ratio: number;
};
type DirectoryHandleLike = {
  getFileHandle: (
    name: string,
    options: { create: boolean },
  ) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

const MAX_PIXELS = 8_000_000;
const MAX_EDGE = 3_200;
const PIECE_COLORS = ["#ff5a36", "#4773ff", "#16a778", "#8e5cff", "#e4a11b"];

function formatDimensions(width: number, height: number) {
  return `${width.toLocaleString()} × ${height.toLocaleString()}`;
}

function getCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width - 1, ((clientX - rect.left) / rect.width) * canvas.width)),
    y: Math.max(0, Math.min(canvas.height - 1, ((clientY - rect.top) / rect.height) * canvas.height)),
  };
}

function nearestPointOnLine(point: Point, line: CutLine): Point {
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return line.start;
  const t = Math.max(
    0,
    Math.min(1, ((point.x - line.start.x) * dx + (point.y - line.start.y) * dy) / lengthSquared),
  );
  return { x: line.start.x + t * dx, y: line.start.y + t * dy };
}

function snapPoint(point: Point, width: number, height: number, lines: CutLine[]): Point {
  const threshold = Math.max(10, Math.min(width, height) * 0.035);
  const candidates: Point[] = [
    { x: 0, y: point.y },
    { x: width - 1, y: point.y },
    { x: point.x, y: 0 },
    { x: point.x, y: height - 1 },
    ...lines.map((line) => nearestPointOnLine(point, line)),
  ];

  let nearest = point;
  let bestDistance = threshold;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance < bestDistance) {
      nearest = candidate;
      bestDistance = distance;
    }
  }
  return nearest;
}

function assistLineEnd(start: Point, point: Point, width: number, height: number, lines: CutLine[]) {
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return point;

  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const assistedAngle = Math.round(angle / step) * step;
  const delta = Math.abs(Math.atan2(Math.sin(angle - assistedAngle), Math.cos(angle - assistedAngle)));
  const straightened =
    delta <= (9 * Math.PI) / 180
      ? {
          x: start.x + Math.cos(assistedAngle) * distance,
          y: start.y + Math.sin(assistedAngle) * distance,
        }
      : point;

  return snapPoint(straightened, width, height, lines);
}

function drawLineOverlay(
  context: CanvasRenderingContext2D,
  line: Pick<CutLine, "start" | "end">,
  active = false,
) {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = active ? "#171717" : "#ff5a36";
  context.lineWidth = Math.max(3, context.canvas.width / 650);
  context.shadowColor = "rgba(255,255,255,.9)";
  context.shadowBlur = Math.max(3, context.canvas.width / 600);
  if (active) context.setLineDash([14, 10]);
  context.beginPath();
  context.moveTo(line.start.x, line.start.y);
  context.lineTo(line.end.x, line.end.y);
  context.stroke();
  context.setLineDash([]);

  for (const point of [line.start, line.end]) {
    context.beginPath();
    context.fillStyle = active ? "#171717" : "#ffffff";
    context.strokeStyle = active ? "#ffffff" : "#ff5a36";
    context.lineWidth = Math.max(2, context.canvas.width / 1000);
    context.arc(point.x, point.y, Math.max(5, context.canvas.width / 330), 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
}

function rasterizeLine(mask: Uint8Array, width: number, height: number, line: CutLine) {
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
  }
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG 生成失败"))), "image/png");
  });
}

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export default function Home() {
  const editorCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lineIdRef = useRef(1);
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [lines, setLines] = useState<CutLine[]>([]);
  const [activeLine, setActiveLine] = useState<Omit<CutLine, "id"> | null>(null);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processLabel, setProcessLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const clearPieces = useCallback(() => {
    setPieces((current) => {
      current.forEach((piece) => URL.revokeObjectURL(piece.url));
      return [];
    });
  }, []);

  const loadImageFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setMessage("请选择 JPG、PNG、WebP 等常见图片格式");
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const areaScale = Math.sqrt(MAX_PIXELS / (image.naturalWidth * image.naturalHeight));
        const edgeScale = MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight);
        const scale = Math.min(1, areaScale, edgeScale);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const baseCanvas = document.createElement("canvas");
        baseCanvas.width = width;
        baseCanvas.height = height;
        const context = baseCanvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, width, height);
        baseCanvasRef.current = baseCanvas;
        setImageInfo({
          name: file.name.replace(/\.[^.]+$/, "") || "image",
          originalWidth: image.naturalWidth,
          originalHeight: image.naturalHeight,
          width,
          height,
          scale,
        });
        setLines([]);
        lineIdRef.current = 1;
        clearPieces();
        setMessage(
          scale < 1 ? `大图已优化至 ${formatDimensions(width, height)}，操作会更流畅` : null,
        );
        URL.revokeObjectURL(objectUrl);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setMessage("这张图片暂时无法读取，请换一个常见格式试试");
      };
      image.src = objectUrl;
    },
    [clearPieces],
  );

  useEffect(() => {
    return () => pieces.forEach((piece) => URL.revokeObjectURL(piece.url));
  }, [pieces]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) =>
        item.type.startsWith("image/"),
      );
      const file = imageItem?.getAsFile();
      if (file) loadImageFile(file);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        clearPieces();
        setLines((current) => current.slice(0, -1));
      }
    };
    window.addEventListener("paste", handlePaste);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("paste", handlePaste);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [clearPieces, loadImageFile]);

  useEffect(() => {
    const canvas = editorCanvasRef.current;
    const baseCanvas = baseCanvasRef.current;
    if (!canvas || !baseCanvas || !imageInfo) return;
    canvas.width = imageInfo.width;
    canvas.height = imageInfo.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(baseCanvas, 0, 0);
    lines.forEach((line) => drawLineOverlay(context, line));
    if (activeLine) drawLineOverlay(context, activeLine, true);
  }, [activeLine, imageInfo, lines]);

  const loadSample = useCallback(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1500;
    canvas.height = 960;
    const context = canvas.getContext("2d");
    if (!context) return;
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#f7d9c8");
    gradient.addColorStop(0.52, "#f1eee6");
    gradient.addColorStop(1, "#c8ddf7");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ff5a36";
    context.fillRect(85, 82, 510, 365);
    context.fillStyle = "#171717";
    context.fillRect(770, 168, 610, 250);
    context.fillStyle = "#4773ff";
    context.beginPath();
    context.arc(470, 720, 215, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "700 82px Arial, sans-serif";
    context.fillText("FRAME 01", 132, 235);
    context.font = "500 28px Arial, sans-serif";
    context.fillText("DRAW · SPLIT · EXPORT", 132, 310);
    context.fillStyle = "#f1eee6";
    context.font = "700 72px Arial, sans-serif";
    context.fillText("CUT HERE", 850, 315);
    context.fillStyle = "#171717";
    context.font = "600 34px Arial, sans-serif";
    context.fillText("用分割线试试，把画面切成 4 块", 750, 760);
    const blob = await canvasToBlob(canvas);
    loadImageFile(new File([blob], "sample-board.png", { type: "image/png" }));
  }, [loadImageFile]);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) loadImageFile(file);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) loadImageFile(file);
  };

  const startLine = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imageInfo || isProcessing) return;
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    const point = snapPoint(getCanvasPoint(canvas, event.clientX, event.clientY), imageInfo.width, imageInfo.height, lines);
    setActiveLine({ start: point, end: point });
    setMessage(null);
  };

  const moveLine = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!activeLine || !imageInfo) return;
    const point = assistLineEnd(
      activeLine.start,
      getCanvasPoint(event.currentTarget, event.clientX, event.clientY),
      imageInfo.width,
      imageInfo.height,
      lines,
    );
    setActiveLine((current) => (current ? { ...current, end: point } : null));
  };

  const finishLine = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!activeLine || !imageInfo) return;
    const end = assistLineEnd(
      activeLine.start,
      getCanvasPoint(event.currentTarget, event.clientX, event.clientY),
      imageInfo.width,
      imageInfo.height,
      lines,
    );
    if (Math.hypot(end.x - activeLine.start.x, end.y - activeLine.start.y) > 12) {
      const line: CutLine = { id: lineIdRef.current++, start: activeLine.start, end };
      setLines((current) => [...current, line]);
      clearPieces();
    }
    setActiveLine(null);
  };

  const undoLine = () => {
    clearPieces();
    setLines((current) => current.slice(0, -1));
  };

  const splitImage = async () => {
    const baseCanvas = baseCanvasRef.current;
    if (!baseCanvas || !imageInfo || !lines.length || isProcessing) return;
    setIsProcessing(true);
    setMessage(null);
    clearPieces();
    setProcessLabel("正在识别分割区域…");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    try {
      const { width, height } = imageInfo;
      const total = width * height;
      const barrier = new Uint8Array(total);
      lines.forEach((line) => rasterizeLine(barrier, width, height, line));

      const labels = new Int32Array(total);
      labels.fill(-1);
      const queue = new Int32Array(total);
      const components: Array<{
        label: number;
        count: number;
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
      }> = [];

      for (let seed = 0; seed < total; seed += 1) {
        if (barrier[seed] || labels[seed] !== -1) continue;
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
        }
        components.push({ label, count, minX, minY, maxX, maxY });
        if (components.length > 80) throw new Error("分割区域超过 80 个，请减少线条后再试");
      }

      if (components.length < 2) {
        throw new Error("线条还没有把图片切开。请让线条连接两侧边缘，或与已有线条相交");
      }

      // Put the thin guide-line pixels back into their closest region, so exported pieces have no seams.
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
      }

      const sourceContext = baseCanvas.getContext("2d", { willReadFrequently: true });
      if (!sourceContext) throw new Error("无法读取图片像素");
      const source = sourceContext.getImageData(0, 0, width, height).data;
      const sorted = [...components].sort((a, b) => a.minY - b.minY || a.minX - b.minX);
      const created: Piece[] = [];

      for (let pieceIndex = 0; pieceIndex < sorted.length; pieceIndex += 1) {
        const component = sorted[pieceIndex];
        setProcessLabel(`正在生成切片 ${pieceIndex + 1} / ${sorted.length}…`);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const pieceWidth = component.maxX - component.minX + 1;
        const pieceHeight = component.maxY - component.minY + 1;
        const canvas = document.createElement("canvas");
        canvas.width = pieceWidth;
        canvas.height = pieceHeight;
        const context = canvas.getContext("2d");
        if (!context) continue;
        const output = context.createImageData(pieceWidth, pieceHeight);

        for (let y = component.minY; y <= component.maxY; y += 1) {
          for (let x = component.minX; x <= component.maxX; x += 1) {
            const sourcePixel = y * width + x;
            if (labels[sourcePixel] !== component.label) continue;
            const targetPixel = (y - component.minY) * pieceWidth + (x - component.minX);
            output.data[targetPixel * 4] = source[sourcePixel * 4];
            output.data[targetPixel * 4 + 1] = source[sourcePixel * 4 + 1];
            output.data[targetPixel * 4 + 2] = source[sourcePixel * 4 + 2];
            output.data[targetPixel * 4 + 3] = source[sourcePixel * 4 + 3];
          }
        }
        context.putImageData(output, 0, 0);
        const blob = await canvasToBlob(canvas);
        created.push({
          id: pieceIndex + 1,
          blob,
          url: URL.createObjectURL(blob),
          width: pieceWidth,
          height: pieceHeight,
          ratio: component.count / total,
        });
      }
      setPieces(created);
      setMessage(`完成：已生成 ${created.length} 个无缝 PNG 切片`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "分割失败，请调整线条后再试");
    } finally {
      setIsProcessing(false);
      setProcessLabel("");
    }
  };

  const downloadZip = async () => {
    if (!pieces.length || !imageInfo) return;
    setIsProcessing(true);
    setProcessLabel("正在打包全部切片…");
    try {
      const files: Record<string, Uint8Array> = {};
      await Promise.all(
        pieces.map(async (piece) => {
          const name = `${imageInfo.name}-piece-${String(piece.id).padStart(2, "0")}.png`;
          files[name] = new Uint8Array(await piece.blob.arrayBuffer());
        }),
      );
      const archive = await new Promise<Uint8Array>((resolve, reject) => {
        zip(files, { level: 0 }, (error, data) => (error ? reject(error) : resolve(data)));
      });
      const blob = new Blob([new Uint8Array(archive)], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `${imageInfo.name}-pieces.zip`);
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setMessage("打包失败，可先逐张下载切片");
    } finally {
      setIsProcessing(false);
      setProcessLabel("");
    }
  };

  const saveAllFiles = async () => {
    if (!pieces.length || !imageInfo) return;
    setIsProcessing(true);
    setProcessLabel("正在保存全部 PNG…");
    try {
      const picker = (
        window as typeof window & { showDirectoryPicker?: () => Promise<DirectoryHandleLike> }
      ).showDirectoryPicker;

      if (!picker) {
        setIsProcessing(false);
        setProcessLabel("");
        await downloadZip();
        setMessage("当前浏览器不支持选择文件夹，已改为下载 ZIP 压缩包");
        return;
      }

      const directory = await picker.call(window);
      for (const piece of pieces) {
        const name = `${imageInfo.name}-piece-${String(piece.id).padStart(2, "0")}.png`;
        const fileHandle = await directory.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(piece.blob);
        await writable.close();
      }
      setMessage(`完成：${pieces.length} 个 PNG 已保存到所选文件夹`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("批量保存失败，可以改用 ZIP 下载");
    } finally {
      setIsProcessing(false);
      setProcessLabel("");
    }
  };

  const activeAngle = activeLine
    ? Math.round(
        ((Math.atan2(activeLine.end.y - activeLine.start.y, activeLine.end.x - activeLine.start.x) * 180) /
          Math.PI +
          360) %
          180,
      )
    : null;

  return (
    <main className="app-shell">
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        onChange={handleFileInput}
        aria-label="选择图片"
      />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <span>切界</span>
          <em>LINE SLICE</em>
        </div>
        <div className="privacy-note"><span aria-hidden="true">●</span> 图片仅在本机处理，不会上传</div>
      </header>

      <div className="steps-bar" aria-label="操作步骤">
        <div className={imageInfo ? "step done" : "step active"}><b>01</b><span>上传图片</span></div>
        <i />
        <div className={imageInfo && !pieces.length ? "step active" : imageInfo ? "step done" : "step"}><b>02</b><span>画分割线</span></div>
        <i />
        <div className={pieces.length ? "step active" : "step"}><b>03</b><span>导出切片</span></div>
      </div>

      <section className="workbench">
        <aside className="tool-panel panel">
          <div className="panel-heading">
            <span>编辑工具</span>
            {lines.length > 0 && <b>{lines.length} 条</b>}
          </div>

          <button className="tool-card selected" type="button" disabled={!imageInfo}>
            <span className="line-tool-icon" aria-hidden="true" />
            <span><strong>直线分割</strong><small>拖拽画一条切线</small></span>
            <kbd>V</kbd>
          </button>

          <div className="snap-row">
            <span className="snap-icon" aria-hidden="true">⌁</span>
            <span><strong>智能吸附</strong><small>自动贴合边缘与交点</small></span>
            <span className="toggle on" aria-label="智能吸附已开启"><i /></span>
          </div>

          <div className="angle-assist-row">
            <span className="angle-icon" aria-hidden="true">∟</span>
            <span><strong>辅助画直</strong><small>自动校正水平、45° 与垂直</small></span>
            <b>0° · 45° · 90°</b>
          </div>

          <div className="divider" />
          <div className="tool-actions">
            <button type="button" onClick={undoLine} disabled={!lines.length || isProcessing}>
              <span aria-hidden="true">↶</span> 撤销
            </button>
            <button
              type="button"
              onClick={() => {
                setLines([]);
                clearPieces();
              }}
              disabled={!lines.length || isProcessing}
            >
              <span aria-hidden="true">×</span> 清空线条
            </button>
          </div>

          {imageInfo ? (
            <div className="file-card">
              <div className="file-thumb" aria-hidden="true">IMG</div>
              <div><strong>{imageInfo.name}</strong><small>{formatDimensions(imageInfo.originalWidth, imageInfo.originalHeight)}</small></div>
              <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="更换图片">↗</button>
            </div>
          ) : (
            <div className="mini-help">
              <span aria-hidden="true">↗</span>
              <p>先上传一张图片，再从画布一侧拖到另一侧。</p>
            </div>
          )}

          <div className="shortcut-note"><kbd>⌘</kbd><kbd>Z</kbd><span>快速撤销上一条线</span></div>
        </aside>

        <section className="stage-panel panel">
          <div className="stage-heading">
            <div>
              <strong>{imageInfo ? "在图片上拖拽画线" : "工作画布"}</strong>
              <span>{imageInfo ? "端点靠近边缘或已有线条时会自动吸附" : "上传后即可开始分割"}</span>
            </div>
            {imageInfo && (
              <button type="button" className="replace-button" onClick={() => fileInputRef.current?.click()}>
                更换图片
              </button>
            )}
          </div>

          <div
            className={`canvas-stage ${isDragging ? "dragging" : ""} ${imageInfo ? "has-image" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            {imageInfo ? (
              <>
                <canvas
                  ref={editorCanvasRef}
                  className="editor-canvas"
                  onPointerDown={startLine}
                  onPointerMove={moveLine}
                  onPointerUp={finishLine}
                  onPointerCancel={() => setActiveLine(null)}
                  aria-label="图片分割画布，拖拽以添加分割线"
                />
                {activeLine && <div className="angle-readout"><b>{activeAngle}°</b><span>直线辅助</span></div>}
              </>
            ) : (
              <div className="upload-state">
                <div className="upload-art" aria-hidden="true">
                  <span className="art-card one" />
                  <span className="art-card two" />
                  <span className="art-cut" />
                </div>
                <h1>把图片放到这里</h1>
                <p>拖拽上传，或从剪贴板粘贴一张图片</p>
                <div className="upload-actions">
                  <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                    <span aria-hidden="true">＋</span> 选择图片
                  </button>
                  <button className="text-button" type="button" onClick={loadSample}>试用示例图</button>
                </div>
                <small>支持 JPG · PNG · WebP · GIF</small>
              </div>
            )}
            {isProcessing && (
              <div className="processing-overlay" role="status">
                <span className="spinner" />
                <strong>{processLabel}</strong>
                <small>复杂图片可能需要几秒钟</small>
              </div>
            )}
          </div>

          <div className="stage-footer">
            <div className={`status-message ${message?.startsWith("完成") ? "success" : ""}`}>
              <span aria-hidden="true">{message?.startsWith("完成") ? "✓" : "i"}</span>
              {message ?? (imageInfo ? "分割线需要贯穿图片边缘，或与其他线条相连" : "所有处理均在浏览器中完成")}
            </div>
            <button
              className="split-button"
              type="button"
              onClick={splitImage}
              disabled={!imageInfo || !lines.length || isProcessing}
            >
              <span className="cut-button-icon" aria-hidden="true" />
              开始分割
              <b>→</b>
            </button>
          </div>
        </section>

        <aside className="result-panel panel">
          <div className="panel-heading">
            <span>切片结果</span>
            {pieces.length > 0 && <b>{pieces.length} 张</b>}
          </div>
          {pieces.length ? (
            <>
              <div className="piece-list">
                {pieces.map((piece, index) => (
                  <article className="piece-card" key={piece.id}>
                    <div className="piece-preview">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={piece.url} alt={`切片 ${piece.id}`} />
                      <span style={{ background: PIECE_COLORS[index % PIECE_COLORS.length] }}>{String(piece.id).padStart(2, "0")}</span>
                    </div>
                    <div className="piece-meta">
                      <strong>切片 {String(piece.id).padStart(2, "0")}</strong>
                      <small>{formatDimensions(piece.width, piece.height)} · {Math.round(piece.ratio * 100)}%</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => triggerDownload(piece.url, `${imageInfo?.name ?? "image"}-piece-${String(piece.id).padStart(2, "0")}.png`)}
                      aria-label={`下载切片 ${piece.id}`}
                    >↓</button>
                  </article>
                ))}
              </div>
              <div className="result-downloads">
                <button className="download-all" type="button" onClick={saveAllFiles} disabled={isProcessing}>
                  <span aria-hidden="true">⇩</span> 一键保存全部 PNG
                </button>
                <button className="download-zip" type="button" onClick={downloadZip} disabled={isProcessing}>
                  打包 ZIP
                </button>
              </div>
              <p className="result-note">透明背景 · PNG 格式 · 无分割线残留</p>
            </>
          ) : (
            <div className="empty-results">
              <div className="empty-grid" aria-hidden="true"><i /><i /><i /><i /></div>
              <strong>还没有切片</strong>
              <p>画好分割线后点击<br />“开始分割”</p>
              <span>结果会出现在这里</span>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
