'use strict';
// QRリーダー ステップ1：起動即スキャン・自動判別・画像からの読み取り

const $ = (id) => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
let stream = null, scanning = false, detector = null;

if ('BarcodeDetector' in window) {
  try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
}

// ---------- 読み取り ----------
async function decodeSource(src, w, h) {
  if (detector) {
    try {
      const codes = await detector.detect(src);
      if (codes.length) return codes[0].rawValue;
    } catch (e) { /* jsQRで再試行 */ }
  }
  if (!w || !h) return null;
  const scale = Math.min(1, 1000 / Math.max(w, h));
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}

async function startCamera() {
  $('retry').hidden = true;
  setStatus('カメラを起動しています…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
    });
    video.srcObject = stream;
    await video.play();
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

function stopCamera() {
  scanning = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    const text = await decodeSource(video, video.videoWidth, video.videoHeight);
    if (text && scanning) { if (navigator.vibrate) navigator.vibrate(60); stopCamera(); showResult(text); return; }
  }
  setTimeout(() => requestAnimationFrame(loop), 120);
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const text = await decodeSource(bmp, bmp.width, bmp.height);
    if (text) { stopCamera(); showResult(text); }
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

function showResult(raw) {
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

$('close').onclick = () => { $('sheet').hidden = true; startCamera(); };
$('retry').onclick = startCamera;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if ($('sheet').hidden && !stream) startCamera();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// テスト用に公開
window.__qr = { classify, showResult };

startCamera();
