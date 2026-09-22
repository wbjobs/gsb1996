# 取色器 · 对比度 / 导出工具

纯前端零依赖工具：**取色 + WCAG 对比度 + 色板导出**，技术栈 Canvas + EyeDropper API + Web Worker。

## 运行

需要通过 HTTP 打开（module Web Worker 不支持 `file://`，此时会自动降级为主线程计算但不推荐）：

```bash
# 任选其一
python3 -m http.server 8000
npx serve .
```

浏览器访问 `http://localhost:8000`。EyeDropper API 需 Chrome/Edge 95+ 且在 HTTPS 或 localhost 下使用；不支持时按钮禁用，可用图片取色或原生色块兜底。

## 功能

### 取色
- **屏幕取色**：EyeDropper API，Esc 取消不报错，返回浏览器原生 sRGB 十六进制值。
- **图片取色**：打开/拖拽/粘贴（Ctrl/⌘+V）图片，Canvas 渲染并按 EXIF 自动校正方向；移动鼠标出现 11×11 像素放大镜，点击取中心像素（`getImageData(x, y, 1, 1)` 单像素读取，精确到物理像素）。
- **手动输入**：HEX 输入框支持 `#rgb` / `#rrggbb` / `rgb(r,g,b)`，非法输入有错误提示。
- **原生色块兜底**：任何浏览器都可用 `<input type="color">`。

### 对比度（WCAG 2.1）
- 严格按 WCAG 2.1 公式：sRGB 线性化（0.03928/12.92 分段）→ 相对亮度（0.2126R+0.7152G+0.0722B）→ `(L1+0.05)/(L2+0.05)`。
- 四档达标判定：普通文字 AA 4.5 / AAA 7，大号文字 AA 3 / AAA 4.5。
- 实时前景/背景预览、一键交换；色板中每个颜色对当前前景批量计算对比度并标注是否过 AA（点击设为前景，Shift+点击设为背景）。

### 导出（色板非空时可用）
- **JSON**：前/背景色、对比度、四档 WCAG 结果 + 色板（HEX/RGB/命名），带导出时间戳。
- **CSS 变量**：`:root { --color-1: #…; }` 形式，附对比度注释。
- **PNG 色卡**：离屏 Canvas 绘制色块 + HEX + RGB 后 `toBlob` 下载。
- JSON/CSS 另支持一键复制（安全上下文用 Clipboard API，否则 `execCommand` 兜底）。

### 性能
- 对比度计算、色板批量对比度、主色提取（中位切分 + 像素抽样，上限 20 万像素）全部在 **Web Worker** 中执行，主线程不阻塞。
- Worker 加载失败（如 `file://`）自动降级主线程计算，并在状态栏、性能面板明确提示。
- 放大镜只取 11×11 邻域而非整图；图片显示宽度上限 960px 限制像素数据量。
- 批量对比度一次 Worker 消息完成，120ms 防抖。
- 性能面板实时显示执行位置、任务类型与耗时。

### 异常处理（均有 Toast 提示）
EyeDropper 不支持/用户取消、HEX 解析失败、非图片文件、超大图片、图片解码失败、Worker 加载/运行错误并降级、空色板导出、PNG 生成失败、复制失败（非安全上下文）、全局 `error` 与 `unhandledrejection`。

## 测试

```bash
node --test ./test/*.test.mjs
```

覆盖：颜色解析、亮度边界（黑 0 / 白 1）、对比度白黑 21:1、同色 1:1、WCAG 官方参考值（`#767676`≈4.54、`#595959`≈7）、四档阈值、中位切分主色提取与透明像素跳过。

## 目录

```
index.html
css/style.css
js/app.js              # UI、交互、WorkerClient、导出
js/color-utils.js      # 颜色算法（主线程/Worker 共用，纯函数）
workers/color.worker.js# 对比度/批量/主色提取任务
test/color-utils.test.mjs
```
