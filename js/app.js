import {
  parseColor, toHex, toRgbString, contrastRatio,
  wcagGrade, bestTextColor, extractPalette,
} from './color-utils.js';

/* ============================================================
 * 小工具
 * ========================================================== */
const $ = (id) => document.getElementById(id);

const toastBox = $('toast');
let toastTimer = null;
function toast(message, kind = 'info', duration = 2600) {
  toastBox.textContent = message;
  toastBox.className = `toast ${kind === 'info' ? '' : kind}`;
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastBox.hidden = true; }, duration);
}

function setBadge(el, text, kind) {
  el.textContent = text;
  el.className = `badge ${kind === 'ok' ? 'badge-ok' : kind === 'warn' ? 'badge-warn' : kind === 'bad' ? 'badge-bad' : 'badge-muted'}`;
}

/* ============================================================
 * WorkerClient：优先 module worker，失败时主线程兜底
 * （file:// 直接打开页面时 worker 无法启动，任务改在主线程执行）
 * ========================================================== */
class WorkerClient {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.mode = 'unknown';
    this.seq = 0;
    this.pending = new Map();
  }

  start() {
    return new Promise((resolve) => {
      let settled = false;
      try {
        const worker = new Worker(this.url, { type: 'module' });
        worker.onmessage = (e) => this.handleMessage(e.data);
        worker.onerror = (err) => {
          const message = err && err.message ? err.message : '跨域或 file:// 限制';
          if (!settled) {
            settled = true;
            this.fallback(`Worker 加载失败：${message}`);
            this.rejectAll('worker load error');
            resolve(this.mode);
          } else if (this.mode === 'worker') {
            this.fallback('Worker 运行出错，已切换为主线程计算');
            this.rejectAll('worker error');
          }
        };
        this.worker = worker;
        // 发一个 ping，确认 module worker 真正可用（import 成功）
        this.run('ping').then(() => {
          if (!settled) {
            settled = true;
            this.mode = 'worker';
            resolve(this.mode);
          }
        }).catch(() => {
          if (!settled) {
            settled = true;
            this.fallback('Worker 无响应，已切换为主线程计算');
            resolve(this.mode);
          }
        });
        // 兜底超时：极端情况下 ping 既无响应也无 error 事件
        setTimeout(() => {
          if (!settled) {
            settled = true;
            this.fallback('Worker 启动超时（3s）');
            this.rejectAll('worker timeout');
            resolve(this.mode);
          }
        }, 3000);
      } catch (err) {
        if (!settled) {
          settled = true;
          this.fallback(`当前浏览器不支持 module Worker：${err.message}`);
          resolve(this.mode);
        }
      }
    });
  }

  fallback(reason) {
    if (this.mode === 'main') return;
    if (this.worker) { try { this.worker.terminate(); } catch { /* noop */ } }
    this.worker = null;
    this.mode = 'main';
    toast(`${reason}，计算改在主线程执行`, 'error', 3600);
  }

  rejectAll(reason) {
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
  }

  handleMessage(data) {
    const job = this.pending.get(data.id);
    if (!job) return;
    this.pending.delete(data.id);
    if (data.ok) job.resolve(data);
    else job.reject(new Error(data.error || 'Worker 任务失败'));
  }

  /** 发送任务；worker 不可用时本地同步执行并包装成相同返回结构 */
  run(type, payload = {}) {
    const id = ++this.seq;
    const started = performance.now();

    if (this.mode === 'main') {
      return Promise.resolve(this.runLocal(type, payload)).then((res) => ({
        ...res, id, type, ok: true, elapsed: performance.now() - started,
      }));
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, ...payload });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  runLocal(type, msg) {
    if (type === 'ping') return { pong: true };
    if (type === 'contrast') {
      const ratio = contrastRatio(msg.fg, msg.bg);
      return {
        ratio,
        grades: ratio == null ? null : {
          aaNormal: wcagGrade(ratio, 'AA', 'normal'),
          aaaNormal: wcagGrade(ratio, 'AAA', 'normal'),
          aaLarge: wcagGrade(ratio, 'AA', 'large'),
          aaaLarge: wcagGrade(ratio, 'AAA', 'large'),
        },
      };
    }
    if (type === 'contrast-batch') {
      return {
        results: (msg.colors || []).map((c) => {
          const ratio = contrastRatio(msg.fg, c);
          return ratio == null ? null : {
            hex: typeof c === 'string' ? c.toUpperCase() : null,
            ratio,
            aaNormal: wcagGrade(ratio, 'AA', 'normal'),
          };
        }),
      };
    }
    if (type === 'extract') return { palette: extractPalette(msg.data, msg.count || 6) };
    throw new Error(`未知任务类型: ${type}`);
  }
}

