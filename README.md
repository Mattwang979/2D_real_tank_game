# PENETRATION

俯視角二戰坦克對戰手機網頁遊戲，核心是擬真的裝甲、乘員與模組損傷模擬。
A top-down WWII tank game for phones (landscape) with realistic armor, crew and module simulation.

**▶ 線上遊玩 / Play:** https://mattwang979.github.io/2D_real_tank_game/

> 手機請橫向遊玩。用瀏覽器「加入主畫面」後會以全螢幕橫向啟動。

## 玩法

| 操作 | 說明 |
| --- | --- |
| 左半螢幕拖曳 | 移動搖桿：往哪個方向推，坦克就轉向開過去；往後拉會倒車 |
| 右半螢幕拖曳 | 瞄準搖桿：砲塔轉向拖曳方向，**放開即開火**；拖回中心圈內放開可取消 |
| 右半螢幕點一下 / FIRE 鍵 | 朝目前砲管方向開火 |
| 彈種按鈕 | 切換穿甲彈 / 次口徑彈 / 高爆彈（換彈需要重新裝填） |
| 🧯 | 起火時滅火（30 秒冷卻） |
| ⌕ | 望遠鏡：拉遠視野 |

- **模式**：佔領中央的 A 點。佔住 A 點會持續扣敵方分數，擊毀敵車也會扣分；先把對方分數扣光、或消滅對方所有車輛就獲勝。
- **視野**：車身周圍一圈近距視野 + 沿砲管方向的錐形遠視野，會被建築物遮擋；躲在樹叢裡較難被發現，開砲會暴露位置。
- **瞄準準星顏色**：綠 = 可擊穿、黃 = 可能擊穿、紅 = 打不穿或會跳彈，底部會顯示該部位的等效裝甲與你的穿深。
- **陣容**：每場最多帶 3 台車，被擊毀後可以換下一台重新出擊。

## 擬真損傷模擬

- 每台車有車體與砲塔的裝甲板（厚度、垂直傾角），依入射角換算等效裝甲；高角度會跳彈，大口徑可「過壓」(overmatch)。
- 履帶與裙板是間隙裝甲；次口徑彈打到裙板損失較多穿深。
- 擊穿後模擬彈芯與錐形破片進入車內，打到引擎、變速箱、油箱、彈藥架、砲閂與乘員（駕駛 D、無線電員 R、砲手 G、車長 C、裝填手 L）。
- 被帽穿甲彈（APHE）延遲引信在車內爆炸；高爆彈對開頂車與薄裝甲有超壓傷害。
- 彈藥架可能殉爆（砲塔被炸飛）、油箱與引擎可能起火；乘員陣亡後由其他乘員補位；損壞模組會自動維修。
- 命中時右側會出現 **X 光擊殺畫面**，顯示彈道、破片與受損模組。

## 載具（23 台，美 / 德 / 蘇，四個階級）

USA：M24 Chaffee、M4A2 Sherman、M10 GMC、M4A3 (76) W、M18 Hellcat、M26 Pershing、M46 Patton
Germany：Sd.Kfz. 234/2 Puma、Pz.Kpfw. IV H、StuG III G、Panther D、Panther G、Tiger I、Tiger II (H)
USSR：T-34 (1941)、SU-85、T-34-85、IS-1、T-44、IS-2 (1944)、ISU-122S、IS-3、T-54 (1949)

數據為史實近似值。戰鬥獲得 RP（研發點數）與 CR（銀幣），在科技樹研發並購買新車；進度存在瀏覽器裡。

## 開發

```bash
npm install
npm run dev      # 本機開發伺服器
npm run build    # 輸出到 dist/
```

- TypeScript + HTML5 Canvas 2D + Vite，沒有遊戲引擎、沒有外部圖片或音效檔：所有坦克、地圖、特效都是程式繪製，音效用 WebAudio 合成。
- 推到 `main` 會由 GitHub Actions 自動建置並發佈到 `gh-pages` 分支（GitHub Pages）。
- `dev-sheet.html`（`npm run dev` 後開 `/dev-sheet.html?mode=tank|xray|armor`）可以一次檢視所有坦克的外觀、X 光與裝甲圖。

### 程式結構

```
src/
  data/vehicles.ts     載具、砲、彈種、裝甲資料
  game/blueprint.ts    由資料產生裝甲多邊形、模組與乘員位置
  game/armor.ts        彈道命中、等效裝甲、跳彈、破片與傷害
  game/tank.ts         坦克物理、砲塔、裝填、乘員補位、維修
  game/battle.ts       戰鬥流程、碰撞、佔點、計分、重生、獎勵
  game/ai.ts / nav.ts  AI 指揮官與 A* 尋路
  game/vision.ts       視野多邊形與偵察
  game/map.ts          三張地圖的程序化佈局
  render/*             坦克繪製、地圖分塊快取、戰鬥畫面與戰爭迷霧
  ui/*                 車庫、科技樹、HUD 觸控操作、X 光擊殺畫面、結算
```
