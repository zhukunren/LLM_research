# 东吴证券标识来源

更新日期：2026-09-29。最终使用用户指定参考项目 `D:/项目/急速回测_重构版/web/frontend` 中的标识资源，没有重新绘制或拼字。

- 官网：https://www.dwzq.com.cn/
- `soochow-white.png`：参考项目 `src/assets/soochow-securities-white.png`。
- `soochow-blue.png`：参考项目 `src/assets/soochow-securities.png`。
- `soochow-symbol-white.png` / `soochow-symbol-blue.png`：原图左侧图形部分的无缩放裁切，范围 `(0, 0, 90, 70)`，用于窄侧栏和站点图标。
- `soochow-favicon.png`：由蓝色符号图上下补透明留白生成的 `90 × 90` 正方形图标，避免浏览器按正方形显示时压缩标识。

界面样式参考 `D:\项目\急速回测_重构版\web\frontend` 下的 `src/design-tokens.css`、`src/app/research-workspace.css`、`src/index-browsing-theme.css` 和 `src/research-reading-surfaces.css`。配色与参考项目统一：品牌蓝 `#174F78`、青色强调 `#087E8B`、浅灰蓝背景 `#F3F6FA`、蓝灰正文 `#203249`，图表线色为 `#32839B`。导航与页头使用白底，资料阅读区使用白色内容带、细分隔线和低饱和选中状态。导航保留左侧栏，窄屏收为图标栏，手机使用底部导航。Logo 自身保留原图色值。行情中的红涨绿跌属于数据语义，独立于品牌色。

“张家港营业部 / 投研工作台”以普通界面文字呈现，不拼接进官方标识。

2026-10-07 对话布局更新：恢复品牌蓝 `#174F78` 作为主要操作色，使用浅灰蓝侧栏和白色阅读区；原始蓝色标识用于侧栏顶部。手机采用可收起的侧边导航，研究成果和引用原文按需在右侧打开。未改动标识图片及红涨绿跌的数据语义。
