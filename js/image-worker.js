/*
 * image-worker.js
 * 在 Web Worker 中完成大图解码后的像素分析（调色板提取 / 平均色），
 * 避免阻塞主线程，保证交互与放大镜取色流畅。
 */
'use strict';

if (typeof importScripts === 'function') {
  importScripts('color-utils.js', 'quantize.js');
}

// 超大图的采样上限，配合 step 抽样，分析耗时可控
const MAX_ANALYSIS_PIXELS = 1_200_000;

function bitmapToImageData(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return {
    data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
    width: bitmap.width,
    height: bitmap.height,
  };
}

function analyze(bitmap, options) {
  const { data, width, height } = bitmapToImageData(bitmap);
  const totalPixels = width * height;
  const step = Math.max(1, Math.ceil(Math.sqrt(totalPixels / MAX_ANALYSIS_PIXELS)));
  const palette = self.Quantize.medianCut(data, {
    count: options.count,
    step,
    background: options.background,
  });
  const average = self.Quantize.averageColor(data, { background: options.background });
  return { palette, average, step, width, height, sampleSize: data.length / 4 };
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  try {
    if (msg.type !== 'analyze' || !msg.bitmap) {
      throw new Error('无效的分析请求');
    }
    const result = analyze(msg.bitmap, msg.options || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: (err && err.message) || String(err),
    });
  } finally {
    if (msg.bitmap && msg.bitmap.close) {
      // 传输已转移所有权，close 失败可忽略
      try { msg.bitmap.close(); } catch (_) { /* noop */ }
    }
  }
};
