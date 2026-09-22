import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColor, toHex, contrastRatio, relativeLuminance,
  wcagGrade, bestTextColor, extractPalette,
} from '../js/color-utils.js';

test('parseColor 支持 3/6 位 hex 与 rgb()', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColor('000'), [0, 0, 0]);
  assert.deepEqual(parseColor('#3B82F6'), [59, 130, 246]);
  assert.deepEqual(parseColor('rgb(12, 34, 56)'), [12, 34, 56]);
  assert.deepEqual(parseColor('rgba(255,0,0,0.5)'), [255, 0, 0]);
  assert.equal(parseColor('#ggg'), null);
  assert.equal(parseColor('rgb(300,1,1)'), null);
  assert.equal(parseColor(''), null);
});

test('toHex 输出大写两位十六进制', () => {
  assert.equal(toHex([0, 0, 0]), '#000000');
  assert.equal(toHex([255, 255, 255]), '#FFFFFF');
  assert.equal(toHex([59.4, 130.6, 246]), '#3B83F6');
});

test('相对亮度：黑 0 白 1', () => {
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.ok(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-12);
  // WCAG 规范中 sRGB 红的相对亮度约 0.2126
  assert.ok(Math.abs(relativeLuminance([255, 0, 0]) - 0.2126) < 1e-4);
});

test('对比度：白/黑 = 21:1，同色 = 1:1', () => {
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#000', [255, 255, 255]), 21);
  assert.equal(contrastRatio([10, 20, 30], [10, 20, 30]), 1);
});

test('对比度：WCAG 官方参考值 #77 对白底约 4.54:1（AA 临界）', () => {
  const ratio = contrastRatio('#767676', '#ffffff');
  assert.ok(ratio >= 4.53 && ratio <= 4.56, `实际 ${ratio}`);
  assert.equal(wcagGrade(ratio, 'AA', 'normal'), true);
});

test('对比度：#595959 对白底约 7:1（AAA 临界）', () => {
  const ratio = contrastRatio('#595959', '#ffffff');
  assert.ok(ratio >= 6.95 && ratio <= 7.05, `实际 ${ratio}`);
  assert.equal(wcagGrade(ratio, 'AAA', 'normal'), true);
});

test('wcagGrade 阈值：4.48 不过 AA，4.5 过；大号文字 3:1 阈值', () => {
  assert.equal(wcagGrade(4.48, 'AA', 'normal'), false);
  assert.equal(wcagGrade(4.5, 'AA', 'normal'), true);
  assert.equal(wcagGrade(3, 'AA', 'large'), true);
  assert.equal(wcagGrade(2.99, 'AA', 'large'), false);
  assert.equal(wcagGrade(4.5, 'AAA', 'large'), true);
  assert.equal(wcagGrade(7, 'AAA', 'normal'), true);
  assert.equal(wcagGrade(null, 'AA'), false);
});

test('bestTextColor 深背景给白字、浅背景给深字', () => {
  assert.deepEqual(bestTextColor([0, 0, 0]), [255, 255, 255]);
  assert.deepEqual(bestTextColor([255, 255, 255]), [17, 17, 17]);
});

test('extractPalette 主色提取：纯色得到单色，双色各占约 50%', () => {
  const solid = new Uint8ClampedArray(4 * 100).fill(0);
  for (let i = 0; i < 100; i++) solid.set([10, 20, 30, 255], i * 4);
  const one = extractPalette(solid, 4);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].rgb, [10, 20, 30]);
  assert.ok(Math.abs(one[0].weight - 1) < 1e-9);

  const mixed = new Uint8ClampedArray(4 * 100);
  for (let i = 0; i < 50; i++) mixed.set([255, 0, 0, 255], i * 4);
  for (let i = 50; i < 100; i++) mixed.set([0, 0, 255, 255], i * 4);
  const two = extractPalette(mixed, 4);
  assert.equal(two.length, 2);
  assert.ok(Math.abs(two[0].weight - 0.5) < 0.02);
});

test('extractPalette 跳过透明像素', () => {
  const data = new Uint8ClampedArray(4 * 8);
  for (let i = 0; i < 4; i++) data.set([0, 0, 0, 0], i * 4);
  for (let i = 4; i < 8; i++) data.set([1, 2, 3, 255], i * 4);
  const palette = extractPalette(data, 3);
  assert.equal(palette.length, 1);
  assert.deepEqual(palette[0].rgb, [1, 2, 3]);
});