const client = new WorkerClient(new URL('../workers/color.worker.js', import.meta.url));

/* ============================================================
 * 全局状态
 * ========================================================== */
const state = {
  current: [59, 130, 246],          // 当前取色
  palette: [],                      // [{hex, rgb}]
  imageBitmap: null,               // 已解码图片
  objectUrl: null,
  picking: false,                  // 图片取色模式（鼠标在画布上）
  dragPointerId: null,
};

const MAX_PALETTE = 60;

/* ============================================================
 * Toast/全局错误
 * ========================================================== */
window.addEventListener('unhandledrejection', (e) => {
  toast(`操作失败：${(e.reason && e.reason.message) || e.reason || '未知错误'}`, 'error');
});
window.addEventListener('error', (e) => {
  if (e.message) toast(`发生错误：${e.message}`, 'error');
});

/* ============================================================
 * 能力检测
 * ========================================================== */
const hasEyeDropper = typeof window.EyeDropper !== 'undefined';
const edBadge = $('eyedropper-support');
if (hasEyeDropper) {
  setBadge(edBadge, 'EyeDropper 可用', 'ok');
} else {
  setBadge(edBadge, 'EyeDropper 不可用（用图片/原生色块）', 'warn');
  $('btn-screen-pick').disabled = true;
  $('btn-screen-pick').title = '当前浏览器不支持 EyeDropper API（需 Chrome/Edge 95+，HTTPS 或 localhost）';
}

/* ============================================================
 * 屏幕取色（EyeDropper API）
 * ========================================================== */
$('btn-screen-pick').addEventListener('click', async () => {
  if (!hasEyeDropper) {
    toast('当前浏览器不支持 EyeDropper，请改用图片取色或下方原生色块', 'error');
    return;
  }
  try {
    const result = await new window.EyeDropper().open();
    const rgb = parseColor(result.sRGBHex);
    if (!rgb) throw new Error('取色结果无法解析');
    setCurrentColor(rgb, { fromScreen: true });
    toast(`取色成功：${toHex(rgb)}`, 'success');
  } catch (err) {
    // 用户按 Esc 取消时 EyeDropper 会 reject AbortError，属于正常情况
    if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) {
      toast('已取消取色');
    } else {
      toast(`屏幕取色失败：${err.message || err}`, 'error');
    }
  }
});

/* 原生色块兜底 */
$('native-color').addEventListener('input', (e) => {
  const rgb = parseColor(e.target.value);
  if (rgb) setCurrentColor(rgb, { fromScreen: true });
});

/* ============================================================
 * 当前颜色的展示与交互
 * ========================================================== */
function setCurrentColor(rgb, meta = {}) {
  state.current = rgb;
  const hex = toHex(rgb);
  $('current-swatch').style.background = hex;
  $('current-hex').value = hex;
  $('current-rgb').textContent = toRgbString(rgb);
  if (meta.x !== undefined) {
    $('sample-coord').textContent = `坐标 (${meta.x}, ${meta.y}) · ${meta.fromScreen ? '屏幕取色' : '画布取色'}`;
  } else if (meta.fromScreen) {
    $('sample-coord').textContent = '屏幕取色';
  }
}

$('current-hex').addEventListener('change', () => {
  const rgb = parseColor($('current-hex').value);
  if (!rgb) {
    toast('无法识别的颜色，请输入 #RRGGBB 或 rgb(r, g, b)', 'error');
    $('current-hex').value = toHex(state.current);
    return;
  }
  setCurrentColor(rgb);
});

$('btn-copy-hex').addEventListener('click', async () => {
  await copyText(toHex(state.current), 'HEX 已复制');
});

$('btn-add-current').addEventListener('click', () => addToPalette(state.current));

async function copyText(text, okMsg) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // 非安全上下文（如 file://）兜底
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('execCommand copy 返回 false');
    }
    toast(okMsg || '已复制', 'success');
  } catch (err) {
    toast(`复制失败：${err.message}，请手动选择文本`, 'error');
  }
}

/* ============================================================
 * 图片载入：文件选择 / 拖拽 / 粘贴
 * ========================================================== */
