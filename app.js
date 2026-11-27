'use strict';
// QRリーダー：起動即スキャン・自動判別・画像からの読み取り・履歴とCSV出力・ライトとズーム

const $ = (id) => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
let stream = null, scanning = false, detector = null;

// 端末内蔵のQR解析（Android Chromeなら高速）。使えるか確かめてから使う
const detectorReady = (async () => {
  if (!('BarcodeDetector' in window)) return;
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    if (formats.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
  } catch (e) { detector = null; }
})();
let detectorFails = 0;

// ---------- 読み取り ----------
let frameNo = 0;

// jsQRで、画像のうち (sx,sy,sw,sh) の範囲を最大 maxSide px に縮めて解析する
function jsqrRegion(src, sx, sy, sw, sh, maxSide, inversion = 'attemptBoth') {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let code = null;
  try { code = jsQR(img.data, img.width, img.height, { inversionAttempts: inversion }); } catch (e) { /* jsQRが稀に例外を出すので無視 */ }
  return code ? code.data : null;
}

async function decodeSource(src, w, h, isVideo) {
  if (detector) {
    try {
      const codes = await detector.detect(src);
      detectorFails = 0;
      if (codes.length && codes[0].rawValue) return codes[0].rawValue;
      // カメラ映像では内蔵解析だけを使う（jsQRを重ねると遅くなるため）
      if (isVideo) return null;
    } catch (e) {
      // 何度も失敗するなら内蔵解析をあきらめてjsQRに切り替える
      if (++detectorFails > 5) detector = null;
    }
  }
  if (!w || !h) return null;
  if (isVideo) {
    // jsQR：枠のあたり（中央の正方形）を小さめに解析して軽くする。白黒反転は時々だけ試す
    frameNo++;
    const side = Math.min(w, h) * 0.75 / digitalZoom;
    return jsqrRegion(src, (w - side) / 2, (h - side) / 2, side, side, 480, frameNo % 6 ? 'dontInvert' : 'onlyInvert');
  }
  // 画像：全体 → 小さく縮めて再挑戦（高解像度スクショ対策）
  return jsqrRegion(src, 0, 0, w, h, 1600) || jsqrRegion(src, 0, 0, w, h, 800);
}

// メインの背面カメラを選ぶ（超広角などピントの合わないレンズを避ける）
async function pickBackCamera() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const back = devs.filter((d) => /back|rear|environment|背面/i.test(d.label));
    if (back.length > 1) {
      const main = back.find((d) => /\b0\b/.test(d.label)) || back[0];
      return main.deviceId;
    }
  } catch (e) {}
  return null;
}

async function openStream(deviceId) {
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const video = deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: 'environment' } };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

async function startCamera() {
  $('retry').hidden = true;
  setStatus('カメラを起動しています…');
  try {
    stream = await openStream(null);
    // 許可が出た後ならカメラ名が見えるので、メインの背面カメラに切り替える
    const id = await pickBackCamera();
    const cur = stream.getVideoTracks()[0];
    if (id && cur.getSettings().deviceId !== id) {
      stream.getTracks().forEach((t) => t.stop());
      try { stream = await openStream(id); } catch (e) { stream = await openStream(null); }
    }
    const track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch (e) {}
    video.srcObject = stream;
    await video.play();
    setupControls(track);
    await detectorReady;
    setStatus('QRコードを枠に合わせてください');
    scanning = true;
    loop();
  } catch (e) {
    setStatus(e && e.name === 'NotAllowedError'
      ? 'カメラが許可されていません。ブラウザの設定で許可するか、画像から読み取ってください。'
      : 'カメラを使えませんでした。画像から読み取ることはできます。');
    $('retry').hidden = false;
  }
}

// ---------- ライトとズーム ----------
let camTrack = null, torchOn = false, hwZoom = null, digitalZoom = 1;

