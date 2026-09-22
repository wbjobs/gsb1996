# 取色 · 对比度 · 导出工具

纯前端颜色工具：Canvas 放大镜取色、EyeDropper 屏幕取色、WCAG 对比度检查、
调色板分析与多格式导出。调色板分析运行在 Web Worker 中，不阻塞交互。

## 运行

需通过 HTTP 访问（Worker 与 EyeDropper 均要求安全上下文，EyeDropper 还需
Chrome/Edge 95+）：

```bash
npm start          # http://localhost:8123
# 或任意静态服务器，例如：
python3 -m http.server 8123
```

测试（Node ≥ 18，无需依赖）：

```bash
npm test
```

## 功能与验收对应

| 验收项 | 实现 |
| --- | --- |
| 取色准确 | 画布点击/悬停通过 `getImageData(x,y,1,1)` 直读原始像素（无缩放误差，按 CSS 显示尺寸换算回原图像素）；15×15 像素放大镜居中十字指示取色点；EyeDropper 返回的 `sRGBHex` 经统一解析器校验后入库 |
| 对比度准确 | 严格按 WCAG 2.2 相对亮度与 `(L1+0.05)/(L2+0.05)` 公式计算；AA/AAA 正文(4.5/7)与大字(3/4.5)四档判定；Node 测试对照黑白 21:1、`#0000ff` 对白 8.592:1、`#767676` 4.54 等已知值 |
| 导出正确 | JSON（含元数据、RGB/HSL、黑白底对比度、来源）、CSS 自定义属性、带 BOM 的 CSV（Excel 兼容）三种文本格式；另可导出原图 + 色条 + HEX 标注的 PNG；文件名经清洗，Blob 下载，URL 自动回收 |
| 性能可接受 | Worker 内用 `OffscreenCanvas` + `ImageBitmap` 零拷贝转移完成像素分析；超过 120 万像素自动按步长抽样；中位切分带最大跳变切分点与重复盒合并；100 万随机像素抽样分析 ≈140ms（Node 基准），主线程仅做单像素读取与放大镜绘制（rAF 节流） |
| 异常有提示 | 全局 `error`/`unhandledrejection` 捕获 + 每个用户操作的 try/catch，统一 Toast 分级提示；文件类型/大小(30MB)/解码失败、颜色文本非法、EyeDropper 取消(AbortError 静默)与失败、Worker 初始化/超时(15s)/消息错误均覆盖；Worker 不可用或失败时自动回退主线程分析 |

## 文件结构

- `index.html` — 页面结构
- `css/styles.css` — 样式
- `js/color-utils.js` — 颜色解析/格式化/WCAG 亮度与对比度（主线程、Worker、Node 共享的 UMD）
- `js/quantize.js` — 中位切分调色板提取（含 alpha 合成、抽样、重复簇合并）
- `js/image-worker.js` — Web Worker：位图像素分析
- `js/app.js` — 主线程：加载、放大镜取色、EyeDropper、对比度面板、列表、导出、Toast
- `tests/` — Node 单元测试（对比度准确性 / 量化 / Worker 消息协议）

## 使用说明

1. 点击或拖放打开图片，加载后 Worker 自动分析主色调色板并入库。
2. 在图片上移动鼠标查看放大镜，点击取色；或使用「屏幕取色」对整个屏幕取色。
3. 前景/背景支持拾色器或直接输入 `#hex`、`rgb()`、`hsl()`、颜色名；实时显示
   对比度数值、AA/AAA 徽章与真实文本预览。
4. 列表中可复制 HEX、设为前景/背景、删除；选择格式后导出文件，或导出标注 PNG。
