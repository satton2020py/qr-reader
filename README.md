# QRリーダー

スマホのブラウザで動くQRコードリーダー（PWA）。

- 開くとすぐカメラが起動して読み取り
- URL・Wi-Fi・電話番号・メールなどを自動で判別
- アルバムの画像やスクリーンショットからも読み取り

ビルド不要。`index.html` を https で配信すれば動きます（GitHub Pages で公開）。
QRの解析には端末の BarcodeDetector を使い、使えない場合は同梱の jsQR（Apache-2.0）を使います。
