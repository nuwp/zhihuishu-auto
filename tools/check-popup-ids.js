/**
 * check-popup-ids.js — popup 的 id 交叉校验（开发用，不属于测试套件）
 *
 * 抓的是一个很容易漏的错：popup.js 里写了 $('xxx')，而 popup.html 里没有
 * id="xxx"。这类错误不会报任何异常 —— bindControls 里 `if (!el) continue;`
 * 会安静跳过，表现就是"控件点了没反应"，非常难查。
 *
 * 运行： node tools/check-popup-ids.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.html'), 'utf8');

const jsIds = new Set();
for (const m of js.matchAll(/\$\('([a-zA-Z_][\w-]*)'\)/g)) jsIds.add(m[1]);

const htmlIds = new Set();
for (const m of html.matchAll(/id="([\w-]+)"/g)) htmlIds.add(m[1]);

const missing = [...jsIds].filter((i) => !htmlIds.has(i));
const unused = [...htmlIds].filter((i) => !jsIds.has(i));

console.log('popup.js 引用 ' + jsIds.size + ' 个 id，html 定义 ' + htmlIds.size + ' 个');
console.log('引用了但 html 里没有（点了不会有反应）：' + JSON.stringify(missing));
console.log('html 里有但 js 没引用（纯展示或漏绑）：' + JSON.stringify(unused));

if (missing.length) {
  console.error('\n有缺失 id，必须修。');
  process.exit(1);
}
console.log('\n交叉校验通过。');
