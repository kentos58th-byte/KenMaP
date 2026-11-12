# ABCDEクエスト（abcde-quest）

KenMaP の中のアプリです。病室で患者さんと話し、観察し、急変の前ぶれに気づいて医師へ報告する症例シミュレーション。

## ファイル
| ファイル | 役割 |
|---|---|
| `index.html` | 画面の見た目（症例の一覧＋ゲーム画面） |
| `game.js` | ゲームの仕組み（どの症例でも共通） |
| `cases/index.json` | **症例の一覧**（一覧画面に出す症例のリスト） |
| `cases/case01-sepsis.json` | **症例1：術後の「なんか変」（監修用）** |
| `case-template.json` | 新しい症例を書くためのひな形 |

## 新しい症例を足すには
1. `case-template.json` をコピーして、`cases/case02-○○.json` として保存
2. 中身を書きかえる（説明は「_」で始まる項目に書いてあります）
3. `cases/index.json` の `cases` に1件足す（id・file・タイトルなど）
4. KenMaP の `sw.js` の `ASSETS` に `./abcde-quest/cases/case02-○○.json` を足し、`VERSION` を上げる

## 症例ファイルに入っているもの
- `vitals` … バイタルの経過（時間ごとの値）
- `actions` … 観察・ケアごとの所見
- `zones` … 体をタップしたときの見た目の描写
- `patient` … 患者の設定・話し方・返事
- `events` … 時間で起こる出来事
- `expert` … 熟練看護師の動き
- `assessment.expert` … アセスメント例
- `sbarExample` … SBAR の例

## AI について
claude.ai のアーティファクトとして開いたときは、AI が患者役・医師役を演じ、振り返りのコメントも書きます。
KenMaP（GitHub Pages）の上では AI は使えないため、**簡易モード**で動きます：
- 患者の返事 … `patient.replies` の決まった返事
- 観察・ケア … `actions` の `match` の言葉で判定
- 報告 … `report.choices` の選択式 SBAR

※ JSON は「,」や「"」が1つ抜けるだけで読み込めなくなります。直したあとは公開ページで確認してください。
