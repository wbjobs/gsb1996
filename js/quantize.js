/*
 * quantize.js
 * 中位切分(median-cut)颜色量化：从 ImageData 提取主色调色板。
 * 纯函数 UMD，供 Web Worker 与 Node 测试共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Quantize = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 全透明像素按背景色合成，避免半透明边缘污染统计
  function compositePixel(r, g, b, a, bg) {
    const alpha = a / 255;
    return [
      Math.round(bg.r * (1 - alpha) + r * alpha),
      Math.round(bg.g * (1 - alpha) + g * alpha),
      Math.round(bg.b * (1 - alpha) + b * alpha),
    ];
  }

  /*
   * data: Uint8ClampedArray (RGBA)
   * opts: { count, background:{r,g,b}, step } step>1 时按步长抽样以提升性能
   * 返回 [{r,g,b,count,ratio}]，按出现频率降序。
   */
  function medianCut(data, opts) {
    const count = Math.max(1, Math.min(opts.count || 8, 24));
    const bg = opts.background || { r: 255, g: 255, b: 255 };
    const step = Math.max(1, opts.step || 1);

    const pixels = [];
    for (let i = 0; i < data.length; i += 4 * step) {
      const a = data[i + 3];
      if (a === 0 && opts.skipTransparent !== false) continue;
      const px = compositePixel(data[i], data[i + 1], data[i + 2], a, bg);
      pixels.push(px);
    }

    if (pixels.length === 0) return [];

    const boxes = [pixels];
    while (boxes.length < count) {
      let target = -1;
      let targetRange = 0;
      let targetChannel = 0;
      for (let bi = 0; bi < boxes.length; bi++) {
        const box = boxes[bi];
        if (box.length < 2) continue;
        const ranges = channelRanges(box);
        const maxRange = Math.max(ranges[0], ranges[1], ranges[2]);
        if (maxRange > targetRange) {
          targetRange = maxRange;
          target = bi;
          targetChannel = ranges.indexOf(maxRange);
        }
      }
      // 所有盒子都退化为单色，继续切分只会得到重复颜色
      if (target === -1) break;

      const box = boxes[target];
      box.sort((p, q) => p[targetChannel] - q[targetChannel]);
      const mid = chooseSplit(box, targetChannel);
      boxes.splice(target, 1, box.slice(0, mid), box.slice(mid));
    }

    const total = pixels.length;
    return boxes
      .map((box) => {
        let r = 0, g = 0, b = 0;
        for (const px of box) { r += px[0]; g += px[1]; b += px[2]; }
        return {
          r: Math.round(r / box.length),
          g: Math.round(g / box.length),
          b: Math.round(b / box.length),
          count: box.length,
          ratio: box.length / total,
        };
      })
      .reduce((acc, item) => {
        const key = item.r + ',' + item.g + ',' + item.b;
        const existing = acc.find((x) => x.key === key);
        if (existing) {
          existing.count += item.count;
          existing.ratio += item.ratio;
        } else {
          acc.push({ key, r: item.r, g: item.g, b: item.b, count: item.count, ratio: item.ratio });
        }
        return acc;
      }, [])
      .map(({ key, ...rest }) => rest)
      .sort((a, b) => b.count - a.count);
  }

  // 在已按通道排序的盒子中选择切分点：
  // 优先在最大的数值跳变处切开（天然分离不同颜色簇），
  // 跳变并列时回退到中位数。
  function chooseSplit(sortedBox, channel) {
    let bestGap = -1;
    let bestIdx = -1;
    for (let i = 1; i < sortedBox.length; i++) {
      const gap = sortedBox[i][channel] - sortedBox[i - 1][channel];
      if (gap > bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    if (bestGap > 0) return bestIdx;
    return sortedBox.length >> 1;
  }

  function channelRanges(box) {
    let minR = 255, minG = 255, minB = 255;
    let maxR = 0, maxG = 0, maxB = 0;
    for (const px of box) {
      if (px[0] < minR) minR = px[0];
      if (px[1] < minG) minG = px[1];
      if (px[2] < minB) minB = px[2];
      if (px[0] > maxR) maxR = px[0];
      if (px[1] > maxG) maxG = px[1];
      if (px[2] > maxB) maxB = px[2];
    }
    return [maxR - minR, maxG - minG, maxB - minB];
  }

  function averageColor(data, opts) {
    const bg = (opts && opts.background) || { r: 255, g: 255, b: 255 };
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const px = compositePixel(data[i], data[i + 1], data[i + 2], data[i + 3], bg);
      r += px[0]; g += px[1]; b += px[2]; n++;
    }
    if (n === 0) return null;
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(n ? b / n : 0) };
  }

  return { medianCut, averageColor, compositePixel };
});
