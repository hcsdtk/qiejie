"use client";

import {
  ChangeEvent,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { zip } from "fflate";

type Point = { x: number; y: number };
type CutLine = { id: number; start: Point; end: Point };
type CropSelection = { start: Point; end: Point };
type Matrix2D = { a: number; b: number; c: number; d: number; e: number; f: number };
type ImageDocument = {
  width: number;
  height: number;
  matrix: Matrix2D;
};
type ImageInfo = {
  name: string;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
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
type EditorSnapshot = {
  document: ImageDocument;
  lines: CutLine[];
};
type ToolMode = "line" | "crop";
type ExportFormat = "image/png" | "image/jpeg" | "image/webp";
type CanvasGesture =
  | { type: "draw-line" }
  | { type: "move-endpoint"; before: EditorSnapshot; lineId: number; endpoint: "start" | "end" }
  | { type: "crop" };
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
const MIN_VIEW_SCALE = 0.05;
const MAX_VIEW_SCALE = 4;
const PIECE_COLORS = ["#ff5a36", "#4773ff", "#16a778", "#8e5cff", "#e4a11b"];
const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const EXPORT_FORMATS: Array<{ value: ExportFormat; label: string; extension: string }> = [
  { value: "image/png", label: "PNG", extension: "png" },
  { value: "image/jpeg", label: "JPG", extension: "jpg" },
  { value: "image/webp", label: "WebP", extension: "webp" },
];

function cloneLines(lines: CutLine[]) {
  return lines.map((line) => ({
    ...line,
    start: { ...line.start },
    end: { ...line.end },
  }));
}

function cloneDocument(document: ImageDocument): ImageDocument {
  return { ...document, matrix: { ...document.matrix } };
}

function multiplyMatrices(left: Matrix2D, right: Matrix2D): Matrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function getPreviewScale(width: number, height: number) {
  const areaScale = Math.sqrt(MAX_PIXELS / (width * height));
  const edgeScale = MAX_EDGE / Math.max(width, height);
  return Math.min(1, areaScale, edgeScale);
}

function distanceToSegment(point: Point, line: CutLine) {
  const nearest = nearestPointOnLine(point, line);
  return Math.hypot(nearest.x - point.x, nearest.y - point.y);
}

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
  selected = false,
) {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = active ? "#171717" : selected ? "#4773ff" : "#ff5a36";
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
    context.fillStyle = active ? "#171717" : selected ? "#4773ff" : "#ffffff";
    context.strokeStyle = active ? "#ffffff" : selected ? "#ffffff" : "#ff5a36";
    context.lineWidth = Math.max(2, context.canvas.width / 1000);
    context.arc(point.x, point.y, Math.max(5, context.canvas.width / 330), 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
}

function drawCropOverlay(context: CanvasRenderingContext2D, crop: CropSelection) {
  const left = Math.min(crop.start.x, crop.end.x);
  const top = Math.min(crop.start.y, crop.end.y);
  const width = Math.abs(crop.end.x - crop.start.x);
  const height = Math.abs(crop.end.y - crop.start.y);
  if (width < 1 || height < 1) return;

  context.save();
  context.fillStyle = "rgba(20, 20, 19, .48)";
  context.beginPath();
  context.rect(0, 0, context.canvas.width, context.canvas.height);
  context.rect(left, top, width, height);
  context.fill("evenodd");
  context.strokeStyle = "#ffffff";
  context.lineWidth = Math.max(2, context.canvas.width / 900);
  context.setLineDash([10, 7]);
  context.strokeRect(left, top, width, height);
  context.setLineDash([]);
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

function canvasToBlob(canvas: HTMLCanvasElement, type: ExportFormat = "image/png", quality = 0.92) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片生成失败"))),
      type,
      quality,
    );
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

function clampViewScale(scale: number) {
  return Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, scale));
}