function setupControls(track) {
  camTrack = track; torchOn = false; digitalZoom = 1; video.style.transform = '';
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  // ライト：カメラが対応しているときだけボタンを出す
  const torchBtn = $('torch');
  torchBtn.hidden = !caps.torch;
  torchBtn.setAttribute('aria-pressed', 'false');
  // ズーム：カメラのズームが使えればそれを、なければ映像を拡大する（デジタルズーム）
  const z = $('zoom');
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    hwZoom = caps.zoom;
    z.min = caps.zoom.min; z.max = Math.min(caps.zoom.max, caps.zoom.min * 8); z.step = caps.zoom.step || 0.1;
    z.value = (track.getSettings && track.getSettings().zoom) || caps.zoom.min;
  } else {
    hwZoom = null; z.min = 1; z.max = 4; z.step = 0.1; z.value = 1;
  }
  $('zoomBox').hidden = false;
  showZoomLabel();
}

function showZoomLabel() {
  const z = $('zoom'), base = Number(z.min) || 1;
  $('zoomLabel').textContent = (Number(z.value) / base).toFixed(1) + 'x';
}

let zoomWanted = null, zoomBusy = false;
async function applyZoom(value) {
  const z = $('zoom');
  z.value = value; showZoomLabel();
  if (hwZoom && camTrack) {
    // スライダーを動かしている間に連打しないよう、最新の値だけを順に反映する
    zoomWanted = Number(z.value);
    if (zoomBusy) return;
    zoomBusy = true;
    try {
      let v;
      do { v = zoomWanted; await camTrack.applyConstraints({ advanced: [{ zoom: v }] }); } while (camTrack && zoomWanted !== v);
    } catch (e) { /* 対応していない値は無視 */ }
    zoomBusy = false;
  } else {
    digitalZoom = Number(z.value);
    video.style.transform = digitalZoom > 1 ? `scale(${digitalZoom})` : '';
  }
}

$('zoom').addEventListener('input', (e) => applyZoom(e.target.value));

// 画面をダブルタップで 1x ⇔ 2x を切り替え
let lastTap = 0;
$('scanner').addEventListener('pointerup', (e) => {
  if (e.target.closest('button, label, input, .zoom')) return;
  const now = Date.now();
  if (now - lastTap < 300) {
    const z = $('zoom'), base = Number(z.min) || 1;
    const target = Number(z.value) / base > 1.4 ? base : Math.min(base * 2, Number(z.max));
    applyZoom(target);
    lastTap = 0;
  } else lastTap = now;
});

$('torch').onclick = async () => {
  if (!camTrack) return;
  try {
    await camTrack.applyConstraints({ advanced: [{ torch: !torchOn }] });
    torchOn = !torchOn;
    $('torch').setAttribute('aria-pressed', String(torchOn));
  } catch (e) { toast('ライトを点けられませんでした'); }
};

function stopCamera() {
  scanning = false;
  camTrack = null; torchOn = false;
  $('torch').setAttribute('aria-pressed', 'false');
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    let text = null;
    try { text = await decodeSource(video, video.videoWidth, video.videoHeight, true); } catch (e) { /* 次のフレームで再挑戦 */ }
    if (text && scanning) { if (navigator.vibrate) navigator.vibrate(60); stopCamera(); addHistory(text); showResult(text); return; }
  }
  // 内蔵解析なら毎フレーム、jsQRなら少し間を空けて画面の動きを保つ
  if (detector) requestAnimationFrame(loop); else setTimeout(() => requestAnimationFrame(loop), 30);
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const text = await decodeSource(bmp, bmp.width, bmp.height);
    if (text) { stopCamera(); addHistory(text); showResult(text); }
    else toast('この画像からQRコードが見つかりませんでした');
  } catch (err) { toast('画像を読み込めませんでした'); }
});

