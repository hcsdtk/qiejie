import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the image splitter", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /切界/);
  assert.match(html, /把图片放到这里/);
  assert.match(html, /开始分割/);
  assert.match(html, /图片仅在本机处理/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships the completed product surface", async () => {
  const [page, layout, styles, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /from "fflate"/);
  assert.match(page, /MAX_PIXELS/);
  assert.match(page, /splitImage/);
  assert.match(page, /saveAllFiles/);
  assert.match(page, /downloadZip/);
  assert.match(page, /assistLineEnd/);
  assert.match(page, /fitViewScale/);
  assert.match(page, /canvas-viewport/);
  assert.match(page, /Ctrl\/⌘ \+ 滚轮/);
  assert.match(page, /applyCrop/);
  assert.match(page, /applyGrid/);
  assert.match(page, /rotateImageClockwise/);
  assert.match(page, /undoEditor/);
  assert.match(page, /forceAngle: event\.shiftKey/);
  assert.match(page, /SHIFT 已锁定/);
  assert.match(page, /drawMagnifierPreview/);
  assert.match(page, /startMagnifierRef/);
  assert.match(page, /referenceGridVisible/);
  assert.match(page, /widthViewScale/);
  assert.match(page, /heightViewScale/);
  assert.match(page, /使图片宽度铺满画布/);
  assert.match(page, /使图片高度铺满画布/);
  assert.doesNotMatch(page, /drawReferenceGrid/);
  assert.doesNotMatch(page, /setSnapEnabled|setAngleAssistEnabled/);
  assert.match(page, /image\/webp/);
  assert.match(page, /导出仍使用原图像素/);
  assert.match(page, /tool-panel-scroll/);
  assert.match(page, /tool-panel-footer/);
  assert.match(styles, /grid-template-rows: minmax\(0, 1fr\)/);
  assert.match(styles, /overflow-y: scroll/);
  assert.match(styles, /scrollbar-gutter: stable/);
  assert.match(layout, /切界 — 画线分割图片/);
  assert.match(layout, /og\.png/);
  assert.match(packageJson, /"fflate"/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview/);
});
