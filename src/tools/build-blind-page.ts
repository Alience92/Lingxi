/**
 * build-blind-page.ts — 生成盲评 HTML 页面
 * 用法: cd D:\LingxiServer && node --import tsx src/tools/build-blind-page.ts
 */
import * as fs from "node:fs";

const data = JSON.parse(fs.readFileSync("D:/AshinMaterials/blind_test_v4_data.json", "utf-8"));

const STYLE = `*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e1a;color:#c9d1d9;font:14px/1.6 -apple-system,'Microsoft YaHei',sans-serif;max-width:720px;margin:0 auto;padding:20px}
h1{color:#a78bfa;font-size:20px;margin-bottom:4px}
.sub{color:#64748b;font-size:12px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:16px}
.card h3{font-size:14px;color:#58a6ff;margin-bottom:12px}
.reply{background:#0d1117;border:2px solid #30363d;border-radius:8px;padding:12px 14px;margin:8px 0;font-size:13px;white-space:pre-wrap;cursor:pointer;transition:.15s}
.reply:hover{border-color:#a78bfa}
.reply.selected{border-color:#3fb950;background:#0d3320}
.reply .num{font-size:10px;color:#8b949e;margin-bottom:4px}
.score{font-size:24px;text-align:center;padding:20px;color:#a78bfa}
.hidden{display:none}
.final{text-align:center}
.final .pass{color:#3fb950;font-size:32px}
.final .fail{color:#f85149;font-size:32px}
.progress{color:#8b949e;font-size:12px;margin-bottom:16px}
.done-mark{text-align:center;color:#3fb950;margin-top:8px;font-size:12px}`;

const SCRIPT = `
let choices = {};
let evalOrder = [];

function init() {
  evalOrder = DATA.map((s, i) => ({ ...s, idx: i, swapAB: Math.random() > 0.5 }));
  render();
}

function render() {
  const cards = document.getElementById("cards");
  const answered = Object.keys(choices).length;
  document.getElementById("progress").textContent = "已完成: " + answered + " / " + DATA.length;

  let html = "";
  evalOrder.forEach((s) => {
    const c = choices[s.idx];
    const which = c ? c.which : null;
    const topReply = s.swapAB ? s.replyB : s.replyA;
    const bottomReply = s.swapAB ? s.replyA : s.replyB;
    const topIsML = !s.swapAB;
    const bottomIsML = s.swapAB;

    html += '<div class="card"><h3>' + s.msg + '</h3>' +
      '<div class="reply' + (which === "top" ? ' selected' : '') + '" onclick="pick(' + s.idx + ",'top'," + topIsML + ')"><div class="num">回复 ① | warmth:' + (topReply.warmth||0).toFixed(1) + ' v:' + (topReply.verbosity||0).toFixed(1) + ' h:' + (topReply.humor||0).toFixed(1) + '</div>' + JSON.stringify(topReply).slice(1,-1) + '</div>' +
      '<div class="reply' + (which === "bottom" ? ' selected' : '') + '" onclick="pick(' + s.idx + ",'bottom'," + bottomIsML + ')"><div class="num">回复 ② | warmth:' + (bottomReply.warmth||0).toFixed(1) + ' v:' + (bottomReply.verbosity||0).toFixed(1) + ' h:' + (bottomReply.humor||0).toFixed(1) + '</div>' + JSON.stringify(bottomReply).slice(1,-1) + '</div>' +
      (which ? '<div class="done-mark">已选择 回复 ' + (which === "top" ? "①" : "②") + '</div>' : '') + '</div>';
  });

  cards.innerHTML = html;
  if (answered === DATA.length) showResult();
}

function pick(idx, which, isML) { choices[idx] = { which, isML }; render(); }

function showResult() {
  let mlWins = 0, total = 0;
  evalOrder.forEach(s => { const c = choices[s.idx]; if (!c) return; total++; if (c.isML) mlWins++; });
  const rate = (mlWins / total * 100).toFixed(0);
  const pass = rate >= 60;
  document.getElementById("result").className = "";
  document.getElementById("result").innerHTML =
    '<div class="score">v4 ML模型被选为「更像阿信」的比例</div>' +
    '<div class="final ' + (pass ? 'pass' : 'fail') + '">' + rate + '%</div>' +
    '<div style="color:#8b949e;margin-top:8px">' + (pass ? '✅ 通过 (≥60%) — v4 蒸馏方向成立' : '❌ 未通过 (<60%) — 需要重新评估技术路线') + '</div>' +
    '<div style="margin-top:16px;font-size:11px;color:#64748b">共 ' + total + ' 组 | ML v4 被选中 ' + mlWins + ' 次 | 默认参数被选中 ' + (total - mlWins) + ' 次</div>' +
    '<div style="margin-top:16px;font-size:11px;color:#8b949e">模型: persona-ashin-v4-final | SceneAcc 82.2% | WarmthSpan 0.428 | 1519 纯v4训练对<br>每个卡片显示了风格参数供参考，评估时请忽略数字标签，专注于回复是否符合阿信的说话方式。</div>';
  document.getElementById("cards").className = "hidden";
}

init();`;

const jsonData = data.map((d: any) => ({
  id: d.id, msg: d.msg, type: d.type,
  w: d.w, v: d.v, h: d.h, f: d.f,
  replyA: d.replyA, replyB: d.replyB,
}));

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>灵犀明星人格 — 盲评测试 v4</title>
<style>${STYLE}</style>
</head>
<body>
<h1>灵犀明星人格 — 盲评测试 v4</h1>
<div class="sub">15个场景，每个场景有两版回复。选出你觉得更像阿信的那一版。<br><small>v4 多任务模型 (SceneAcc 82.2% | WarmthSpan 0.428 | 1519训练对)</small></div>
<div id="progress" class="progress"></div>
<div id="cards"></div>
<div id="result" class="hidden"></div>
<script>
const DATA = ${JSON.stringify(jsonData)};
${SCRIPT}
</script>
</body>
</html>`;

fs.writeFileSync("D:/LingxiServer/public/blind-test-v4.html", html, "utf-8");
console.log(`Done: ${Math.round(html.length / 1024)}KB | ${jsonData.length} scenarios`);
console.log(`Access: http://localhost:11438/blind-test-v4.html`);
