# Crisp Recall

Crisp Recall turns ordinary Obsidian Markdown into lightweight active-recall prompts and flashcard sessions.

## Features

- Cloze prompts from Markdown highlights such as `==answer==`.
- Question-and-answer cards using `Question :: Answer`.
- Bidirectional cards using `Front ::: Back`.
- Formulas: cloze a whole formula or part of one, and use a formula or a `$$` math block as an answer.
- Click-to-reveal answers directly in reading mode.
- Focused review sessions for the active note or a random vault-wide set.
- Spaced repetition with FSRS-5: every rating schedules the card's next review, and **Review cards due today** brings back what is due.
- A compact reading controller for revealing answers or starting practice.

## Activation

Crisp Recall requires activation. Any valid Crisp Suite or Crisp-series plugin activation code can activate it from **Settings → Crisp Recall**.

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub Release.
2. Put them in `<vault>/.obsidian/plugins/crisp-recall/`.
3. Enable **Crisp Recall** in Obsidian community plugin settings.
4. Open Crisp Recall settings and enter a valid Crisp activation code.

## Markdown syntax

```markdown
Question :: Answer
Front ::: Back
Remember ==this part==.
The capital is {c1::Paris}.
Euler's identity is ==$e^{i\pi}+1=0$==.
Mass–energy: $E==mc^2==$
Euler's identity ::
$$
e^{i\pi}+1=0
$$
```

---

# 中文说明

Crisp Recall 把普通 Markdown 直接变成低摩擦的主动回忆与闪卡练习。

## 核心功能

- 将 `==答案==` 渲染成可点击揭晓的挖空提示。
- 使用 `问题 :: 答案` 创建问答卡。
- 使用 `正面 ::: 背面` 创建双向卡片。
- 公式：可以挖空整个公式或其中一部分（在公式里写 `==…==`），也可以用公式或 `$$` 公式块作答案（写在 `问题 ::` 的下一行）。
- 在阅读模式直接遮罩或揭晓答案。
- 对当前笔记进行集中练习，或从整个仓库随机抽取闪卡。
- 基于 FSRS-5 的间隔重复：每次评分都会排好下次复习，用「今日到期复习」命令复习到期卡片。
- 通过右下角轻量控制器快速翻转或开始抽认。

## 激活

Crisp Recall 需要激活。任一有效的 Crisp Suite 或其他 Crisp 系列插件激活码，都可以在 **设置 → Crisp Recall** 中完成激活。

## 开发检查

```sh
npm run check
```
