# 研究 PDF 品牌样式

样式标识：soochow-zhangjiagang-research-v2。

- A4，默认纵向；原 PDF 宽页面按 A4 横向保留。
- 品牌蓝 #174F78，正文 #203249，淡灰蓝表头 #F3F6FA。
- 左右 20 mm 页边距；页头保留项目原有东吴证券蓝色 logo，右侧独立显示张家港营业部；页脚显示营业部和页码。
- 保留标题封面，不自动添加研究截止日、范围、记录时间、出处、编号、版本字段或内容摘要。追溯信息保存在 PDF 属性与后台记录中。
- 正文按用户问题和实际研究内容自由组织，不强制研究字段、摘要或固定章节；保留正文中的引用，表格跨页重复表头。
- 中文字体随 PDF 嵌入；正文 10 pt、16 pt 行距，主标题 25 pt，章节标题 16 pt，表格 8 pt。
- 研究 PDF 由服务端添加品牌封面，原始 Markdown、CSV、JSON、图片和 PDF 保留用于计算和追溯；用户明确要求的其他格式按原格式交付。

Logo 来源见 apps/web/public/brand/SOURCE.md。未重新绘制或把营业部文字拼接进标识。

字体为系统已安装 Noto Sans SC v2.04 的静态 400/700 字重，保留原有字形和字体版权元数据。许可全文为本目录 OFL.txt；字体仅用于此模板排版，未单独销售。静态实例构建不要求生产环境安装 fontTools。

字体原版权声明：
© 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.

许可来源：https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE
