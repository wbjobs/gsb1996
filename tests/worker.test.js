/* 模拟 Worker 全局环境，验证 image-worker.js 的消息协议与异常处理 */
'use strict';
const assert = require('assert');
const path = require('path');
const vm = require('vm');

let passed = 0;

// 2x2 测试图像 RGBA
const W = 2, H = 2;
const pixels = new Uint8ClampedArray([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
  255, 255, 255, 255,
]);

function loadWorkerSandbox() {
  const messages = [];
  const sandbox = {
    console,
    setTimeout,
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          drawImage() {},
          getImageData: (x, y, w, h) => ({ data: pixels.slice(), width: w, height: h }),
        };
      }
    },
    postMessage: (msg) => messages.push(msg),
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const dir = path.join(__dirname, '..', 'js');
  // importScripts：依次把文件放进同一上下文执行
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      const code = require('fs').readFileSync(path.join(dir, f), 'utf8');
      vm.runInContext(code, sandbox, { filename: f });
    }
  };
  const code = require('fs').readFileSync(path.join(dir, 'image-worker.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'image-worker.js' });
  return { sandbox, messages };
}

// 正常分析
{
  const { sandbox, messages } = loadWorkerSandbox();
  const fakeBitmap = { width: W, height: H, close() { this.closed = true; } };
  sandbox.self.onmessage({ data: { type: 'analyze', id: 't1', bitmap: fakeBitmap, options: { count: 4 } } });
  assert.strictEqual(messages.length, 1);
  const reply = messages[0];
  assert.strictEqual(reply.id, 't1');
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.result.width, W);
  assert.strictEqual(reply.result.height, H);
  assert.ok(reply.result.palette.length <= 4);
  // 四色图应恢复 4 个簇
  const colors = reply.result.palette.map((c) => c.r + ',' + c.g + ',' + c.b).sort();
  assert.strictEqual(JSON.stringify(colors), JSON.stringify(["0,0,255", "0,255,0", "255,0,0", "255,255,255"]));
  assert.strictEqual(fakeBitmap.closed, true);
  passed += 3;
}

// 异常请求：缺 bitmap 必须回 ok:false 而非抛出
{
  const { sandbox, messages } = loadWorkerSandbox();
  sandbox.self.onmessage({ data: { type: 'analyze', id: 't2' } });
  assert.strictEqual(messages[0].ok, false);
  assert.ok(messages[0].error.length > 0);
  assert.strictEqual(messages[0].id, 't2');
  passed++;
}

// 异常请求：错误 type
{
  const { sandbox, messages } = loadWorkerSandbox();
  sandbox.self.onmessage({ data: { type: 'ping', id: 't3' } });
  assert.strictEqual(messages[0].ok, false);
  passed++;
}

console.log(`worker: ${passed} assertions passed`);
