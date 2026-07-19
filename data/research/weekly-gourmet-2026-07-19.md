# 週次スポット調査 2026-07-19

## 今週の新規グルメ登録

### 発酵Cafe 土にね。（熊本県荒尾市）

- 2026年7月2日開店。
- 糀・発酵調味料を使った発酵花籠ランチ、発酵ローストビーフ丼、発酵ビビンバなど、目的地にしやすい特徴がある。
- 割烹居酒屋 徳蔵での昼間借り営業。駐車場あり。
- 登録ID: `gourmet-arao-tsuchinine`
- 座標: `32.98831062, 130.47825663`

根拠:

- https://chikugo-ikoi.com/tsuchinine-open/
- https://www.instagram.com/tsuchinine/
- https://map.yahoo.co.jp/v3/place/jK7Wd8qIREo

### カフェ ポ・ト・フー（宮崎県宮崎市）

- 2026年3月に、文化公園前の旧フレンチ店を事業承継してカフェとして再始動。
- 米粉クレープ、焼き立てパン、ホットサンド、季節のドリンクを提供。
- テラス席と駐車場3台あり。文化公園・宮崎神宮方面の軽食休憩に組み込みやすい。
- 登録ID: `gourmet-miyazaki-pot-au-feu-cafe`
- 座標: `31.93610406, 131.41817135`

根拠:

- https://townmiyazaki.ne.jp/hot_potaufeu_202605/
- https://www.umk.co.jp/news/?date=20260622&id=33341
- https://www.instagram.com/potaufeu_2026/
- https://map.yahoo.co.jp/v3/place/vTlTTXzsO3s

### The曜terraceカフェ（長崎県平戸市）

- 2025年6月開業。
- 江戸期の梁を残す米蔵を再生したカフェで、カステラ入りソフトクリームや平戸の「ごちゃづけ」を提供。
- 専用駐車場はないが、歴史建築、平戸名物、平戸城下町散策を組み合わせられる目的地性を評価して採用。
- 登録ID: `gourmet-hirado-the-terras-cafe`
- 座標: `33.37185789, 129.55301498`

根拠:

- https://www.hirado-net.com/purpose/detail.php?c=15&id=120
- https://hirado-net.com/topics/detail.php?id=4
- https://thteteracce.booking.chillnn.com/
- https://map.yahoo.co.jp/v3/place/qZKYBcve-uo

## 既存登録・重複チェック

確認対象:

- `data/kyushu-spots.json`
- `data/weekly-gourmet-spots.json`

判定項目:

- IDの完全一致
- 正規化した名称の一致
- 県・カテゴリの一致
- 住所・エリアの一致または類似
- 緯度経度が近い同カテゴリスポット

結果:

- 発酵Cafe 土にね。：同名、荒尾市緑ヶ丘周辺の近接gourmet登録なし。
- カフェ ポ・ト・フー：同名、宮崎市神宮西周辺の近接gourmet登録なし。
- The曜terraceカフェ：同名、平戸市浦の町周辺の近接gourmet登録なし。
- 既存の週次4件は既に登録済みのため、今回の新規件数には含めない。

`npm run prepare-spots` 実行時には、適用スクリプトが同一ID、正規化名称、同県・同カテゴリで150m以内の近接重複を再判定する。

## 定番・非グルメ別枠バックログ

### 道の駅ウェルネスあらお（熊本県荒尾市）

2026年6月5日に開業した荒尾市初の道の駅。地元農水産物・特産品・飲食店、有明海を望むテラス、24時間トイレ、EV急速充電、RVパークを備える。週次グルメ枠とは分離し、休憩・補給スポットの一括登録候補とする。

確認した既存データ範囲では同名登録なし。一括登録前に、全件を対象にID・名称・150m以内の近接restカテゴリを再確認する。

```json
{
  "id": "roadside-station-wellness-arao",
  "name": "道の駅ウェルネスあらお",
  "category": "rest",
  "lat": 32.991024,
  "lng": 130.427091,
  "area": "熊本県",
  "tags": ["roadside_station", "熊本県", "rest", "荒尾", "有明海", "new", "touring"],
  "description": "2026年6月に開業した荒尾市初の道の駅。地元農水産物・特産品・飲食店、有明海と夕陽を望むテラス、24時間トイレ、EV充電、RVパークを備え、福岡県南部と熊本県北部をつなぐ補給・休憩拠点に向く。",
  "images": []
}
```

根拠:

- https://www.city.arao.lg.jp/0/12376.html
- https://wellness-arao.jp/
- https://www.michi-no-eki.jp/stations/views/22402
- https://map.yahoo.co.jp/v3/place/qpV6g5G4uxQ
