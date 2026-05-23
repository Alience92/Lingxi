---
name: feedback-design-assets-not-svg
description: 永远不要用AI手绘SVG替代用户的设计素材；用真实导出的PNG/SVG+CSS Sprite或img引用
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcdea4de-54c5-4149-a151-96a6a2c95ba1
---

**Why:** 经过 v1-v8 八个版本迭代，AI手写的SVG相机/铅笔与用户原版设计差距被形容为"人类和恐龙的区别"。设计师在Figma/Illustrator里画的插画，AI手写SVG永远无法精确还原。

**How to apply:**
1. 用户有设计素材时，提取为独立PNG，用 `<img>` 或 CSS `background-image` + `background-position`（Sprite）引用——零质量损失
2. AI只负责：布局、配色、字体、组件、间距——这些是代码层面能做到像素级精确的
3. 如需SVG装饰元素，必须从设计稿导出为SVG文件，绝对不要手写路径
4. 如果用户没有独立素材但有多元素合并的PNG Sheet，先提取裁剪（Python PIL），若裁剪不准则直接用CSS Sprite定位
5. CSS Sprite技巧：`mix-blend-mode: multiply` 可融合线稿的底色，`background-size`设为原图宽高，`background-position`用负值定位