const canvas = $('image-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const loupe = $('loupe');
const lctx = loupe.getContext('2d');
const LOUPE_PX = 10;  // 每个源像素在放大镜中占 10px（11x11 邻域 => 110px）
lctx.imageSmoothingEnabled = false;

const dropZone = $('drop-zone');

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) loadImageFile(file);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragging');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
  })
);
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadImageFile(file);
  else toast('拖入的内容里没有图片文件', 'error');
});

window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) loadImageFile(file);
      return;
    }
  }
});

async function loadImageFile(file) {
  if (!file.type || !file.type.startsWith('image/')) {
    toast('请选择图片文件（PNG / JPG / WebP 等）', 'error');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    toast('图片过大（>50MB），可能影响性能', 'error');
    return;
  }
  try {
    let bitmap;
    if (typeof createImageBitmap === 'function') {
      // 浏览器会根据 EXIF 自动校正方向（imageOrientation: from-image）
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } else {
      bitmap = await decodeViaImageElement(file);
    }
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    state.imageBitmap = bitmap;
    drawImageToCanvas(bitmap);
    $('canvas-empty').style.display = 'none';
    $('btn-extract').disabled = false;
    toast(`图片已载入（${bitmap.width}×${bitmap.height}）`, 'success');
  } catch (err) {
    toast(`图片载入失败：${err.message || '文件可能已损坏或格式不受支持'}`, 'error', 3600);
  }
}

function decodeViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight, _img: img });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

function drawImageToCanvas(bitmap) {
  const maxW = 960;
  const scale = bitmap.width > maxW ? maxW / bitmap.width : 1;
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const source = bitmap._img || bitmap;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
}

/* ============================================================
 * 画布取色：放大镜 + 单像素读取
 * ========================================================== */
const LOUPE_GRID = 11; // 取 11x11 邻域，中心像素为取色点（边缘自动裁剪）

function canvasPosFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height);
  return { x, y };
}

function samplePixel(x, y) {
  // 只读 1×1 区域，避免整图 getImageData 的拷贝开销
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}

canvas.addEventListener('pointerenter', (e) => {
  if (!state.imageBitmap) return;
  state.picking = true;
  loupe.hidden = false;
  canvas.setPointerCapture(e.pointerId);
  state.dragPointerId = e.pointerId;
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.picking || !state.imageBitmap) return;
  const { x, y } = canvasPosFromEvent(e);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;

  const half = (LOUPE_GRID - 1) / 2;
  const sx = Math.min(Math.max(x - half, 0), canvas.width - LOUPE_GRID);
  const sy = Math.min(Math.max(y - half, 0), canvas.height - LOUPE_GRID);
  const patch = ctx.getImageData(
    Math.max(sx, 0), Math.max(sy, 0),
    Math.min(LOUPE_GRID, canvas.width - Math.max(sx, 0)),
    Math.min(LOUPE_GRID, canvas.height - Math.max(sy, 0))
  );

  lctx.clearRect(0, 0, loupe.width, loupe.height);
  const tile = LOUPE_PX;
  for (let py = 0; py < patch.height; py++) {
    for (let px = 0; px < patch.width; px++) {
      const o = (py * patch.width + px) * 4;
      lctx.fillStyle = `rgb(${patch.data[o]},${patch.data[o + 1]},${patch.data[o + 2]})`;
      lctx.fillRect(px * tile, py * tile, tile, tile);
    }
  }
  // 中心十字标记（图片边缘邻域被裁剪时，按取色点在邻域中的实际位置画）
  const cx = x - Math.max(sx, 0);
  const cy = y - Math.max(sy, 0);
  lctx.strokeStyle = 'rgba(255,255,255,0.9)';
  lctx.lineWidth = 1;
  lctx.strokeRect(cx * tile + 0.5, cy * tile + 0.5, tile, tile);
  lctx.strokeStyle = 'rgba(0,0,0,0.6)';
  lctx.strokeRect(cx * tile + 2.5, cy * tile + 2.5, tile - 4, tile - 4);

  // 放大镜跟随，但避免超出容器
  const zoneRect = dropZone.getBoundingClientRect();
  const cRect = canvas.getBoundingClientRect();
  let lx = e.clientX - cRect.left + 18;
  let ly = e.clientY - cRect.top + 18;
  if (lx + 114 > cRect.width) lx = e.clientX - cRect.left - 128;
  if (ly + 114 > cRect.height) ly = e.clientY - cRect.top - 128;
  loupe.style.left = `${Math.max(4, lx)}px`;
  loupe.style.top = `${Math.max(4, ly)}px`;

  const rgb = samplePixel(x, y);
  setCurrentColor(rgb, { x, y });
});

