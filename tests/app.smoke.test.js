/* 最小 DOM 桩冒烟测试：验证 app.js 初始化不抛错，
   以及通过暴露到 window 的内部行为间接验证对比度更新（用事件桩驱动）。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl(id) {
  const listeners = {};
  const classes = new Set();
  return {
    id,
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    style: {},
    files: null,
    width: 0,
    height: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatch(type, ev) {
      (listeners[type] || []).forEach((fn) => fn(ev || {}));
    },
    appendChild() {},
    remove() {},
    click() {},
    setAttribute() {},
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
}

const ids = [
  'fileInput', 'eyedropperBtn', 'analyzeBtn', 'workerStatus', 'dropZone', 'dropHint',
  'canvas', 'loupe', 'pixelInfo', 'currentSwatch', 'currentHex', 'currentRgb',
  'currentPos', 'addCurrentBtn', 'fgColor', 'fgText', 'bgColor', 'bgText', 'swapBtn',
  'contrastPreview', 'ratioNumber', 'badgeAaNormal', 'badgeAaLarge', 'badgeAaaNormal',
  'badgeAaaLarge', 'exportFormat', 'exportBtn', 'exportImageBtn', 'clearBtn',
  'colorList', 'listCount', 'toastContainer',
];

const elMap = {};
ids.forEach((id) => (elMap[id] = makeEl(id)));
elMap.fgColor.value = '#333333';
elMap.bgColor.value = '#ffffff';
elMap.fgText.value = '#333333';
elMap.bgText.value = '#ffffff';
elMap.exportFormat.value = 'json';

// 需要真实行为的少量元素
const docListeners = {};
const documentStub = {
  getElementById: (id) => elMap[id] || null,
  createElement: (tag) => {
    const el = makeEl('dyn-' + tag);
    el.tagName = tag;
    return el;
  },
  body: { appendChild() {}, },
  addEventListener() {},
  execCommand: () => true,
};

let workerCtorCount = 0;
class WorkerStub {
  constructor(url) {
    this.url = url;
    workerCtorCount++;
    this.listeners = { message: [], error: [] };
  }
  addEventListener(type, fn) { this.listeners[type] && this.listeners[type].push(fn); }
  removeEventListener(type, fn) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
  }
  postMessage() {}
  terminate() {}
}

const winListeners = {};
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => 1,
  cancelAnimationFrame: () => {},
  document: documentStub,
  Worker: WorkerStub,
  isSecureContext: false,
  Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  navigator: { clipboard: null },
  addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
  removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.__elMap = elMap;
vm.createContext(sandbox);

const dir = path.join(__dirname, '..', 'js');
vm.runInContext(fs.readFileSync(path.join(dir, 'color-utils.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, 'quantize.js'), 'utf8'), sandbox);

// 执行 app.js —— 初始化阶段不应抛出
assert.doesNotThrow(() => {
  vm.runInContext(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
});
assert.strictEqual(workerCtorCount, 1, '应初始化一个 worker');
assert.strictEqual(elMap.workerStatus.textContent, 'Worker 就绪');

// 默认前景 #333333 / 背景 #ffffff 的对比度应被计算并渲染
assert.ok(/^[0-9]+\.[0-9]{2} : 1$/.test(elMap.ratioNumber.textContent),
  'ratio text: ' + elMap.ratioNumber.textContent);
const ratioText = elMap.ratioNumber.textContent;
// #333 = 51 => 对白对比度 12.63:1
assert.ok(ratioText.startsWith('12.6'), 'expected ~12.6, got ' + ratioText);

// 修改前景输入为非法值 -> 标记 invalid，徽章不崩
elMap.fgText.value = 'not-a-color';
elMap.fgText.dispatch('input');
assert.ok(elMap.fgText.classList.contains('invalid'));
assert.strictEqual(elMap.ratioNumber.textContent, '—');

// 恢复合法值 -> AA/AAA 徽章出现 pass/fail
elMap.fgText.value = '#777777';
elMap.fgText.dispatch('input');
assert.ok(!elMap.fgText.classList.contains('invalid'));
assert.ok(/^4\.4[0-9]/.test(elMap.ratioNumber.textContent), elMap.ratioNumber.textContent);

// swap
elMap.fgText.value = '#000000';
elMap.bgText.value = '#ffffff';
elMap.swapBtn.dispatch('click');
assert.strictEqual(elMap.fgText.value, '#ffffff');
assert.strictEqual(elMap.bgText.value, '#000000');
assert.strictEqual(elMap.ratioNumber.textContent, '21.00 : 1');

console.log('app smoke: 初始化/对比度/输入校验/交换 均正常');

/* 导出逻辑：直接对 buildExportData 的输出做 JSON/CSS/CSV 校验。
   该函数在 IIFE 内部，通过在沙箱中预置 colors 后触发导出按钮不可行（Blob 桩），
   因此这里重新实现等价调用不可取——改为校验 color-utils 生成导出内容的契约字段。 */
{
  const CU = require(path.join(__dirname, '..', 'js', 'color-utils.js'));
  const c = CU.parseColor('#777777');
  const row = {
    hex: CU.toHex(c.r, c.g, c.b).toUpperCase(),
    rgb: CU.formatRgb(c),
    contrastOnWhite: CU.roundRatio(CU.contrastRatio(c, { r: 255, g: 255, b: 255 })),
    contrastOnBlack: CU.roundRatio(CU.contrastRatio(c, { r: 0, g: 0, b: 0 })),
  };
  assert.strictEqual(row.hex, '#777777');
  assert.strictEqual(row.rgb, 'rgb(119, 119, 119)');
  assert.ok(Math.abs(row.contrastOnWhite - 4.48) < 0.01);
  assert.ok(Math.abs(row.contrastOnBlack - 4.69) < 0.01, 'black contrast ' + row.contrastOnBlack);
  console.log('app smoke: 导出契约字段（HEX/RGB/双底色对比度）正确');
}
