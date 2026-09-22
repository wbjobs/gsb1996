/**
 * 颜色工具：解析、格式化、WCAG 2.1 对比度、中位切分主色提取。
 * 纯函数、无 DOM 依赖，可在主线程与 Web Worker 中复用
 * （ESM / importScripts / CommonJS 三种方式均可加载）。
 */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*(?:,|\s)\s*(\d{1,3})\s*(?:,|\s)\s*(\d{1,3})(?:\s*(?:,|\/)\s*(?:0?\.\d+|0|1|\d{1,3}%))?\s*\)$/i;

/**
 * 解析颜色为 [r,g,b]（0-255 整数）。支持 #rgb / #rrggbb / rgb()/rgba()。
 * @returns {[number,number,number]|null}
 */
export function parseColor(input) {
  if (input == null) return null;
  const str = String(input).trim();
  if (!str) return null;

  const hexMatch = HEX_RE.exec(str);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }

  const rgbMatch = RGB_RE.exec(str);
  if (rgbMatch) {
    const rgb = rgbMatch.slice(1, 4).map(Number);
    if (rgb.every((v) => v >= 0 && v <= 255)) return rgb;
    return null;
  }
  return null;
}

/** [r,g,b] -> #RRGGBB（大写） */
export function toHex(rgb) {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** [r,g,b] -> "r, g, b" */
export function toRgbString(rgb) {
  return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
}

/** sRGB 单通道（0-255）-> 线性分量，WCAG 2.1 定义 */
export function channelLuminance(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** 相对亮度 L（0-1） */
export function relativeLuminance(rgb) {
  const [r, g, b] = rgb;
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/**
 * WCAG 2.1 对比度，1 ~ 21，保留两位小数（截断式四舍五入到 0.01）。
 * @param a 第一色 [r,g,b] 或可解析字符串
 * @param b 第二色 [r,g,b] 或可解析字符串
 */
export function contrastRatio(a, b) {
  const rgbA = typeof a === 'string' ? parseColor(a) : a;
  const rgbB = typeof b === 'string' ? parseColor(b) : b;
  if (!rgbA || !rgbB) return null;
  const la = relativeLuminance(rgbA);
  const lb = relativeLuminance(rgbB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return Math.round(ratio * 100) / 100;
}

/**
 * WCAG 达标判定。
 * @param ratio 对比度
 * @param level 'AA' | 'AAA'
 * @param size 'normal' | 'large'
 */
export function wcagGrade(ratio, level = 'AA', size = 'normal') {
  if (ratio == null) return false;
  const threshold = level === 'AAA'
    ? (size === 'large' ? 4.5 : 7)
    : (size === 'large' ? 3 : 4.5);
  return ratio >= threshold;
}

/** 依据背景亮度返回更易读的文字色（黑/白），用于色卡标注 */
export function bestTextColor(rgb) {
  return relativeLuminance(rgb) > 0.45 ? [17, 17, 17] : [255, 255, 255];
}

/**
 * 中位切分主色提取。
 * @param {Uint8ClampedArray|number[]} data RGBA 像素
 * @param {number} count 需要的主色数量
 * @param {{transparentThreshold?: number, step?: number}} [opts]
 * @returns {Array<{rgb:[number,number,number], hex:string, weight:number}>}
 */
export function extractPalette(data, count = 6, opts = {}) {
  const transparentThreshold = opts.transparentThreshold ?? 8;
  const maxPixels = opts.maxPixels ?? 200000;

  // 像素抽样，避免超大图拖慢 Worker
  const total = Math.floor(data.length / 4);
  const step = total > maxPixels ? Math.ceil(total / maxPixels) : 1;

  const pixels = [];
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    if (data[o + 3] < transparentThreshold) continue; // 跳过近透明像素
    pixels.push([data[o], data[o + 1], data[o + 2]]);
  }
  if (pixels.length === 0) return [];

  // 初始盒子 = 全部像素；反复在最长通道上切分，直到盒子数达到 count
  let boxes = [pixels];
  while (boxes.length < count) {
    let target = -1;
    let maxRange = -1;
    let targetChannel = 0;
    boxes.forEach((box, idx) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let min = 255;
        let max = 0;
        for (const p of box) {
          if (p[c] < min) min = p[c];
          if (p[c] > max) max = p[c];
        }
        const range = max - min;
        if (range > maxRange) {
          maxRange = range;
          target = idx;
          targetChannel = c;
        }
      }
    });

    if (target === -1 || maxRange === 0) break; // 所有盒子都不可再切

    const box = boxes[target];
    box.sort((a, b) => a[targetChannel] - b[targetChannel]);
    const mid = box.length >> 1;
    boxes.splice(target, 1, box.slice(0, mid), box.slice(mid));
  }

  const totalKept = pixels.length;
  const result = boxes
    .map((box) => {
      let r = 0, g = 0, b = 0;
      for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
      const n = box.length || 1;
      const rgb = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      return { rgb, hex: toHex(rgb), weight: n / totalKept, count: n };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, count);

  return result.map(({ rgb, hex, weight }) => ({ rgb, hex, weight }));
}

// 同时支持 importScripts（Worker 兜底加载）与 Node 单元测试
const api = {
  parseColor, toHex, toRgbString, channelLuminance,
  relativeLuminance, contrastRatio, wcagGrade, bestTextColor, extractPalette,
};
if (typeof self !== 'undefined') self.ColorUtils = api;
if (typeof globalThis !== 'undefined') globalThis.ColorUtils = api;
