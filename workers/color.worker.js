/**
 * 颜色计算 Web Worker（module worker）。
 * 主线程把耗时任务发到这里：
 *  - contrast：单对比对
 *  - contrast-batch：一个前景色对多个背景色（色板列表实时刷新）
 *  - extract：中位切分主色提取（大图像素处理）
 * 所有结果都带回 id，与主线程的请求一一对应。
 */
import { contrastRatio, wcagGrade, extractPalette } from '../js/color-utils.js';

self.onmessage = (e) => {
  const msg = e.data || {};
  const { id, type } = msg;
  const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  try {
    if (type === 'ping') {
      self.postMessage({ id, type, ok: true, pong: true, elapsed: 0 });
      return;
    }

    if (type === 'contrast') {
      const ratio = contrastRatio(msg.fg, msg.bg);
      self.postMessage({
        id, type, ok: true, ratio,
        grades: ratio == null ? null : {
          aaNormal: wcagGrade(ratio, 'AA', 'normal'),
          aaaNormal: wcagGrade(ratio, 'AAA', 'normal'),
          aaLarge: wcagGrade(ratio, 'AA', 'large'),
          aaaLarge: wcagGrade(ratio, 'AAA', 'large'),
        },
        elapsed: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
      });
      return;
    }

    if (type === 'contrast-batch') {
      const results = (msg.colors || []).map((c) => {
        const ratio = contrastRatio(msg.fg, c);
        return ratio == null ? null : {
          hex: typeof c === 'string' ? c.toUpperCase() : null,
          ratio,
          aaNormal: wcagGrade(ratio, 'AA', 'normal'),
        };
      });
      self.postMessage({
        id, type, ok: true, results,
        elapsed: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
      });
      return;
    }

    if (type === 'extract') {
      if (!(msg.data instanceof Uint8ClampedArray) && !(msg.data instanceof Uint8Array)) {
        throw new Error('主色提取需要 RGBA 像素数据');
      }
      const palette = extractPalette(msg.data, msg.count || 6);
      self.postMessage({
        id, type, ok: true, palette,
        elapsed: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
      });
      return;
    }

    throw new Error(`未知任务类型: ${type}`);
  } catch (err) {
    self.postMessage({
      id, type, ok: false,
      error: (err && err.message) || String(err),
      elapsed: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
    });
  }
};