canvas.addEventListener('pointerdown', (e) => {
  if (!state.imageBitmap) return;
  const { x, y } = canvasPosFromEvent(e);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const rgb = samplePixel(x, y);
  setCurrentColor(rgb, { x, y });
  toast(`已取色 ${toHex(rgb)}（点击「加入色板」保存）`, 'success', 1800);
});

function endPicking() {
  state.picking = false;
  loupe.hidden = true;
}
canvas.addEventListener('pointerup', (e) => {
  if (state.dragPointerId === e.pointerId) {
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    state.dragPointerId = null;
  }
});
canvas.addEventListener('pointerleave', endPicking);
canvas.addEventListener('pointercancel', endPicking);

/* ============================================================
 * 主色提取（Worker 执行中位切分，带耗时统计）
 * ========================================================== */
$('btn-extract').addEventListener('click', async () => {
  if (!state.imageBitmap) {
    toast('请先载入图片', 'error');
    return;
  }
  const btn = $('btn-extract');
  btn.disabled = true;
  $('extract-meta').textContent = '提取中…';
  try {
    // 使用显示画布的像素（已限制宽度，数据量可控），拷贝到 Worker
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const res = await client.run('extract', {
      data: imageData.data,
      count: 6,
    });
    if (!res.palette.length) {
      toast('没有可提取的颜色（图片可能完全透明）', 'error');
    } else {
      res.palette.forEach((c) => addToPalette(c.rgb, { silent: true }));
      renderPalette();
      const top = res.palette[0];
      toast(`提取出 ${res.palette.length} 个主色，主色 ${top.hex}`, 'success');
    }
    updatePerf('主色提取', res.elapsed, imageData.data.length);
    $('extract-meta').textContent =
      `${canvas.width}×${canvas.height}，${(imageData.data.length / 1024).toFixed(0)}KB，耗时 ${res.elapsed.toFixed(1)}ms`;
  } catch (err) {
    toast(`主色提取失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ============================================================
 * 色板
 * ========================================================== */
function addToPalette(rgb, opts = {}) {
  const hex = toHex(rgb);
  if (state.palette.some((c) => c.hex === hex)) {
    if (!opts.silent) toast(`色板中已存在 ${hex}`, 'info');
    return;
  }
  if (state.palette.length >= MAX_PALETTE) {
    toast(`色板最多 ${MAX_PALETTE} 色，请先删除部分颜色`, 'error');
    return;
  }
  state.palette.push({ hex, rgb });
  renderPalette();
  scheduleBatchContrast();
  if (!opts.silent) toast(`已加入色板 ${hex}`, 'success', 1600);
}

function removeFromPalette(hex) {
  state.palette = state.palette.filter((c) => c.hex !== hex);
  renderPalette();
  scheduleBatchContrast();
}

function renderPalette() {
  const list = $('palette-list');
  $('palette-count').textContent = `${state.palette.length} 色`;
  $('palette-empty').style.display = state.palette.length ? 'none' : 'block';
  list.innerHTML = '';

  state.palette.forEach((c) => {
    const textRgb = bestTextColor(c.rgb);
    const li = document.createElement('li');
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.title = '设为前景色；Shift+点击设为背景色';
    chip.innerHTML = `
      <span class="chip-swatch" style="background:${c.hex}"></span>
      <span class="chip-meta" style="color:rgb(${textRgb.join(',')});background:${c.hex}">
        <span class="chip-hex">${c.hex}</span>
        <span class="chip-ratio" data-ratio="${c.hex}">对比度 …</span>
      </span>
      <span class="chip-del" data-del="${c.hex}">删除</span>`;
    chip.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.del) return;
      if (e.shiftKey) setPairColor('bg', c.rgb);
      else setPairColor('fg', c.rgb);
    });
    li.appendChild(chip);

    // 删除按钮是 chip 的子节点，单独拦截
    chip.querySelector('.chip-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromPalette(c.hex);
    });
    list.appendChild(li);
  });
}

$('btn-clear').addEventListener('click', () => {
  if (!state.palette.length) {
    toast('色板已经是空的');
    return;
  }
  state.palette = [];
  renderPalette();
  toast('色板已清空');
});

/* ============================================================
 * 对比度面板
 * ========================================================== */
const fgInput = $('fg-color');
const bgInput = $('bg-color');

function setPairColor(which, rgb) {
  const input = which === 'fg' ? fgInput : bgInput;
  input.value = toHex(rgb).toLowerCase();
  updateContrast();
}

fgInput.addEventListener('input', () => updateContrast());
bgInput.addEventListener('input', () => updateContrast());
$('btn-swap').addEventListener('click', () => {
  const tmp = fgInput.value;
  fgInput.value = bgInput.value;
  bgInput.value = tmp;
  updateContrast();
});

function setDot(id, pass) {
  const el = $(id);
  el.classList.toggle('pass', !!pass);
  el.classList.toggle('fail', !pass);
}

async function updateContrast() {
  const fg = parseColor(fgInput.value);
  const bg = parseColor(bgInput.value);
  $('fg-hex').textContent = fg ? toHex(fg) : '—';
  $('bg-hex').textContent = bg ? toHex(bg) : '—';
  if (!fg || !bg) {
    $('ratio-number').textContent = '—';
    $('ratio-grade').textContent = '颜色无效';
    return;
  }

  const preview = $('contrast-preview');
  preview.style.background = toHex(bg);
  preview.style.color = toHex(fg);

  try {
    const res = await client.run('contrast', { fg, bg });
    const { ratio, grades } = res;
    $('ratio-number').textContent = ratio.toFixed(2);
    const best = grades.aaaNormal ? 'AAA 普通文字'
      : grades.aaNormal ? 'AA 普通文字'
      : grades.aaLarge ? 'AA 大号文字'
      : '不达标';
    $('ratio-grade').textContent = `最高达标：${best}`;
    setDot('g-aa-normal', grades.aaNormal);
    setDot('g-aaa-normal', grades.aaaNormal);
    setDot('g-aa-large', grades.aaLarge);
    setDot('g-aaa-large', grades.aaaLarge);
    updatePerf('对比度', res.elapsed);
  } catch (err) {
    $('ratio-number').textContent = '—';
    $('ratio-grade').textContent = '计算失败';
    toast(`对比度计算失败：${err.message}`, 'error');
  }
}

/* 色板各色对当前前景的对比度（防抖批处理，一次 Worker 调用） */
let batchTimer = null;
function scheduleBatchContrast() {
  clearTimeout(batchTimer);
  batchTimer = setTimeout(runBatchContrast, 120);
}

async function runBatchContrast() {
  if (!state.palette.length) return;
  const fg = parseColor(fgInput.value);
  if (!fg) return;
  try {
    const res = await client.run('contrast-batch', {
      fg,
      colors: state.palette.map((c) => c.rgb),
    });
    res.results.forEach((r, i) => {
      if (!r) return;
      const el = document.querySelector(`[data-ratio="${state.palette[i].hex}"]`);
      if (!el) return;
      el.textContent = `对前景 ${r.ratio.toFixed(2)}${r.aaNormal ? ' ✓AA' : ''}`;
      el.classList.toggle('pass', r.aaNormal);
      el.classList.toggle('fail', !r.aaNormal);
    });
    updatePerf(`批量对比度 ×${state.palette.length}`, res.elapsed);
  } catch (err) {
    toast(`色板对比度刷新失败：${err.message}`, 'error');
  }
}
fgInput.addEventListener('input', scheduleBatchContrast);

function updatePerf(task, elapsed, bytes) {
  $('perf-worker').textContent = client.mode === 'worker' ? 'Web Worker（后台线程）' : '主线程兜底';
  $('perf-task').textContent = task + (bytes ? ` · ${(bytes / 1024).toFixed(0)}KB` : '');
  $('perf-time').textContent = `${elapsed.toFixed(2)} ms`;
}

/* ============================================================
 * 导出：JSON / CSS 变量 / PNG 色卡
 * ========================================================== */
function buildExportData() {
  const fg = parseColor(fgInput.value);
  const bg = parseColor(bgInput.value);
  const ratio = fg && bg ? contrastRatio(fg, bg) : null;
  return {
    exportedAt: new Date().toISOString(),
    foreground: fg ? toHex(fg) : null,
    background: bg ? toHex(bg) : null,
    contrastRatio: ratio,
    wcag: ratio == null ? null : {
      aaNormal: wcagGrade(ratio, 'AA', 'normal'),
      aaaNormal: wcagGrade(ratio, 'AAA', 'normal'),
      aaLarge: wcagGrade(ratio, 'AA', 'large'),
      aaaLarge: wcagGrade(ratio, 'AAA', 'large'),
    },
    colors: state.palette.map((c, i) => ({
      name: `color-${i + 1}`,
      hex: c.hex,
      rgb: { r: c.rgb[0], g: c.rgb[1], b: c.rgb[2] },
    })),
  };
}

function buildCss(data) {
  const lines = [
    '/* 由取色器工具导出 */',
    `/* 导出时间 ${data.exportedAt} */`,
    ':root {',
  ];
  if (data.foreground) lines.push(`  --color-foreground: ${data.foreground};`);
  if (data.background) lines.push(`  --color-background: ${data.background};`);
  data.colors.forEach((c) => lines.push(`  --${c.name}: ${c.hex};`));
  lines.push('}');
  if (data.contrastRatio != null) {
    lines.push(`/* 前/背景对比度：${data.contrastRatio.toFixed(2)}:1 */`);
  }
  return lines.join('\n');
}

function stampName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `palette-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('btn-export-json').addEventListener('click', () => {
  if (!guardPalette()) return;
  const blob = new Blob([JSON.stringify(buildExportData(), null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  downloadBlob(blob, stampName('json'));
  toast('JSON 已导出', 'success');
});

$('btn-export-css').addEventListener('click', () => {
  if (!guardPalette()) return;
  const blob = new Blob([buildCss(buildExportData())], { type: 'text/css;charset=utf-8' });
  downloadBlob(blob, stampName('css'));
  toast('CSS 变量已导出', 'success');
});

$('btn-copy-json').addEventListener('click', async () => {
  if (!guardPalette()) return;
  await copyText(JSON.stringify(buildExportData(), null, 2), 'JSON 已复制到剪贴板');
});

$('btn-copy-css').addEventListener('click', async () => {
  if (!guardPalette()) return;
  await copyText(buildCss(buildExportData()), 'CSS 变量已复制到剪贴板');
});

function guardPalette() {
  if (!state.palette.length) {
    toast('色板为空，没有可导出的颜色', 'error');
    return false;
  }
  return true;
}

/* PNG 色卡：Canvas 离屏渲染后 toBlob 下载 */
$('btn-export-png').addEventListener('click', () => {
  if (!guardPalette()) return;
  try {
    const pad = 24;
    const sw = 180;
    const sh = 120;
    const cols = Math.min(state.palette.length, 4);
    const rows = Math.ceil(state.palette.length / cols);
    const headerH = 56;
    const w = pad * 2 + cols * sw;
    const h = headerH + pad + rows * (sh + 40) + pad;

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, w, h);
    octx.fillStyle = '#111111';
    octx.font = 'bold 22px sans-serif';
    octx.fillText('Color Palette', pad, 36);

    state.palette.forEach((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = pad + col * sw;
      const y = headerH + pad + row * (sh + 40);
      octx.fillStyle = c.hex;
      octx.fillRect(x, y, sw - 12, sh);
      octx.strokeStyle = 'rgba(0,0,0,0.15)';
      octx.strokeRect(x + 0.5, y + 0.5, sw - 13, sh);
      octx.fillStyle = '#111111';
      octx.font = '14px ui-monospace, Menlo, Consolas, monospace';
      octx.fillText(c.hex, x, y + sh + 20);
      octx.fillStyle = '#666666';
      octx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      octx.fillText(toRgbString(c.rgb), x, y + sh + 36);
    });

    off.toBlob((blob) => {
      if (!blob) {
        toast('PNG 生成失败（toBlob 返回空）', 'error');
        return;
      }
      downloadBlob(blob, stampName('png'));
      toast('PNG 色卡已导出', 'success');
    }, 'image/png');
  } catch (err) {
    toast(`PNG 导出失败：${err.message}`, 'error');
  }
});

/* ============================================================
 * 初始化
 * ========================================================== */
(async function init() {
  setCurrentColor(state.current);

  // 必须先启动 Worker：启动前 worker 尚不存在，任何 run() 都会失败
  const mode = await client.start();
  const wBadge = $('worker-status');
  if (mode === 'worker') {
    setBadge(wBadge, 'Web Worker 已启用', 'ok');
  } else {
    setBadge(wBadge, 'Worker 不可用 · 主线程兜底', 'warn');
  }
  $('perf-worker').textContent = mode === 'worker' ? 'Web Worker（后台线程）' : '主线程兜底';
  updateContrast();
  scheduleBatchContrast();
})();
