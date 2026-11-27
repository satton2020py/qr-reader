'use strict';
// QRリーダー ステップ1：起動即スキャン・自動判別・画像からの読み取り

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
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: inversion });
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
    const side = Math.min(w, h) * 0.75;
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

function stopCamera() {
  scanning = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    const text = await decodeSource(video, video.videoWidth, video.videoHeight, true);
    if (text && scanning) { if (navigator.vibrate) navigator.vibrate(60); stopCamera(); showResult(text); return; }
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
