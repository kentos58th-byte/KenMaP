# KenMaP

医療ケアの学習アプリをまとめたハブです。PWA 対応で、ホーム画面に追加するとオフラインでも使えます。

## フォルダ構成

```
kenmap/
├─ index.html            ハブ (アプリ一覧の入口)
├─ manifest.webmanifest  PWA 設定 (アプリ名・アイコン)
├─ sw.js                 オフライン用キャッシュ (全アプリ共通)
├─ icons/                KenMaP のアイコン
└─ respiratory/          呼吸ケアマップ
   └─ index.html
```

## 新しいアプリを追加するとき

1. `kenmap/` の中に新しいフォルダ (例: `quiz/`) を作り、`index.html` を入れる
2. ハブの `index.html` にある `APPS` に1件追加する
3. `sw.js` の `ASSETS` に `'./quiz/'` と `'./quiz/index.html'` を足し、`VERSION` を上げる

## 更新するとき

ファイルを書き換えたら `sw.js` の `VERSION` を `v2`, `v3` … と上げてからアップロードしてください。

## メモ・進捗の保存先

各アプリのメモは、使っている端末のブラウザ内 (localStorage) にだけ保存されます。