export default function Home() {
  const editorCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lineIdRef = useRef(1);
  const gestureRef = useRef<CanvasGesture | null>(null);
  const [imageDocument, setImageDocument] = useState<ImageDocument | null>(null);
  const [imageName, setImageName] = useState("image");
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [lines, setLines] = useState<CutLine[]>([]);
  const [activeLine, setActiveLine] = useState<Omit<CutLine, "id"> | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<number | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>("line");
  const [cropSelection, setCropSelection] = useState<CropSelection | null>(null);
  const [undoStack, setUndoStack] = useState<EditorSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditorSnapshot[]>([]);
  const [gridRows, setGridRows] = useState(2);
  const [gridColumns, setGridColumns] = useState(2);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("image/png");
  const [exportQuality, setExportQuality] = useState(0.92);
  const [exportScale, setExportScale] = useState(1);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processLabel, setProcessLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"fit" | "custom">("fit");
  const [customViewScale, setCustomViewScale] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

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
        const scale = getPreviewScale(image.naturalWidth, image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        sourceImageRef.current = image;
        setImageName(file.name.replace(/\.[^.]+$/, "") || "image");
        setImageDocument({
          width: image.naturalWidth,
          height: image.naturalHeight,
          matrix: { ...IDENTITY_MATRIX },
        });
        setLines([]);
        setSelectedLineId(null);
        setCropSelection(null);
        setToolMode("line");
        setUndoStack([]);
        setRedoStack([]);
        setViewMode("fit");
        setCustomViewScale(1);
        lineIdRef.current = 1;
        clearPieces();
        setMessage(
          scale < 1
            ? `预览已优化至 ${formatDimensions(width, height)}，导出仍使用原图像素`
            : null,
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
    const sourceImage = sourceImageRef.current;
    if (!sourceImage || !imageDocument) return;
    const scale = getPreviewScale(imageDocument.width, imageDocument.height);
    const width = Math.max(1, Math.round(imageDocument.width * scale));
    const height = Math.max(1, Math.round(imageDocument.height * scale));
    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = width;
    baseCanvas.height = height;
    const context = baseCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const matrix = imageDocument.matrix;
    context.setTransform(
      scale * matrix.a,
      scale * matrix.b,
      scale * matrix.c,
      scale * matrix.d,
      scale * matrix.e,
      scale * matrix.f,
    );
    context.drawImage(sourceImage, 0, 0);
    context.resetTransform();
    baseCanvasRef.current = baseCanvas;
    setImageInfo({
      name: imageName,
      sourceWidth: sourceImage.naturalWidth,
      sourceHeight: sourceImage.naturalHeight,
      outputWidth: imageDocument.width,
      outputHeight: imageDocument.height,
      width,
      height,
      scale,
    });
  }, [imageDocument, imageName]);

  const currentSnapshot = useCallback((): EditorSnapshot | null => {
    if (!imageDocument) return null;
    return {
      document: cloneDocument(imageDocument),
      lines: cloneLines(lines),
    };
  }, [imageDocument, lines]);

  const restoreSnapshot = useCallback(
    (snapshot: EditorSnapshot) => {
      setImageDocument(cloneDocument(snapshot.document));
      setLines(cloneLines(snapshot.lines));
      setSelectedLineId(null);
      setCropSelection(null);
      setActiveLine(null);
      setToolMode("line");
      clearPieces();
      setMessage("已恢复上一步编辑");
    },
    [clearPieces],
  );

  const pushUndoSnapshot = useCallback((snapshot: EditorSnapshot | null) => {
    if (!snapshot) return;
    setUndoStack((current) => [...current.slice(-49), snapshot]);
    setRedoStack([]);
  }, []);

  const undoEditor = useCallback(() => {
    const target = undoStack.at(-1);
    const current = currentSnapshot();
    if (!target || !current) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack.slice(-49), current]);
    restoreSnapshot(target);
  }, [currentSnapshot, restoreSnapshot, undoStack]);

  const redoEditor = useCallback(() => {
    const target = redoStack.at(-1);
    const current = currentSnapshot();
    if (!target || !current) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack.slice(-49), current]);
    restoreSnapshot(target);
  }, [currentSnapshot, redoStack, restoreSnapshot]);

  const deleteSelectedLine = useCallback(() => {
    if (selectedLineId === null) return;
    pushUndoSnapshot(currentSnapshot());
    setLines((current) => current.filter((line) => line.id !== selectedLineId));
    setSelectedLineId(null);
    clearPieces();
    setMessage("已删除所选分割线");
  }, [clearPieces, currentSnapshot, pushUndoSnapshot, selectedLineId]);

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
      const target = event.target as HTMLElement | null;
      const isFormField = target?.matches("input, select, textarea");
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "z" && event.shiftKey) {
        event.preventDefault();
        redoEditor();
      } else if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        undoEditor();
      } else if ((event.metaKey || event.ctrlKey) && key === "y") {
        event.preventDefault();
        redoEditor();
      } else if (!isFormField && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelectedLine();
      } else if (!isFormField && key === "v") {
        setToolMode("line");
        setCropSelection(null);
      } else if (!isFormField && key === "c") {
        setToolMode("crop");
        setSelectedLineId(null);
      }
    };
    window.addEventListener("paste", handlePaste);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("paste", handlePaste);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [deleteSelectedLine, loadImageFile, redoEditor, undoEditor]);

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
    lines.forEach((line) => drawLineOverlay(context, line, false, line.id === selectedLineId));
    if (activeLine) drawLineOverlay(context, activeLine, true);
    if (cropSelection) drawCropOverlay(context, cropSelection);
  }, [activeLine, cropSelection, imageInfo, lines, selectedLineId]);

  useEffect(() => {
    const viewport = canvasViewportRef.current;
    if (!viewport || !imageInfo) return;
    const updateSize = () => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [imageInfo]);

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

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imageInfo || isProcessing) return;
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    const rawPoint = getCanvasPoint(canvas, event.clientX, event.clientY);

    if (toolMode === "crop") {
      gestureRef.current = { type: "crop" };
      setCropSelection({ start: rawPoint, end: rawPoint });
      setMessage("拖出需要保留的画面区域，然后应用裁剪");
      return;
    }

    const displayScale = canvas.getBoundingClientRect().width / canvas.width;
    const hitRadius = Math.max(5, 12 / Math.max(displayScale, 0.01));
    const endpointHit = [...lines].reverse().flatMap((line) => [
      { line, endpoint: "start" as const, distance: Math.hypot(line.start.x - rawPoint.x, line.start.y - rawPoint.y) },
      { line, endpoint: "end" as const, distance: Math.hypot(line.end.x - rawPoint.x, line.end.y - rawPoint.y) },
    ]).sort((a, b) => a.distance - b.distance)[0];

    if (endpointHit && endpointHit.distance <= hitRadius) {
      const before = currentSnapshot();
      if (!before) return;
      gestureRef.current = {
        type: "move-endpoint",
        before,
        lineId: endpointHit.line.id,
        endpoint: endpointHit.endpoint,
      };
      setSelectedLineId(endpointHit.line.id);
      setMessage("正在调整分割线端点");
      return;
    }

    const lineHit = [...lines]
      .reverse()
      .find((line) => distanceToSegment(rawPoint, line) <= hitRadius * 0.75);
    if (lineHit) {
      gestureRef.current = null;
      setSelectedLineId(lineHit.id);
      setMessage("已选中分割线，可拖动端点或按 Delete 删除");
      return;
    }

    const point = snapPoint(rawPoint, imageInfo.width, imageInfo.height, lines);
    gestureRef.current = { type: "draw-line" };
    setSelectedLineId(null);
    setActiveLine({ start: point, end: point });
    setMessage(null);
  };

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imageInfo) return;
    const gesture = gestureRef.current;
    if (!gesture) return;
    const rawPoint = getCanvasPoint(event.currentTarget, event.clientX, event.clientY);

    if (gesture.type === "crop") {
      setCropSelection((current) => (current ? { ...current, end: rawPoint } : null));
      return;
    }

    if (gesture.type === "move-endpoint") {
      const otherLines = lines.filter((line) => line.id !== gesture.lineId);
      const point = snapPoint(rawPoint, imageInfo.width, imageInfo.height, otherLines);
      setLines((current) => current.map((line) => (
        line.id === gesture.lineId ? { ...line, [gesture.endpoint]: point } : line
      )));
      clearPieces();
      return;
    }

    if (!activeLine) return;
    const point = assistLineEnd(activeLine.start, rawPoint, imageInfo.width, imageInfo.height, lines);
    setActiveLine((current) => (current ? { ...current, end: point } : null));
  };

  const handleCanvasPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || !imageInfo) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (gesture.type === "move-endpoint") {
      pushUndoSnapshot(gesture.before);
      setMessage("分割线已更新");
    } else if (gesture.type === "draw-line" && activeLine) {
      const rawPoint = getCanvasPoint(event.currentTarget, event.clientX, event.clientY);
      const end = assistLineEnd(activeLine.start, rawPoint, imageInfo.width, imageInfo.height, lines);
      if (Math.hypot(end.x - activeLine.start.x, end.y - activeLine.start.y) > 12) {
        pushUndoSnapshot(currentSnapshot());
        const line: CutLine = { id: lineIdRef.current++, start: activeLine.start, end };
        setLines((current) => [...current, line]);
        setSelectedLineId(line.id);
        clearPieces();
      }
      setActiveLine(null);
    }
    gestureRef.current = null;
  };

  const cancelCanvasGesture = () => {
    const gesture = gestureRef.current;
    if (gesture?.type === "move-endpoint") restoreSnapshot(gesture.before);
    if (gesture?.type === "draw-line") setActiveLine(null);
    if (gesture?.type === "crop") setCropSelection(null);
    gestureRef.current = null;
  };

  const clearAllLines = () => {
    if (!lines.length) return;
    pushUndoSnapshot(currentSnapshot());
    clearPieces();
    setLines([]);
    setSelectedLineId(null);
    setMessage("已清空全部分割线");
  };

  const applyImageOperation = (operation: Matrix2D, width: number, height: number, label: string) => {
    if (!imageDocument) return;
    pushUndoSnapshot(currentSnapshot());
    setImageDocument({
      width,
      height,
      matrix: multiplyMatrices(operation, imageDocument.matrix),
    });
    setLines([]);
    setSelectedLineId(null);
    setCropSelection(null);
    setToolMode("line");
    clearPieces();
    setViewMode("fit");
    setMessage(`${label}已应用；撤销可恢复原有分割线`);
  };

  const rotateImageClockwise = () => {
    if (!imageDocument) return;
    applyImageOperation(
      { a: 0, b: 1, c: -1, d: 0, e: imageDocument.height, f: 0 },
      imageDocument.height,
      imageDocument.width,
      "顺时针旋转",
    );
  };

  const flipImage = (axis: "horizontal" | "vertical") => {
    if (!imageDocument) return;
    const operation = axis === "horizontal"
      ? { a: -1, b: 0, c: 0, d: 1, e: imageDocument.width, f: 0 }
      : { a: 1, b: 0, c: 0, d: -1, e: 0, f: imageDocument.height };
    applyImageOperation(operation, imageDocument.width, imageDocument.height, axis === "horizontal" ? "水平翻转" : "垂直翻转");
  };

  const applyCrop = () => {
    if (!imageDocument || !imageInfo || !cropSelection) return;
    const left = Math.max(0, Math.floor(Math.min(cropSelection.start.x, cropSelection.end.x) / imageInfo.scale));
    const top = Math.max(0, Math.floor(Math.min(cropSelection.start.y, cropSelection.end.y) / imageInfo.scale));
    const right = Math.min(imageDocument.width, Math.ceil(Math.max(cropSelection.start.x, cropSelection.end.x) / imageInfo.scale));
    const bottom = Math.min(imageDocument.height, Math.ceil(Math.max(cropSelection.start.y, cropSelection.end.y) / imageInfo.scale));
    if (right - left < 8 || bottom - top < 8) {
      setMessage("裁剪区域太小，请重新拖选");
      return;
    }
    applyImageOperation(
      { a: 1, b: 0, c: 0, d: 1, e: -left, f: -top },
      right - left,
      bottom - top,
      "裁剪",
    );
  };

  const applyGrid = (rows = gridRows, columns = gridColumns) => {
    if (!imageInfo) return;
    const safeRows = Math.max(1, Math.min(12, Math.round(rows)));
    const safeColumns = Math.max(1, Math.min(12, Math.round(columns)));
    pushUndoSnapshot(currentSnapshot());
    const nextLines: CutLine[] = [];
    for (let column = 1; column < safeColumns; column += 1) {
      const x = (column / safeColumns) * (imageInfo.width - 1);
      nextLines.push({ id: lineIdRef.current++, start: { x, y: 0 }, end: { x, y: imageInfo.height - 1 } });
    }
    for (let row = 1; row < safeRows; row += 1) {
      const y = (row / safeRows) * (imageInfo.height - 1);
      nextLines.push({ id: lineIdRef.current++, start: { x: 0, y }, end: { x: imageInfo.width - 1, y } });
    }
    setGridRows(safeRows);
    setGridColumns(safeColumns);
    setLines(nextLines);
    setSelectedLineId(null);
    setToolMode("line");
    clearPieces();
    setMessage(`已生成 ${safeRows} × ${safeColumns} 等分网格`);
  };

  const fitViewScale = imageInfo
    ? Math.min(
        1,
        Math.max(0.01, (viewportSize.width - 36) / imageInfo.width),
        Math.max(0.01, (viewportSize.height - 36) / imageInfo.height),
      )
    : 1;
  const viewScale = viewMode === "fit" ? fitViewScale : customViewScale;
  const viewPercent = Math.max(1, Math.round(viewScale * 100));

  const setExactViewScale = (nextScale: number) => {
    setCustomViewScale(clampViewScale(nextScale));
    setViewMode("custom");
  };

  const zoomView = (direction: 1 | -1) => {
    const factor = direction > 0 ? 1.2 : 1 / 1.2;
    setExactViewScale(viewScale * factor);
  };

  const handleViewWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    setExactViewScale(viewScale * factor);
  };

  const splitImage = async () => {
    const baseCanvas = baseCanvasRef.current;
    const sourceImage = sourceImageRef.current;
    if (!baseCanvas || !sourceImage || !imageDocument || !imageInfo || !lines.length || isProcessing) return;
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

      const sorted = [...components].sort((a, b) => a.minY - b.minY || a.minX - b.minX);
      const created: Piece[] = [];

      for (let pieceIndex = 0; pieceIndex < sorted.length; pieceIndex += 1) {
        const component = sorted[pieceIndex];
        setProcessLabel(`正在按原图生成切片 ${pieceIndex + 1} / ${sorted.length}…`);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const previewPieceWidth = component.maxX - component.minX + 1;
        const previewPieceHeight = component.maxY - component.minY + 1;
        const fullLeft = Math.floor(component.minX / imageInfo.scale);
        const fullTop = Math.floor(component.minY / imageInfo.scale);
        const fullRight = Math.min(imageDocument.width, Math.ceil((component.maxX + 1) / imageInfo.scale));
        const fullBottom = Math.min(imageDocument.height, Math.ceil((component.maxY + 1) / imageInfo.scale));
        const pieceWidth = Math.max(1, Math.round((fullRight - fullLeft) * exportScale));
        const pieceHeight = Math.max(1, Math.round((fullBottom - fullTop) * exportScale));
        if (pieceWidth > 16_384 || pieceHeight > 16_384 || pieceWidth * pieceHeight > 40_000_000) {
          throw new Error("当前导出倍率会生成超大切片，请降低尺寸倍率后再试");
        }
        const canvas = document.createElement("canvas");
        canvas.width = pieceWidth;
        canvas.height = pieceHeight;
        const context = canvas.getContext("2d");
        if (!context) continue;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        const matrix = imageDocument.matrix;
        context.setTransform(
          exportScale * matrix.a,
          exportScale * matrix.b,
          exportScale * matrix.c,
          exportScale * matrix.d,
          exportScale * (matrix.e - fullLeft),
          exportScale * (matrix.f - fullTop),
        );
        context.drawImage(sourceImage, 0, 0);
        context.resetTransform();

        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = previewPieceWidth;
        maskCanvas.height = previewPieceHeight;
        const maskContext = maskCanvas.getContext("2d");
        if (!maskContext) continue;
        const mask = maskContext.createImageData(previewPieceWidth, previewPieceHeight);

        for (let y = component.minY; y <= component.maxY; y += 1) {
          for (let x = component.minX; x <= component.maxX; x += 1) {
            const sourcePixel = y * width + x;
            if (labels[sourcePixel] !== component.label) continue;
            const targetPixel = (y - component.minY) * previewPieceWidth + (x - component.minX);
            mask.data[targetPixel * 4] = 255;
            mask.data[targetPixel * 4 + 1] = 255;
            mask.data[targetPixel * 4 + 2] = 255;
            mask.data[targetPixel * 4 + 3] = 255;
          }
        }
        maskContext.putImageData(mask, 0, 0);
        context.globalCompositeOperation = "destination-in";
        context.imageSmoothingEnabled = false;
        context.drawImage(maskCanvas, 0, 0, pieceWidth, pieceHeight);
        context.globalCompositeOperation = "source-over";

        let exportCanvas = canvas;
        if (exportFormat === "image/jpeg") {
          const flattened = document.createElement("canvas");
          flattened.width = pieceWidth;
          flattened.height = pieceHeight;
          const flattenedContext = flattened.getContext("2d");
          if (!flattenedContext) continue;
          flattenedContext.fillStyle = "#ffffff";
          flattenedContext.fillRect(0, 0, pieceWidth, pieceHeight);
          flattenedContext.drawImage(canvas, 0, 0);
          exportCanvas = flattened;
        }
        const blob = await canvasToBlob(exportCanvas, exportFormat, exportQuality);
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
      const formatLabel = EXPORT_FORMATS.find((format) => format.value === exportFormat)?.label ?? "图片";
      setMessage(`完成：已按原图生成 ${created.length} 个 ${formatLabel} 切片`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "分割失败，请调整线条后再试");
    } finally {
      setIsProcessing(false);
      setProcessLabel("");
    }
  };

  const exportExtension = EXPORT_FORMATS.find((format) => format.value === exportFormat)?.extension ?? "png";

  const downloadZip = async () => {
    if (!pieces.length || !imageInfo) return;
    setIsProcessing(true);
    setProcessLabel("正在打包全部切片…");
    try {
      const files: Record<string, Uint8Array> = {};
      await Promise.all(
        pieces.map(async (piece) => {
          const name = `${imageInfo.name}-piece-${String(piece.id).padStart(2, "0")}.${exportExtension}`;
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
        const name = `${imageInfo.name}-piece-${String(piece.id).padStart(2, "0")}.${exportExtension}`;
        const fileHandle = await directory.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(piece.blob);
        await writable.close();
      }
      setMessage(`完成：${pieces.length} 个切片已保存到所选文件夹`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("批量保存失败，可以改用 ZIP 下载");
    } finally {
      setIsProcessing(false);
      setProcessLabel("");
    }
  };

  const invalidateExport = (label: string) => {
    if (pieces.length) {
      clearPieces();
      setMessage(`${label}已更新，请重新开始分割`);
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

          <div className="tool-panel-scroll">
            <button
              className={`tool-card ${toolMode === "line" ? "selected" : ""}`}
              type="button"
              disabled={!imageInfo}
              onClick={() => {
                setToolMode("line");
                setCropSelection(null);
              }}
            >
              <span className="line-tool-icon" aria-hidden="true" />
              <span><strong>直线分割</strong><small>画线、选中并调整端点</small></span>
              <kbd>V</kbd>
            </button>

          <button
            className={`tool-card crop-tool ${toolMode === "crop" ? "selected" : ""}`}
            type="button"
            disabled={!imageInfo}
            onClick={() => {
              setToolMode("crop");
              setSelectedLineId(null);
            }}
          >
            <span className="crop-tool-icon" aria-hidden="true" />
            <span><strong>裁剪画面</strong><small>拖出需要保留的区域</small></span>
            <kbd>C</kbd>
          </button>

          {toolMode === "line" ? (
            <>
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
            </>
          ) : (
            <div className="crop-actions">
              <button type="button" onClick={applyCrop} disabled={!cropSelection}>应用裁剪</button>
              <button type="button" onClick={() => setCropSelection(null)} disabled={!cropSelection}>取消</button>
            </div>
          )}

          <div className="divider" />

          <div className="subsection-label"><span>画面变换</span><small>原图像素</small></div>
          <div className="transform-actions">
            <button type="button" onClick={rotateImageClockwise} disabled={!imageInfo || isProcessing}>↻<small>旋转</small></button>
            <button type="button" onClick={() => flipImage("horizontal")} disabled={!imageInfo || isProcessing}>↔<small>水平</small></button>
            <button type="button" onClick={() => flipImage("vertical")} disabled={!imageInfo || isProcessing}>↕<small>垂直</small></button>
          </div>

          <div className="grid-builder">
            <div className="subsection-label"><span>等分网格</span><small>最多 12 × 12</small></div>
            <div className="grid-fields">
              <label>行<input type="number" min="1" max="12" value={gridRows} onChange={(event) => setGridRows(Number(event.target.value))} /></label>
              <span>×</span>
              <label>列<input type="number" min="1" max="12" value={gridColumns} onChange={(event) => setGridColumns(Number(event.target.value))} /></label>
              <button type="button" onClick={() => applyGrid()} disabled={!imageInfo || (gridRows <= 1 && gridColumns <= 1)}>生成</button>
            </div>
            <div className="grid-presets">
              <button type="button" onClick={() => applyGrid(2, 2)} disabled={!imageInfo}>2 × 2</button>
              <button type="button" onClick={() => applyGrid(3, 3)} disabled={!imageInfo}>3 × 3</button>
              <button type="button" onClick={() => applyGrid(1, 3)} disabled={!imageInfo}>三栏</button>
            </div>
          </div>

            <div className="tool-actions history-actions">
              <button type="button" onClick={undoEditor} disabled={!undoStack.length || isProcessing}>
                <span aria-hidden="true">↶</span> 撤销
              </button>
              <button type="button" onClick={redoEditor} disabled={!redoStack.length || isProcessing}>
                <span aria-hidden="true">↷</span> 重做
              </button>
              <button type="button" onClick={deleteSelectedLine} disabled={selectedLineId === null || isProcessing}>
                删除所选
              </button>
              <button
                type="button"
                onClick={clearAllLines}
                disabled={!lines.length || isProcessing}
              >
                清空线条
              </button>
            </div>
          </div>

          <div className="tool-panel-footer">
            {imageInfo ? (
              <div className="file-card">
                <div className="file-thumb" aria-hidden="true">IMG</div>
                <div><strong>{imageInfo.name}</strong><small>{formatDimensions(imageInfo.outputWidth, imageInfo.outputHeight)}</small></div>
                <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="更换图片">↗</button>
              </div>
            ) : (
              <div className="mini-help">
                <span aria-hidden="true">↗</span>
                <p>先上传一张图片，再从画布一侧拖到另一侧。</p>
              </div>
            )}

            <div className="shortcut-note"><kbd>⌘</kbd><kbd>Z</kbd><span>撤销 · Shift + Z 重做</span></div>
          </div>
        </aside>

        <section className="stage-panel panel">
          <div className="stage-heading">
            <div>
              <strong>{imageInfo ? (toolMode === "crop" ? "拖出要保留的区域" : "画线或选择已有分割线") : "工作画布"}</strong>
              <span>{imageInfo ? (toolMode === "crop" ? "确认选区后点击左侧“应用裁剪”" : "蓝色线条已选中，可拖动端点继续调整") : "上传后即可开始分割"}</span>
            </div>
            {imageInfo && (
              <div className="stage-controls">
                <div className="zoom-controls" role="group" aria-label="画布缩放">
                  <button
                    type="button"
                    className={viewMode === "fit" ? "active" : ""}
                    onClick={() => setViewMode("fit")}
                    aria-label="使图片适应窗口"
                  >适应</button>
                  <button
                    type="button"
                    onClick={() => zoomView(-1)}
                    disabled={viewScale <= MIN_VIEW_SCALE}
                    aria-label="缩小视图"
                  >−</button>
                  <button
                    type="button"
                    className="zoom-value"
                    onClick={() => setExactViewScale(1)}
                    title="点击恢复 100%"
                    aria-label={`当前缩放 ${viewPercent}%，点击恢复 100%`}
                  >{viewPercent}%</button>
                  <button
                    type="button"
                    onClick={() => zoomView(1)}
                    disabled={viewScale >= MAX_VIEW_SCALE}
                    aria-label="放大视图"
                  >＋</button>
                </div>
                <button type="button" className="replace-button" onClick={() => fileInputRef.current?.click()}>
                  更换图片
                </button>
              </div>
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
                <div
                  ref={canvasViewportRef}
                  className="canvas-viewport"
                  onWheel={handleViewWheel}
                >
                  <div className="canvas-viewport-inner">
                    <canvas
                      ref={editorCanvasRef}
                      className={`editor-canvas ${toolMode === "crop" ? "crop-mode" : ""}`}
                      style={{
                        width: `${Math.max(1, imageInfo.width * viewScale)}px`,
                        height: `${Math.max(1, imageInfo.height * viewScale)}px`,
                      }}
                      onPointerDown={handleCanvasPointerDown}
                      onPointerMove={handleCanvasPointerMove}
                      onPointerUp={handleCanvasPointerUp}
                      onPointerCancel={cancelCanvasGesture}
                      aria-label={toolMode === "crop" ? "图片裁剪画布，拖拽选择保留区域" : "图片分割画布，拖拽以添加或编辑分割线"}
                    />
                  </div>
                </div>
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
              {message ?? (imageInfo ? "分割线需贯穿边缘；Ctrl/⌘ + 滚轮可缩放视图" : "所有处理均在浏览器中完成")}
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
          {imageInfo && (
            <div className="export-settings">
              <div className="export-setting-row">
                <span>格式</span>
                <div className="format-options" role="group" aria-label="导出格式">
                  {EXPORT_FORMATS.map((format) => (
                    <button
                      type="button"
                      key={format.value}
                      className={exportFormat === format.value ? "active" : ""}
                      onClick={() => {
                        invalidateExport("导出格式");
                        setExportFormat(format.value);
                      }}
                    >{format.label}</button>
                  ))}
                </div>
              </div>
              <label className="export-setting-row">
                <span>尺寸</span>
                <select
                  value={exportScale}
                  onChange={(event) => {
                    invalidateExport("导出尺寸");
                    setExportScale(Number(event.target.value));
                  }}
                >
                  <option value="0.5">原图 50%</option>
                  <option value="1">原图 100%</option>
                  <option value="2">原图 200%</option>
                </select>
              </label>
              {exportFormat !== "image/png" && (
                <label className="quality-setting">
                  <span>质量 <b>{Math.round(exportQuality * 100)}</b></span>
                  <input
                    type="range"
                    min="0.5"
                    max="1"
                    step="0.01"
                    value={exportQuality}
                    onChange={(event) => {
                      invalidateExport("导出质量");
                      setExportQuality(Number(event.target.value));
                    }}
                  />
                </label>
              )}
              <small>预览会自动提速，导出按当前原图尺寸计算</small>
            </div>
          )}
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
                      onClick={() => triggerDownload(piece.url, `${imageInfo?.name ?? "image"}-piece-${String(piece.id).padStart(2, "0")}.${exportExtension}`)}
                      aria-label={`下载切片 ${piece.id}`}
                    >↓</button>
                  </article>
                ))}
              </div>
              <div className="result-downloads">
                <button className="download-all" type="button" onClick={saveAllFiles} disabled={isProcessing}>
                  <span aria-hidden="true">⇩</span> 一键保存全部 {EXPORT_FORMATS.find((format) => format.value === exportFormat)?.label}
                </button>
                <button className="download-zip" type="button" onClick={downloadZip} disabled={isProcessing}>
                  打包 ZIP
                </button>
              </div>
              <p className="result-note">{exportFormat === "image/jpeg" ? "白色背景" : "透明背景"} · 原图级输出 · 无分割线残留</p>
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
