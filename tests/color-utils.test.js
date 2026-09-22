/* Node 测试：对比度算法对照 WCAG 官方已知值，解析/格式化回归 */
'use strict';
const assert = require('assert');
const CU = require('../js/color-utils.js');

let passed = 0;
function ok(name, actual, expected, eps) {
  const diff = Math.abs(actual - expected);
  assert(diff <= (eps || 1e-9), `${name}: expected ${expected}, got ${actual}`);
  passed++;
}

// --- 已知 WCAG 对比度（官方定义：纯白/纯黑 = 21:1）---
const white = { r: 255, g: 255, b: 255 };
const black = { r: 0, g: 0, b: 0 };
ok('white/black', CU.contrastRatio(white, black), 21, 1e-9);
ok('black/white order-independent', CU.contrastRatio(black, white), 21, 1e-9);
ok('same color = 1', CU.contrastRatio({ r: 123, g: 45, b: 200 }, { r: 123, g: 45, b: 200 }), 1, 1e-12);

// #777777 对白色：L=0.18974... => 1.05/0.23974 ≈ 4.48 (4.48:1，AA 正文边界附近)
const gray777 = CU.parseColor('#777777');
ok('#777 vs white', CU.contrastRatio(gray777, white), 4.48, 0.01);

// #595959 对白 ≈ 7.0:1（WCAG 文档常用 AAA 边界示例）
const gray59 = CU.parseColor('#595959');
ok('#595959 vs white ~7', CU.contrastRatio(gray59, white), 7.0, 0.05);

// #767676 对白 ≈ 4.54:1（W3C 非文本对比最低 3:1 附近的常用灰）
const gray76 = CU.parseColor('#767676');
ok('#767676 vs white ~4.54', CU.contrastRatio(gray76, white), 4.54, 0.01);

// #0000ff 蓝对白 = 8.592:1（经典 WCAG 教学示例）
const blue = CU.parseColor('#0000ff');
ok('#0000ff vs white = 8.592', CU.contrastRatio(blue, white), 8.592, 0.01);

// 相对亮度边界：#0 串线性化 0.04045 附近
ok('luminance white=1', CU.relativeLuminance(white), 1, 1e-9);
ok('luminance black=0', CU.relativeLuminance(black), 0, 1e-12);

// --- 等级判定 ---
const gradesFail = CU.wcagGrades(2);
assert.strictEqual(gradesFail.aaNormal, false);
assert.strictEqual(gradesFail.aaLarge, false);
const gradesPass = CU.wcagGrades(21);
assert.strictEqual(gradesPass.aaNormal && gradesPass.aaaNormal, true);
passed += 2;

// 边界精确性：4.5:1 本身应通过 AA 正文
assert.strictEqual(CU.wcagGrades(4.5).aaNormal, true);
assert.strictEqual(CU.wcagGrades(4.49999).aaNormal, false);
assert.strictEqual(CU.wcagGrades(7).aaaNormal, true);
passed += 3;

// --- 解析器 ---
assert.deepStrictEqual(CU.parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
assert.deepStrictEqual(CU.parseColor('#AABBCC'), { r: 170, g: 187, b: 204, a: 1 });
assert.deepStrictEqual(CU.parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
assert.deepStrictEqual(CU.parseColor('rgba(10,20,30,0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
assert.deepStrictEqual(CU.parseColor('rgb(100%, 0%, 0%)'), { r: 255, g: 0, b: 0, a: 1 });
assert.deepStrictEqual(CU.parseColor('white'), { r: 255, g: 255, b: 255, a: 1 });
assert.deepStrictEqual(CU.parseColor('black'), { r: 0, g: 0, b: 0, a: 1 });
assert.strictEqual(CU.parseColor('not-a-color'), null);
assert.strictEqual(CU.parseColor('#zzzzzz'), null);
assert.strictEqual(CU.parseColor(''), null);
passed += 10;

// hsl(0,100%,50%) = 红
assert.deepStrictEqual(CU.parseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
// hsl(120,100%,50%) = 绿
assert.deepStrictEqual(CU.parseColor('hsl(120, 100%, 50%)'), { r: 0, g: 255, b: 0, a: 1 });
// hsl(240,100%,50%) = 蓝
assert.deepStrictEqual(CU.parseColor('hsl(240, 100%, 50%)'), { r: 0, g: 0, b: 255, a: 1 });
passed += 3;

// --- 格式化往返 ---
const c = { r: 170, g: 187, b: 204, a: 1 };
assert.strictEqual(CU.toHex(c.r, c.g, c.b), '#aabbcc');
assert.strictEqual(CU.formatRgb(c), 'rgb(170, 187, 204)');
const hsl = CU.rgbToHsl(255, 0, 0);
assert.strictEqual(hsl.h, 0);
assert.strictEqual(hsl.s, 100);
assert.strictEqual(hsl.l, 50);
passed += 3;

// bestForeground
assert.deepStrictEqual(CU.bestForeground(black), white);
assert.deepStrictEqual(CU.bestForeground(white), black);
passed += 2;

// roundRatio
assert.strictEqual(CU.roundRatio(4.544), 4.54);
assert.strictEqual(CU.roundRatio(21), 21);
passed += 2;

console.log(`color-utils: ${passed} assertions passed`);
