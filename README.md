# Qiejie · 切界

纯浏览器图片分割工具：上传一张图片，在画布上画线或选择网格，即可得到独立的 PNG/JPG/WebP 切片。图片始终在本机浏览器内处理，不上传服务器。

[在线使用](https://qiejie-line-slice.chasenh.chatgpt.site/) · [GitHub 仓库](https://github.com/hcsdtk/qiejie) · [问题反馈](https://github.com/hcsdtk/qiejie/issues)

![Qiejie editor](docs/screenshots/editor.png)

## 为什么做

很多图片分割工具要上传原图、操作路径复杂，或者只支持固定的九宫格。Qiejie 的目标是把“打开图片 → 画几条线 → 导出结果”变成一个轻量、可解释、隐私友好的浏览器流程：分割规则由用户决定，原图不离开设备，结果可以直接继续使用。

## 项目背景与作用

Qiejie 面向设计、前端、内容制作和日常图片整理场景，适合：

- 将长图、漫画、海报、截图按内容边界切成独立图片
- 将一张设计稿快速拆成多个素材，便于上传或批量处理
- 用等分网格生成社交媒体切图、拼图和多列素材
- 在不安装桌面软件、不上传原图的情况下完成临时切图

## 功能

- 拖拽、文件选择和剪贴板粘贴上传
- 直线分割默认启用端点吸附与角度校正；按住 `Shift` 锁定 0°、45° 或 90°
- 画布工具栏可开启细密图片参考网格，网格不会出现在导出结果
- 分割线可选中、拖动端点、单独删除，支持撤销与重做
- 裁剪、旋转、水平翻转和垂直翻转
- 2×2、3×3、三栏，以及最多 12×12 的自定义等分网格
- 整体适应、宽度铺满、高度铺满、5%–400% 缩放和滚动查看长图
- 高清编辑预览与轻量分割计算分离，切片按原图像素输出
- PNG、JPG、WebP 导出，支持尺寸倍率与 JPG/WebP 质量设置
- 单张下载、保存到文件夹，以及浏览器本地 ZIP 打包下载
- 全部图片处理在浏览器完成，默认不联网、不保存原图

## 如何使用

1. 打开[在线版本](https://qiejie-line-slice.chasenh.chatgpt.site/)，拖入图片、选择文件，或直接粘贴剪贴板图片。
2. 选择“直线分割”或“裁剪画面”。直线模式下从画布一侧拖到另一侧；需要严格水平、垂直或 45° 时按住 `Shift`。
3. 使用“宽度”“高度”或“适应”调整视图；需要参考布局时在画布工具栏打开“网格”。
4. 需要规则切图时，在“等分网格”输入行列数并生成。
5. 检查切片预览，选择输出格式、尺寸和质量，然后下载单张、保存到文件夹或打包 ZIP。

## 开发

### 环境要求

- Node.js `>=22.13.0`
- npm

### 本地启动

```bash
git clone https://github.com/hcsdtk/qiejie.git
cd qiejie
npm install
npm run dev
```

打开终端输出的本地地址即可。生产构建、测试和代码检查：

```bash
npm run build
npm test
npm run lint
```

核心编辑器和分割算法位于 `app/page.tsx`，全局视觉样式位于 `app/globals.css`。项目使用 React、Next/vinext 和 Cloudflare Workers 兼容构建；浏览器本地打包 ZIP 使用 `fflate`。

### 贡献

欢迎提交 Issue 或 Pull Request。建议先说明使用场景、复现步骤和浏览器版本；涉及图像处理的改动请同时补充测试或示例。

## English

### What is Qiejie?

Qiejie is a privacy-first image slicing tool that runs entirely in the browser. Drop in an image, draw split lines or generate an equal grid, and export independent PNG, JPG, or WebP slices. Your image stays on your device and is never uploaded by the app.

### Why it exists

Most image splitters either require uploading the original file or only support a fixed grid. Qiejie keeps the workflow short and transparent: open an image, decide where the boundaries go, and download the result. It is useful for long screenshots, posters, comics, design assets, social-media tiles, and quick one-off edits.

### Highlights

- Drag-and-drop, file picker, and clipboard image input
- Line splitting with endpoint snapping and angle correction enabled by default
- Hold `Shift` to lock a line to 0°, 45°, or 90°
- Optional fine reference grid over the image (never exported)
- Crop, rotate, flip, undo/redo, and editable split lines
- Presets for 2×2, 3×3, three-column, and custom grids up to 12×12
- Fit, fit width, fit height, manual zoom, and scrollable long-image editing
- High-resolution editor preview with original-pixel slice output
- PNG, JPG, and WebP export with scale and quality controls
- Individual downloads, folder saving, and local ZIP packaging

### Usage

1. Open the [web app](https://qiejie-line-slice.chasenh.chatgpt.site/) and drop, select, or paste an image.
2. Choose line splitting or crop mode. In line mode, drag from one edge of the canvas to the other. Hold `Shift` for a strict straight angle.
3. Use Fit, Width, Height, or the zoom controls to inspect the image. Toggle the canvas grid when you need layout references.
4. Generate an equal grid when you need regular rows and columns.
5. Pick the output format, scale, and quality, then download individual slices or a ZIP archive.

### Development

```bash
git clone https://github.com/hcsdtk/qiejie.git
cd qiejie
npm install
npm run dev
```

Use `npm run build` for a production build, `npm test` for the build plus rendered-HTML checks, and `npm run lint` for static analysis. The editor lives in `app/page.tsx`; shared styles are in `app/globals.css`.

## Screenshots

The editor screenshot above shows line guides, the canvas toolbar, zoom presets, and the scrollable tool panel. `public/og.png` is the social preview used by the deployed site.

## License

No license has been selected yet. If you plan to reuse or redistribute the project, please open an issue first so the intended license can be documented.
