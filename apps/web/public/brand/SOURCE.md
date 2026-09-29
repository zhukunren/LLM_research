# 东吴证券标识来源

更新日期：2026-09-29。最终使用用户指定参考项目 `D:/项目/急速回测_重构版/web/frontend` 中的标识资源，没有重新绘制或拼字。

- 官网：https://www.dwzq.com.cn/
- `soochow-white.png`：参考项目 `src/assets/soochow-securities-white.png`。
- `soochow-blue.png`：参考项目 `src/assets/soochow-securities.png`。
- `soochow-symbol-white.png` / `soochow-symbol-blue.png`：原图左侧图形部分的无缩放裁切，范围 `(0, 0, 90, 70)`，用于窄侧栏和站点图标。
- `soochow-favicon.png`：由蓝色符号图上下补透明留白生成的 `90 × 90` 正方形图标，避免浏览器按正方形显示时压缩标识。

界面样式参考 `src/design-tokens.css`、`src/app/research-workspace.css` 和 `src/research-reading-surfaces.css`：白色顶栏、浅灰蓝画布、主色 `#174F78`、辅助色 `#087E8B`。按用户后续要求，导航保留左侧栏，使用参考项目的白色侧栏色板；窄屏收为图标栏，手机使用底部导航。Logo 自身保留原图色值。行情中的红涨绿跌属于数据语义，独立于品牌色。

“张家港营业部 / 投研工作台”以普通界面文字呈现，不拼接进官方标识。