// ---------- 内容の判別 ----------
function unescapeWifi(s) { return s.replace(/\\([\\;,:"])/g, '$1'); }
function parseWifi(text) {
  const body = text.slice(5);
  const out = {}; const re = /([A-Za-z]+):((?:\\.|[^;])*);/g; let m;
  while ((m = re.exec(body))) out[m[1].toUpperCase()] = unescapeWifi(m[2]);
  return { ssid: out.S || '', password: out.P || '', type: out.T || '', hidden: out.H === 'true' };
}

function classify(text) {
  const t = text.trim();
  if (/^WIFI:/i.test(t)) return { kind: 'wifi', ...parseWifi(t) };
  if (/^https?:\/\//i.test(t)) return { kind: 'url', url: t };
  if (/^www\.[^\s]+\.[^\s]+$/i.test(t)) return { kind: 'url', url: 'https://' + t };
  if (/^tel:/i.test(t)) return { kind: 'tel', number: t.slice(4) };
  if (/^mailto:/i.test(t)) return { kind: 'mail', href: t, to: decodeURIComponent(t.slice(7).split('?')[0]) };
  if (/^MATMSG:/i.test(t)) {
    const g = (k) => (t.match(new RegExp(k + ':([^;]*);', 'i')) || [])[1] || '';
    return { kind: 'mail', to: g('TO'), href: 'mailto:' + g('TO') + '?subject=' + encodeURIComponent(g('SUB')) + '&body=' + encodeURIComponent(g('BODY')) };
  }
  if (/^SMSTO:/i.test(t)) { const [, num, msg = ''] = t.split(':'); return { kind: 'sms', number: num, href: 'sms:' + num + '?body=' + encodeURIComponent(msg) }; }
  if (/^geo:/i.test(t)) return { kind: 'geo', href: t };
  if (/^BEGIN:VCARD/i.test(t) || /^MECARD:/i.test(t)) return { kind: 'contact', text: t };
  return { kind: 'text', text: t };
}

// ---------- 結果の表示 ----------
const LABELS = { url: 'URL', wifi: 'Wi-Fi', tel: '電話番号', mail: 'メール', sms: 'SMS', geo: '地図', contact: '連絡先', text: 'テキスト' };

// 一覧などで使う短い見出し
function summary(r, raw) {
  switch (r.kind) {
    case 'url': return r.url;
    case 'wifi': return r.ssid || '(名前なし)';
    case 'tel': case 'sms': return r.number;
    case 'mail': return r.to;
    default: return (r.text || raw).split('\n')[0];
  }
}

let resultFromHistory = null; // 履歴から開いたときはその項目のid

function showResult(raw, historyId = null) {
  resultFromHistory = historyId;
  const r = classify(raw);
  $('kind').textContent = LABELS[r.kind];
  const fields = $('fields'), actions = $('actions');
  fields.innerHTML = ''; actions.innerHTML = '';
  const field = (k, v) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; fields.append(dt, dd); };
  const action = (label, fn, primary) => { const b = document.createElement('button'); b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = fn; actions.append(b); return b; };
  const go = (href) => () => { location.href = href; };

  switch (r.kind) {
    case 'url': {
      let host = r.url; try { host = new URL(r.url).host; } catch (e) {}
      $('title').textContent = host;
      field('アドレス', r.url);
      action('ページを開く', () => window.open(r.url, '_blank', 'noopener'), true);
      action('URLをコピー', () => copy(r.url));
      break;
    }
    case 'wifi':
      $('title').textContent = r.ssid || '(名前なし)';
      field('ネットワーク', r.ssid);
      field('パスワード', r.password || '(なし)');
      if (r.type) field('暗号化', r.type);
      if (r.password) action('パスワードをコピー', () => copy(r.password), true);
      action('Wi-Fi設定を開く', () => {
        location.href = 'intent:#Intent;action=android.settings.WIFI_SETTINGS;end';
      }, !r.password);
      break;
    case 'tel':
      $('title').textContent = r.number; action('電話をかける', go('tel:' + r.number), true); action('番号をコピー', () => copy(r.number)); break;
    case 'mail':
      $('title').textContent = r.to; action('メールを作成', go(r.href), true); action('アドレスをコピー', () => copy(r.to)); break;
    case 'sms':
      $('title').textContent = r.number; action('SMSを作成', go(r.href), true); break;
    case 'geo':
      $('title').textContent = raw; action('地図で開く', go(r.href), true); break;
    default:
      $('title').textContent = r.text;
      action('コピー', () => copy(r.text), true);
      action('Googleで検索', () => window.open('https://www.google.com/search?q=' + encodeURIComponent(r.text), '_blank', 'noopener'));
  }
  if (historyId) {
    const del = action('履歴から削除', () => { removeHistory(historyId); closeSheet(); toast('削除しました'); });
    del.classList.add('danger');
    $('close').textContent = '履歴に戻る';
  } else {
    $('close').textContent = '続けてスキャン';
  }
  $('sheet').hidden = false;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('コピーしました'); } catch (_) { toast('コピーできませんでした'); }
    ta.remove();
  }
}

let toastTimer;
function toast(msg) { const el = $('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2000); }
function setStatus(s) { $('status').textContent = s; }

// ---------- 履歴 ----------
const HKEY = 'qr-history-v1', HMAX = 500;
function loadHistory() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch (e) { return []; } }
function saveHistory(list) { try { localStorage.setItem(HKEY, JSON.stringify(list.slice(0, HMAX))); } catch (e) { toast('履歴を保存できませんでした'); } }
function addHistory(text) {
  // 同じ内容はいちばん上に移して日時を更新する
  const list = loadHistory().filter((h) => h.text !== text);
  list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, at: new Date().toISOString() });
  saveHistory(list);
}
function removeHistory(id) { saveHistory(loadHistory().filter((h) => h.id !== id)); }

function fmtDate(iso) {
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderHistory() {
  const list = loadHistory(), ul = $('historyList');
  ul.innerHTML = '';
  $('historyEmpty').hidden = list.length > 0;
  $('exportCsv').disabled = $('clearHistory').disabled = list.length === 0;
  resetClear();
  for (const h of list) {
    const r = classify(h.text);
    const li = document.createElement('li'), b = document.createElement('button');
    const meta = document.createElement('div'); meta.className = 'h-meta';
    const k = document.createElement('span'); k.className = 'h-kind'; k.textContent = LABELS[r.kind];
    const t = document.createElement('span'); t.textContent = fmtDate(h.at);
    meta.append(k, t);
    const title = document.createElement('div'); title.className = 'h-title'; title.textContent = summary(r, h.text);
    b.append(meta, title);
    b.onclick = () => showResult(h.text, h.id);
    li.append(b); ul.append(li);
  }
}

function openHistory() { stopCamera(); $('sheet').hidden = true; renderHistory(); $('history').hidden = false; }
function closeHistory() { $('history').hidden = true; startCamera(); }

function csvCell(v) { return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function exportCsv() {
  const list = loadHistory();
  if (!list.length) return;
  const rows = [['日時', '種類', '見出し', '内容']];
  for (const h of list) { const r = classify(h.text); rows.push([fmtDate(h.at), LABELS[r.kind], summary(r, h.text), h.text]); }
  const csv = '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'); // 先頭のBOMでExcelでも文字化けしない
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const name = `qr-history-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('CSVを保存しました');
}

// 全削除は2回押しで確定（誤操作防止）
let clearArmed = null;
function resetClear() { clearTimeout(clearArmed); clearArmed = null; const b = $('clearHistory'); b.textContent = 'すべて削除'; b.classList.remove('danger'); }
$('clearHistory').onclick = () => {
  const b = $('clearHistory');
  if (!clearArmed) { b.textContent = 'もう一度押すと削除'; b.classList.add('danger'); clearArmed = setTimeout(resetClear, 3000); return; }
  saveHistory([]); renderHistory(); toast('履歴をすべて削除しました');
};

$('openHistory').onclick = openHistory;
$('closeHistory').onclick = closeHistory;
$('exportCsv').onclick = exportCsv;

function closeSheet() {
  $('sheet').hidden = true;
  if (resultFromHistory) { resultFromHistory = null; renderHistory(); }
  else startCamera();
}
$('close').onclick = closeSheet;
$('retry').onclick = startCamera;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if ($('sheet').hidden && $('history').hidden && !stream) startCamera();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// テスト用に公開
window.__qr = { classify, showResult, loadHistory, setupControls, get digitalZoom() { return digitalZoom; } };

startCamera();
