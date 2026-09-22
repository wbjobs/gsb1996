/*
 * color-utils.js
 * 纯函数字颜色工具：解析 / 格式化 / WCAG 相对亮度与对比度。
 * UMD 形式，同时可在浏览器主线程、Web Worker(importScripts) 与 Node 测试中使用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ColorUtils = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAMED_COLORS = {
    black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0],
    green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
    cyan: [0, 255, 255], magenta: [255, 0, 255], gray: [128, 128, 128],
    grey: [128, 128, 128], orange: [255, 165, 0], pink: [255, 192, 203],
    purple: [128, 0, 128], silver: [192, 192, 192], navy: [0, 0, 128],
  };

  function clamp8(v) {
    v = Math.round(v);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function normalizeHex(hex) {
    if (typeof hex !== 'string') return null;
    let h = hex.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(h)) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (/^[0-9a-f]{6}$/i.test(h)) return h.toLowerCase();
    if (/^[0-9a-f]{8}$/i.test(h)) return h.slice(0, 6).toLowerCase();
    return null;
  }

  /*
   * 将 #hex / rgb()/rgba()/hsl()/hsla()/常见命名色解析为 {r,g,b,a}。
   * 解析失败返回 null（由调用方给出异常提示）。
   */
  function parseColor(input) {
    if (input == null) return null;
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    if (!s) return null;

    const h = normalizeHex(s);
    if (h) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }

    if (NAMED_COLORS[s]) {
      const c = NAMED_COLORS[s];
      return { r: c[0], g: c[1], b: c[2], a: 1 };
    }

    let m = s.match(/^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/);
    if (m) {
      const chan = (tok, isAlpha) => {
        if (tok === undefined) return isAlpha ? 1 : 0;
        if (tok.endsWith('%')) {
          const p = parseFloat(tok) / 100;
          return isAlpha ? Math.min(1, Math.max(0, p)) : clamp8(p * 255);
        }
        const n = parseFloat(tok);
        return isAlpha ? Math.min(1, Math.max(0, n)) : clamp8(n);
      };
      return { r: chan(m[1]), g: chan(m[2]), b: chan(m[3]), a: chan(m[4], true) };
    }

    m = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+)\s*)?\)$/);
    if (m) {
      const hh = (((parseFloat(m[1]) % 360) + 360) % 360) / 360;
      const ss = Math.min(1, Math.max(0, parseFloat(m[2]) / 100));
      const ll = Math.min(1, Math.max(0, parseFloat(m[3]) / 100));
      const aa = m[4] === undefined ? 1 : Math.min(1, Math.max(0, parseFloat(m[4])));
      const rgb = hslToRgbChannels(hh, ss, ll);
      return { r: rgb[0], g: rgb[1], b: rgb[2], a: aa };
    }

    return null;
  }

  function hslToRgbChannels(h, s, l) {
    if (s === 0) {
      const v = clamp8(l * 255);
      return [v, v, v];
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      clamp8(hue2rgb(p, q, h + 1 / 3) * 255),
      clamp8(hue2rgb(p, q, h) * 255),
      clamp8(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    const l = (max + min) / 2;
    const d = max - min;
    let s = 0;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function toHex(r, g, b) {
    const h = (v) => clamp8(v).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }

  function formatRgb(c) {
    if (c.a >= 1) return `rgb(${c.r}, ${c.g}, ${c.b})`;
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.a.toFixed(3))})`;
  }

  function formatHsl(c) {
    const hsl = rgbToHsl(c.r, c.g, c.b);
    if (c.a >= 1) return `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
    return `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${Number(c.a.toFixed(3))})`;
  }

  // WCAG 2.x 相对亮度：https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
  function channelLuminance(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(rgb) {
    return (
      0.2126 * channelLuminance(rgb.r) +
      0.7152 * channelLuminance(rgb.g) +
      0.0722 * channelLuminance(rgb.b)
    );
  }

  // WCAG 对比度 = (L1 + 0.05) / (L2 + 0.05)，结果 >= 1
  function contrastRatio(c1, c2) {
    const l1 = relativeLuminance(c1);
    const l2 = relativeLuminance(c2);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  }

  function roundRatio(ratio) {
    return Math.round(ratio * 100) / 100;
  }

  // WCAG 通过等级：AA 正文 4.5，AA 大号字/AAA 正文边界 3 / 7
  function wcagGrades(ratio) {
    return {
      aaNormal: ratio >= 4.5,
      aaLarge: ratio >= 3,
      aaaNormal: ratio >= 7,
      aaaLarge: ratio >= 4.5,
    };
  }

  // 为给定背景返回白/黑中对比度更高的前景色
  function bestForeground(rgb) {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    return contrastRatio(rgb, white) >= contrastRatio(rgb, black) ? white : black;
  }

  return {
    parseColor,
    toHex,
    formatRgb,
    formatHsl,
    rgbToHsl,
    relativeLuminance,
    contrastRatio,
    roundRatio,
    wcagGrades,
    bestForeground,
  };
});
