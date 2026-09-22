/*
 * app.js — 主线程逻辑
 * 取色：Canvas 像素直读（放大镜）+ EyeDropper API（屏幕取色）
 * 对比度：WCAG 相对亮度（color-utils.js）
 * 性能：Web Worker + ImageBitmap 转移做调色板分析，主线程仅负责轻量像素读取
 * 异常：所有用户操作均有 try/catch 与 Toast 提示，Worker 失败时回退主线程
 */
(function () {
  'use strict';

  const CU = window.ColorUtils;
  const MAX_FILE_BYTES = 30 * 1024 * 1024;
  const LOUPE_RADIUS = 7; // 放大镜半径（像素，原图坐标），15x15 区域
  const WORKER_TIMEOUT_MS = 15000;

  const els = {
    fileInput: document.getElementById('fileInput'),
    eyedropperBtn: document.getElementById('eyedropperBtn'),
    analyzeBtn: document.getElementById('analyzeBtn'),
    workerStatus: document.getElementById('workerStatus'),
    dropZone: document.getElementById('dropZone'),
    dropHint: document.getElementById('dropHint'),
    canvas: document.getElementById('canvas'),
    loupe: document.getElementById('loupe'),
    pixelInfo: document.getElementById('pixelInfo'),
    currentSwatch: document.getElementById('currentSwatch'),
    currentHex: document.getElementById('currentHex'),
    currentRgb: document.getElementById('currentRgb'),
    currentPos: document.getElementById('currentPos'),
    addCurrentBtn: document.getElementById('addCurrentBtn'),
    fgColor: document.getElementById('fgColor'),
    fgText: document.getElementById('fgText'),
    bgColor: document.getElementById('bgColor'),
    bgText: document.getElementById('bgText'),
    swapBtn: document.getElementById('swapBtn'),
    contrastPreview: document.getElementById('contrastPreview'),
    ratioNumber: document.getElementById('ratioNumber'),
    badgeAaNormal: document.getElementById('badgeAaNormal'),
    badgeAaLarge: document.getElementById('badgeAaLarge'),
    badgeAaaNormal: document.getElementById('badgeAaaNormal'),
    badgeAaaLarge: document.getElementById('badgeAaaLarge'),
    exportFormat: document.getElementById('exportFormat'),
    exportBtn: document.getElementById('exportBtn'),
    exportImageBtn: document.getElementById('exportImageBtn'),
    clearBtn: document.getElementById('clearBtn'),
    colorList: document.getElementById('colorList'),
    listCount: document.getElementById('listCount'),
    toastContainer: document.getElementById('toastContainer'),
  };

  const state = {
    ctx: null,
    image: null,
    imageName: '',
    imageWidth: 0,
    imageHeight: 0,
    current: null,
    colors: [],
    seq: 0,
  };

  /* ---------- Toast 异常/状态提示 ---------- */
  function toast(message, level) {
    const node = document.createElement('div');
    node.className = 'toast ' + (level || 'info');
    node.textContent = message;
    els.toastContainer.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .25s';
      setTimeout(() => node.remove(), 260);
    }, 3600);
  }

  window.addEventListener('error', (e) => {
    toast('发生错误：' + (e.message || '未知错误'), 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    toast('操作失败：' + reason, 'error');
  });

  /* ---------- Web Worker：带超时与主线程回退 ---------- */
  let worker = null;
  let workerUsable = false;

  function initWorker() {
    if (worker) return worker;
    try {
      worker = new Worker('js/image-worker.js');
      let erroredOnce = false;
      worker.addEventListener('error', (e) => {
        // 脚本加载失败通常会立即报一次；运行期错误由消息 ok:false 处理
        if (!erroredOnce) {
          erroredOnce = true;
          els.workerStatus.textContent = 'Worker 异常，本次已回退主线程';
          toast('Web Worker 异常：' + (e.message || '未知错误') + '，本次改用主线程分析', 'warn');
        }
      });
      workerUsable = true;
      els.workerStatus.textContent = 'Worker 就绪';
    } catch (err) {
      worker = null;
      workerUsable = false;
      els.workerStatus.textContent = 'Worker 不可用，已回退主线程';
    }
    return worker;
  }

  function analyzeInWorker(bitmap) {
    return new Promise((resolve, reject) => {
      const w = initWorker();
      if (!w || !workerUsable) {
        fallbackAnalyze(bitmap).then(resolve, reject);
        return;
      }
      const id = 'a' + Date.now() + Math.random().toString(36).slice(2, 7);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Worker 分析超时（' + WORKER_TIMEOUT_MS + 'ms），已改用主线程'));
      }, WORKER_TIMEOUT_MS);

      function cleanup() {
        clearTimeout(timer);
        w.removeEventListener('message', onMsg);
      }
      function onMsg(e) {
        const msg = e.data;
        if (!msg || msg.id !== id) return;
        cleanup();
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || 'Worker 分析失败'));
      }
      w.addEventListener('message', onMsg);
      try {
        w.postMessage({
          type: 'analyze',
          id,
          bitmap,
          options: { count: 8, background: { r: 255, g: 255, b: 255 } },
        }, [bitmap]);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  function fallbackAnalyze(bitmap) {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        const maxPixels = 1_200_000;
        const total = bitmap.width * bitmap.height;
        const step = Math.max(1, Math.ceil(Math.sqrt(total / maxPixels)));
        const palette = window.Quantize.medianCut(imageData.data, { count: 8, step });
        const average = window.Quantize.averageColor(imageData.data);
        resolve({ palette, average, step, width: bitmap.width, height: bitmap.height, sampleSize: total });
      } catch (err) {
        reject(err);
      }
    });
  }

  /* ---------- 图片加载 ---------- */
  async function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('文件类型不支持，请选择图片文件（PNG / JPG / WebP / GIF / BMP）', 'error');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast('图片过大（' + (file.size / 1024 / 1024).toFixed(1) + 'MB），上限 30MB', 'error');
      return;
    }
    els.pixelInfo.textContent = '正在加载图片…';
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      toast('图片解码失败，文件可能已损坏或格式不受支持：' + err.message, 'error');
      els.pixelInfo.textContent = '图片加载失败';
      return;
    }
    if (!bitmap || bitmap.width === 0 || bitmap.height === 0) {
      toast('图片尺寸无效', 'error');
      return;
    }

    state.imageName = file.name.replace(/\.[^.]+$/, '') || 'image';
    state.imageWidth = bitmap.width;
    state.imageHeight = bitmap.height;
    els.canvas.width = bitmap.width;
    els.canvas.height = bitmap.height;
    state.ctx = els.canvas.getContext('2d', { willReadFrequently: true });
    state.ctx.drawImage(bitmap, 0, 0);
    els.canvas.hidden = false;
    els.dropHint.hidden = true;
    els.eyedropperBtn.disabled = false;
    els.analyzeBtn.disabled = false;
    els.exportImageBtn.disabled = false;
    els.pixelInfo.textContent =
      '尺寸 ' + bitmap.width + ' × ' + bitmap.height + ' · 移动放大镜取色，点击加入列表';

    try {
      const result = await analyzeWithFallback(bitmap);
      addPaletteColors(result.palette);
      toast(
        '分析完成：' + bitmap.width + '×' + bitmap.height +
        (result.step > 1 ? '，抽样步长 ' + result.step : '') +
        (workerUsable ? '（Worker）' : '（主线程）'),
        'success'
      );
    } catch (err) {
      toast('调色板分析失败：' + err.message + '，仍可手动取色', 'warn');
    } finally {
      // bitmap 所有权已在分析时转移；失败回退路径中的副本由 fallback 自行管理
    }
  }

  async function analyzeWithFallback(bitmap) {
    try {
      return await analyzeInWorker(bitmap);
    } catch (err) {
      toast(err.message + '，正在重试…', 'warn');
      // bitmap 所有权可能已转移到失败的 worker，需要从 canvas 重建
      const rebuilt = await bitmapFromCanvas();
      return fallbackAnalyze(rebuilt);
    }
  }

  function bitmapFromCanvas() {
    return new Promise((resolve, reject) => {
      els.canvas.toBlob(async (blob) => {
        if (!blob) { reject(new Error('画布数据不可用')); return; }
        try { resolve(await createImageBitmap(blob)); }
        catch (e) { reject(e); }
      });
    });
  }

  function addPaletteColors(palette) {
    const existing = new Set(state.colors.map((c) => c.hex));
    let added = 0;
    palette.forEach((p) => {
      const hex = CU.toHex(p.r, p.g, p.b);
      if (existing.has(hex)) return;
      existing.add(hex);
      addColor({ r: p.r, g: p.g, b: p.b }, '调色板', true);
      added++;
    });
    return added;
  }

  /* ---------- Canvas 放大镜取色 ---------- */
  function eventToImagePixel(ev) {
    const rect = els.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.floor((ev.clientX - rect.left) * (els.canvas.width / rect.width));
    const y = Math.floor((ev.clientY - rect.top) * (els.canvas.height / rect.height));
    if (x < 0 || y < 0 || x >= els.canvas.width || y >= els.canvas.height) return null;
    return { x, y };
  }

  function readPixel(x, y) {
    try {
      const d = state.ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    } catch (err) {
      toast('读取像素失败：' + err.message, 'error');
      return null;
    }
  }

  function drawLoupe(x, y) {
    const size = els.loupe.width;
    const span = LOUPE_RADIUS * 2 + 1;
    const scale = size / span;
    const lctx = els.loupe.getContext('2d');
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = '#000';
    lctx.fillRect(0, 0, size, size);
    // 边缘裁剪：源窗口与目标偏移同步收缩，取色点始终居中
    const sx = Math.max(0, x - LOUPE_RADIUS);
    const sy = Math.max(0, y - LOUPE_RADIUS);
    const sx2 = Math.min(els.canvas.width, x + LOUPE_RADIUS + 1);
    const sy2 = Math.min(els.canvas.height, y + LOUPE_RADIUS + 1);
    const dx = (sx - (x - LOUPE_RADIUS)) * scale;
    const dy = (sy - (y - LOUPE_RADIUS)) * scale;
    lctx.drawImage(els.canvas, sx, sy, sx2 - sx, sy2 - sy, dx, dy, (sx2 - sx) * scale, (sy2 - sy) * scale);
    // 中心取色点框
    const cx = Math.floor(size / 2);
    lctx.strokeStyle = 'rgba(255,255,255,.9)';
    lctx.lineWidth = 1;
    lctx.strokeRect(cx - scale / 2, cx - scale / 2, scale, scale);
  }

  function setCurrentColor(rgb, pos, source) {
    state.current = { rgb, pos, source };
    renderCurrent(rgb, pos, source);
  }

  function renderCurrent(rgb, pos, source) {
    const hex = CU.toHex(rgb.r, rgb.g, rgb.b);
    els.currentSwatch.style.background = hex;
    els.currentHex.textContent = hex.toUpperCase();
    els.currentRgb.textContent = CU.formatRgb(rgb) + ' · ' + CU.formatHsl(rgb);
    els.currentPos.textContent = pos ? ('坐标 (' + pos.x + ', ' + pos.y + ')' + (source ? ' · ' + source : '')) : (source || '');
    els.addCurrentBtn.disabled = false;
  }

  let loupeRaf = 0;
  els.canvas.addEventListener('mousemove', (ev) => {
    const px = eventToImagePixel(ev);
    if (!px) { els.loupe.hidden = true; return; }
    const rect = els.canvas.getBoundingClientRect();
    const offset = 16;
    let left = ev.clientX - rect.left + offset;
    let top = ev.clientY - rect.top + offset;
    if (left + els.loupe.width > rect.width) left = ev.clientX - rect.left - els.loupe.width - offset;
    if (top + els.loupe.height > rect.height) top = ev.clientY - rect.top - els.loupe.height - offset;
    els.loupe.style.left = Math.max(0, left) + 'px';
    els.loupe.style.top = Math.max(0, top) + 'px';
    els.loupe.hidden = false;

    const rgb = readPixel(px.x, px.y);
    if (!rgb) return;
    els.pixelInfo.textContent = '坐标 (' + px.x + ', ' + px.y + ') · ' +
      CU.toHex(rgb.r, rgb.g, rgb.b).toUpperCase() + ' · 点击加入列表';
    cancelAnimationFrame(loupeRaf);
    loupeRaf = requestAnimationFrame(() => drawLoupe(px.x, px.y));
    state.hover = { rgb, pos: px };
    renderCurrent(rgb, px, null);
  });

  els.canvas.addEventListener('mouseleave', () => {
    els.loupe.hidden = true;
    if (state.current) {
      renderCurrent(state.current.rgb, state.current.pos, state.current.source);
    } else {
      els.currentSwatch.style.background = 'transparent';
      els.currentHex.textContent = '—';
      els.currentRgb.textContent = '未取色';
      els.currentPos.textContent = '';
      els.addCurrentBtn.disabled = true;
    }
  });

  els.canvas.addEventListener('click', (ev) => {
    const px = eventToImagePixel(ev);
    if (!px) return;
    const rgb = readPixel(px.x, px.y);
    if (!rgb) return;
    setCurrentColor(rgb, px, '点击取色');
    const hex = CU.toHex(rgb.r, rgb.g, rgb.b);
    const existed = new Set(state.colors.map((c) => c.hex));
    if (existed.has(hex)) {
      toast(hex.toUpperCase() + ' 已在列表中，已设为前景色', 'info');
    } else {
      addColor(rgb, '点击取色', false);
      toast('已加入：' + hex.toUpperCase(), 'success');
    }
    els.fgColor.value = hex;
    els.fgText.value = hex;
    updateContrast();
  });

  /* ---------- EyeDropper 屏幕取色（带能力检测） ---------- */
  if (!('EyeDropper' in window)) {
    els.eyedropperBtn.title = '当前浏览器不支持 EyeDropper API（需 Chrome/Edge 95+ 安全上下文）';
  }

  els.eyedropperBtn.addEventListener('click', async () => {
    if (!('EyeDropper' in window)) {
      toast('当前浏览器不支持 EyeDropper API，可改用画布放大镜取色', 'warn');
      return;
    }
    try {
      const eyeDropper = new window.EyeDropper();
      const result = await eyeDropper.open();
      const parsed = CU.parseColor(result.sRGBHex);
      if (!parsed) {
        toast('取色器返回了无法识别的颜色：' + result.sRGBHex, 'error');
        return;
      }
      setCurrentColor(parsed, null, 'EyeDropper');
      const eHex = CU.toHex(parsed.r, parsed.g, parsed.b);
      const existed = new Set(state.colors.map((c) => c.hex));
      if (!existed.has(eHex)) addColor(parsed, '屏幕取色', false);
      els.fgColor.value = eHex;
      els.fgText.value = eHex;
      updateContrast();
      toast('屏幕取色成功：' + result.sRGBHex.toUpperCase() +
        (existed.has(eHex) ? '（已存在，已设为前景色）' : ''), 'success');
    } catch (err) {
      // 用户按 Esc 取消时 DOMException name=AbortError，属正常操作，不给错误提示
      if (err && (err.name === 'AbortError' || err.code === 20)) return;
      toast('屏幕取色失败：' + (err.message || err), 'error');
    }
  });

  /* ---------- 颜色列表 ---------- */
  function addColor(rgb, source, quiet) {
    const item = {
      id: ++state.seq,
      hex: CU.toHex(rgb.r, rgb.g, rgb.b),
      rgb: { r: rgb.r, g: rgb.g, b: rgb.b },
      source: source || '手动',
      time: new Date().toISOString(),
    };
    state.colors.push(item);
    renderList();
    if (!quiet) updateButtons();
    return item;
  }

  function removeColor(id) {
    state.colors = state.colors.filter((c) => c.id !== id);
    renderList();
  }

  function clearColors() {
    state.colors = [];
    renderList();
    toast('颜色列表已清空', 'info');
  }

  function renderList() {
    els.colorList.innerHTML = '';
    if (state.colors.length === 0) {
      const tip = document.createElement('li');
      tip.className = 'empty-tip';
      tip.textContent = '暂无颜色：在图片上点击、使用屏幕取色或等待调色板分析';
      els.colorList.appendChild(tip);
    } else {
      state.colors.forEach((c) => {
        const li = document.createElement('li');
        li.className = 'color-item';
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.background = c.hex;
        chip.title = '设为前景色';
        chip.addEventListener('click', () => {
          els.fgColor.value = c.hex;
          els.fgText.value = c.hex;
          updateContrast();
          toast(c.hex.toUpperCase() + ' 已设为前景色', 'info');
        });

        const info = document.createElement('div');
        info.className = 'info';
        const hexLine = document.createElement('div');
        hexLine.className = 'hex';
        hexLine.textContent = c.hex.toUpperCase();
        const subLine = document.createElement('div');
        subLine.className = 'sub';
        subLine.textContent = CU.formatRgb(c.rgb) + ' · ' + c.source;
        info.appendChild(hexLine);
        info.appendChild(subLine);

        const actions = document.createElement('div');
        actions.className = 'actions';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.textContent = '复制';
        copyBtn.addEventListener('click', () => copyText(c.hex.toUpperCase(), 'HEX 已复制'));
        const setBgBtn = document.createElement('button');
        setBgBtn.type = 'button';
        setBgBtn.textContent = '设为背景';
        setBgBtn.addEventListener('click', () => {
          els.bgColor.value = c.hex;
          els.bgText.value = c.hex;
          updateContrast();
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => removeColor(c.id));
        actions.appendChild(copyBtn);
        actions.appendChild(setBgBtn);
        actions.appendChild(delBtn);

        li.appendChild(chip);
        li.appendChild(info);
        li.appendChild(actions);
        els.colorList.appendChild(li);
      });
    }
    els.listCount.textContent = state.colors.length ? '(' + state.colors.length + ')' : '';
    updateButtons();
  }

  function updateButtons() {
    const has = state.colors.length > 0;
    els.exportBtn.disabled = !has;
    els.clearBtn.disabled = !has;
  }

  async function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(okMsg || '已复制', 'success');
    } catch (err) {
      toast('复制失败：' + err.message, 'error');
    }
  }

  /* ---------- 对比度 ---------- */
  const badgeMap = [
    ['badgeAaNormal', 'aaNormal', 'AA 正文'],
    ['badgeAaLarge', 'aaLarge', 'AA 大字'],
    ['badgeAaaNormal', 'aaaNormal', 'AAA 正文'],
    ['badgeAaaLarge', 'aaaLarge', 'AAA 大字'],
  ];

  function syncTextInput(textEl, colorEl) {
    const parsed = CU.parseColor(textEl.value);
    if (!parsed) {
      textEl.classList.add('invalid');
      return null;
    }
    textEl.classList.remove('invalid');
    const hex = CU.toHex(parsed.r, parsed.g, parsed.b);
    colorEl.value = hex;
    return parsed;
  }

  function updateContrast() {
    const fg = syncTextInput(els.fgText, els.fgColor);
    const bg = syncTextInput(els.bgText, els.bgColor);
    if (!fg || !bg) {
      els.ratioNumber.textContent = '—';
      badgeMap.forEach(([id]) => {
        els[id].classList.remove('pass', 'fail');
      });
      return;
    }
    const ratio = CU.contrastRatio(fg, bg);
    const rounded = CU.roundRatio(ratio);
    els.ratioNumber.textContent = rounded.toFixed(2) + ' : 1';
    const grades = CU.wcagGrades(ratio);
    badgeMap.forEach(([id, key]) => {
      const node = els[id];
      node.classList.toggle('pass', !!grades[key]);
      node.classList.toggle('fail', !grades[key]);
    });
    els.contrastPreview.style.color = CU.toHex(fg.r, fg.g, fg.b);
    els.contrastPreview.style.background = CU.toHex(bg.r, bg.g, bg.b);
  }

  [els.fgColor, els.bgColor].forEach((colorEl) => {
    colorEl.addEventListener('input', () => {
      const textEl = colorEl === els.fgColor ? els.fgText : els.bgText;
      textEl.value = colorEl.value;
      updateContrast();
    });
  });
  [els.fgText, els.bgText].forEach((textEl) => {
    textEl.addEventListener('input', updateContrast);
  });
  els.swapBtn.addEventListener('click', () => {
    const f = els.fgText.value;
    els.fgText.value = els.bgText.value;
    els.bgText.value = f;
    const fp = CU.parseColor(els.fgText.value);
    const bp = CU.parseColor(els.bgText.value);
    if (fp) els.fgColor.value = CU.toHex(fp.r, fp.g, fp.b);
    if (bp) els.bgColor.value = CU.toHex(bp.r, bp.g, bp.b);
    updateContrast();
  });

  els.addCurrentBtn.addEventListener('click', () => {
    const picked = state.current ||
      (state.hover ? { rgb: state.hover.rgb, pos: state.hover.pos, source: '悬停取色' } : null);
    if (!picked) return;
    state.current = picked;
    addColor(picked.rgb, picked.source || '手动', false);
    const hex = CU.toHex(picked.rgb.r, picked.rgb.g, picked.rgb.b);
    els.fgColor.value = hex;
    els.fgText.value = hex;
    updateContrast();
    toast('已加入：' + hex.toUpperCase(), 'success');
  });
  els.analyzeBtn.addEventListener('click', async () => {
    try {
      const bitmap = await bitmapFromCanvas();
      const result = await analyzeWithFallback(bitmap);
      const existing = new Set(state.colors.map((c) => c.hex));
      let added = 0;
      result.palette.forEach((p) => {
        const hex = CU.toHex(p.r, p.g, p.b);
        if (existing.has(hex)) return;
        existing.add(hex);
        addColor({ r: p.r, g: p.g, b: p.b }, '重新分析', true);
        added++;
      });
      toast('调色板已追加 ' + added + ' 色（去重后）', 'success');
    } catch (err) {
      toast('重新分析失败：' + err.message, 'error');
    }
  });
  els.clearBtn.addEventListener('click', clearColors);

  /* ---------- 导出 ---------- */
  function buildExportData(format) {
    const items = state.colors.map((c) => ({
      hex: c.hex.toUpperCase(),
      rgb: CU.formatRgb(c.rgb),
      hsl: CU.formatHsl(c.rgb),
      r: c.rgb.r, g: c.rgb.g, b: c.rgb.b,
      source: c.source,
      contrastOnWhite: CU.roundRatio(CU.contrastRatio(c.rgb, { r: 255, g: 255, b: 255 })),
      contrastOnBlack: CU.roundRatio(CU.contrastRatio(c.rgb, { r: 0, g: 0, b: 0 })),
    }));

    if (format === 'json') {
      return {
        content: JSON.stringify({
          exportedAt: new Date().toISOString(),
          image: state.imageName || null,
          size: state.imageWidth ? { width: state.imageWidth, height: state.imageHeight } : null,
          count: items.length,
          colors: items,
        }, null, 2),
        mime: 'application/json',
        ext: 'json',
      };
    }

    if (format === 'css') {
      const lines = [
        '/* 导出自取色工具 ' + new Date().toISOString() + ' */',
        ':root {',
        ...items.map((c, i) => '  --color-' + (i + 1) + ': ' + c.hex + '; /* ' + c.rgb + ' */'),
        '}',
      ];
      return { content: lines.join('\n') + '\n', mime: 'text/css', ext: 'css' };
    }

    // csv
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const rows = [['name', 'hex', 'r', 'g', 'b', 'rgb', 'hsl', 'contrast_white', 'contrast_black', 'source']];
    items.forEach((c, i) => rows.push([
      'color-' + (i + 1), c.hex, c.r, c.g, c.b, c.rgb, c.hsl,
      c.contrastOnWhite, c.contrastOnBlack, c.source,
    ]));
    const csv = rows.map((row) => row.map(esc).join(',')).join('\r\n');
    return { content: '\uFEFF' + csv, mime: 'text/csv;charset=utf-8', ext: 'csv' };
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

  function safeBaseName() {
    return (state.imageName || 'colors').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'colors';
  }

  els.exportBtn.addEventListener('click', () => {
    if (state.colors.length === 0) {
      toast('没有可导出的颜色', 'warn');
      return;
    }
    try {
      const format = els.exportFormat.value;
      const file = buildExportData(format);
      const blob = new Blob([file.content], { type: file.mime });
      downloadBlob(blob, safeBaseName() + '_colors.' + file.ext);
      toast('已导出 ' + state.colors.length + ' 个颜色（.' + file.ext + '）', 'success');
    } catch (err) {
      toast('导出失败：' + err.message, 'error');
    }
  });

  // 导出带调色板标注的 PNG：原图下方拼接色条与 HEX
  els.exportImageBtn.addEventListener('click', () => {
    if (!state.ctx) {
      toast('请先打开图片', 'warn');
      return;
    }
    if (state.colors.length === 0) {
      toast('没有颜色可标注，请先取色', 'warn');
      return;
    }
    let url = null;
    try {
      const src = els.canvas;
      const barH = 96;
      const pad = 12;
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height + barH;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);

      const n = state.colors.length;
      const sw = out.width / n;
      ctx.font = Math.max(11, Math.min(16, Math.floor(sw / 7))) + 'px ui-monospace, Menlo, Consolas, monospace';
      ctx.textBaseline = 'middle';
      state.colors.forEach((c, i) => {
        const x = Math.floor(i * sw);
        ctx.fillStyle = c.hex;
        ctx.fillRect(x, src.height, Math.ceil(sw), barH);
        const fg = CU.bestForeground(c.rgb);
        ctx.fillStyle = CU.toHex(fg.r, fg.g, fg.b);
        const label = c.hex.toUpperCase();
        ctx.fillText(label, x + pad, src.height + barH / 2);
      });

      url = out.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = safeBaseName() + '_annotated.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('标注图已导出', 'success');
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast('标注图导出失败：' + err.message, 'error');
    }
  });

  /* ---------- 文件选择与拖放 ---------- */
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (file) handleFile(file);
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('dragover');
    })
  );
  els.dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  els.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.dropZone.addEventListener('click', (e) => {
    if (e.target === els.canvas) return;
    els.fileInput.click();
  });

  /* ---------- 初始化 ---------- */
  initWorker();
  renderList();
  updateContrast();
})();
