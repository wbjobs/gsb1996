'use strict';
const assert = require('assert');
const Q = require('../js/quantize.js');

let passed = 0;

function makeImageData(regions) {
  // regions: [{w,h, color:[r,g,b,a]}] 横向排列
  const h = Math.max(...regions.map((r) => r.h));
  const w = regions.reduce((s, r) => s + r.w, 0);
  const data = new Uint8ClampedArray(w * h * 4);
  let x0 = 0;
  for (const region of regions) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < region.w; x++) {
        const i = ((y * w) + x0 + x) * 4;
        data[i] = region.color[0];
        data[i + 1] = region.color[1];
        data[i + 2] = region.color[2];
        data[i + 3] = region.color[3];
      }
    }
    x0 += region.w;
  }
  return { data, width: w, height: h };
}

// 纯色：无论切多少盒，结果都应是该色
{
  const img = makeImageData([{ w: 40, h: 40, color: [10, 200, 90, 255] }]);
  const palette = Q.medianCut(img.data, { count: 8 });
  assert.strictEqual(palette.length, 1);
  assert.deepStrictEqual([palette[0].r, palette[0].g, palette[0].b], [10, 200, 90]);
  assert.strictEqual(palette[0].ratio, 1);
  passed++;
}

// 双色块：两个分离充分的簇都应被恢复，比例正确
{
  // 纵向 3:1 排布（红 1200 px / 蓝 400 px），确保红-蓝通道范围最大
  const w = 40, h1 = 30, h2 = 10;
  const data = new Uint8ClampedArray(w * (h1 + h2) * 4);
  for (let y = 0; y < h1; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 255; data[i + 3] = 255;
    }
  for (let y = h1; y < h1 + h2; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i + 2] = 255; data[i + 3] = 255;
    }
  const palette = Q.medianCut(data, { count: 2 });
  assert.strictEqual(palette.length, 2);
  const near = (c, ref, tol) => Math.abs(c.r - ref[0]) <= tol && Math.abs(c.g - ref[1]) <= tol && Math.abs(c.b - ref[2]) <= tol;
  assert.ok(near(palette[0], [255, 0, 0], 0), JSON.stringify(palette[0]));
  assert.ok(near(palette[1], [0, 0, 255], 0), JSON.stringify(palette[1]));
  assert.ok(Math.abs(palette[0].ratio - 0.75) < 1e-9, 'ratio ' + palette[0].ratio);
  assert.ok(Math.abs(palette[1].ratio - 0.25) < 1e-9);
  passed++;
}

// 四色棋盘：应全部恢复
{
  const img = makeImageData([
    { w: 20, h: 20, color: [255, 255, 255, 255] },
    { w: 20, h: 20, color: [0, 0, 0, 255] },
    { w: 20, h: 20, color: [255, 255, 0, 255] },
    { w: 20, h: 20, color: [0, 255, 255, 255] },
  ]);
  const palette = Q.medianCut(img.data, { count: 4 });
  const refs = [[0, 0, 0], [0, 255, 255], [255, 255, 0], [255, 255, 255]];
  assert.strictEqual(palette.length, 4);
  for (const ref of refs) {
    assert.ok(palette.some((c) => Math.abs(c.r - ref[0]) <= 2 && Math.abs(c.g - ref[1]) <= 2 && Math.abs(c.b - ref[2]) <= 2),
      'missing ' + ref + ' got ' + JSON.stringify(palette));
  }
  passed++;
}

// 全透明像素默认跳过；若强制不跳过则按白底合成
{
  const data = new Uint8ClampedArray([0, 0, 0, 0]);
  assert.deepStrictEqual(Q.medianCut(data, { count: 4 }), []);
  const p = Q.medianCut(data, { count: 4, skipTransparent: false });
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual([p[0].r, p[0].g, p[0].b], [255, 255, 255]);
  passed++;
}

// 半透明合成：alpha 0.5 的黑在白底上 = 128 灰
{
  const [r, g, b] = Q.compositePixel(0, 0, 0, 128, { r: 255, g: 255, b: 255 });
  assert.ok(Math.abs(r - 128) <= 1, 'composited r=' + r);
  assert.strictEqual(r, g); assert.strictEqual(g, b);
  passed++;
}

// step 抽样：只取第 1 个像素
{
  const data = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
  ]);
  const palette = Q.medianCut(data, { count: 4, step: 2 });
  assert.strictEqual(palette.length, 1);
  assert.deepStrictEqual([palette[0].r, palette[0].g, palette[0].b], [255, 0, 0]);
  passed++;
}

// averageColor
{
  const data = new Uint8ClampedArray([
    0, 0, 0, 255,
    100, 100, 100, 255,
  ]);
  const avg = Q.averageColor(data);
  assert.strictEqual(avg.r, 50);
  passed++;
}

// 性能：1000x1000 随机像素，抽样分析应在 300ms 内完成
{
  const n = 1000 * 1000;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 73 + (i >> 3)) & 0xff;
  const t0 = Date.now();
  const palette = Q.medianCut(data, { count: 8, step: 4 });
  const dt = Date.now() - t0;
  assert.strictEqual(palette.length, 8);
  assert.ok(dt < 500, `quantize took ${dt}ms`);
  console.log('  (1M 随机像素 step=4: ' + dt + 'ms)');
  passed++;
}

console.log(`quantize: ${passed} assertions passed`);
