/* ==========================================================================
   Crisp Recall — Zero-Friction Active Recall & Zen Flashcard Engine (v0.2.0)
   Crafted by letschips (Xiaohongshu)
   ========================================================================== */

const { Plugin, Modal, Setting, PluginSettingTab, Notice, requestUrl } = require("obsidian");

const DEFAULT_SETTINGS = {
  enableCloze: true,
  enableDoubleColon: true,
  enableCallouts: true,
  enableFloatingPill: true,
  clozeDelimiter: "==",
  autoMaskInReadingView: true,
  licenseCode: "",
};

const CRISP_LICENSE_VERIFY_URL = "https://crisp-license.helloherve-xsn.workers.dev/api/verify-device";
const CRISP_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiz41HIDpD59SH3DjKnovUO+EEhTJXjvmiug/ev9t4ZQ=
-----END PUBLIC KEY-----`;
const CRISP_PRODUCT_PLUGIN_IDS = new Map([
  ["Crisp Suite", "crisp-recall"],
  ["Crisp Organize", "crisp-organize"],
  ["Crisp ASR", "crisp-asr"],
  ["Crisp Annotations", "crisp-annotations"],
  ["Crisp File Explorer", "crisp-file-explorer"],
  ["Crisp Focus", "crisp-focus"],
  ["Crisp Reading Rail", "crisp-reading-rail"],
  ["Crisp Base", "crisp-base"],
  ["Crisp Recall", "crisp-recall"],
]);
const CRISP_PLUGIN_IDS = new Set(CRISP_PRODUCT_PLUGIN_IDS.values());

function base64UrlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function resolveRecallLicensePermission(payload) {
  const fallbackPluginId = CRISP_PRODUCT_PLUGIN_IDS.get(payload?.product);
  if (!fallbackPluginId) {
    return { allowed: false, reason: "授权码不属于 Crisp 系列插件" };
  }

  const features = Array.isArray(payload.features) ? payload.features : [];
  if (features.includes("all") || features.includes("crisp-recall")) {
    return { allowed: true, onlinePluginId: "crisp-recall" };
  }
  const originalPluginId = features.find((feature) => CRISP_PLUGIN_IDS.has(feature));
  return {
    allowed: true,
    onlinePluginId: originalPluginId || fallbackPluginId,
  };
}

function getCryptoSubtle() {
  return globalThis.crypto?.subtle || (typeof window !== "undefined" ? window.crypto?.subtle : null);
}

async function importEd25519PublicKey(pem) {
  const subtle = getCryptoSubtle();
  if (!subtle) throw new Error("WebCrypto 在当前环境不可用");
  const pemContents = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const der = base64UrlToUint8Array(pemContents);
  const derBuffer = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength);
  return subtle.importKey("spki", derBuffer, { name: "Ed25519" }, true, ["verify"]);
}

function getDeviceId() {
  const app = globalThis.app;
  if (app?.appId) return app.appId;
  if (app?.vault?.getName) return `vault-${encodeURIComponent(app.vault.getName())}`;
  return "device-default";
}

async function verifyCrispRecallLicense(licenseCode, options = {}) {
  const trimmed = typeof licenseCode === "string" ? licenseCode.trim() : "";
  if (!trimmed) return { valid: false, reason: "授权码为空" };

  const parts = trimmed.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "授权码格式无效（必须包含 payload 与签名）" };
  }

  const [payloadBase64, signatureBase64] = parts;
  try {
    const payloadBytes = base64UrlToUint8Array(payloadBase64);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    const permission = resolveRecallLicensePermission(payload);
    if (!permission.allowed) return { valid: false, reason: permission.reason };

    if (payload.expiresAt) {
      const expiresAt = new Date(payload.expiresAt).getTime();
      const now = options.now ? options.now() : Date.now();
      if (Number.isFinite(expiresAt) && now > expiresAt) {
        return {
          valid: false,
          reason: `授权已于 ${String(payload.expiresAt).split("T")[0]} 到期`,
        };
      }
    }

    const subtle = getCryptoSubtle();
    if (!subtle) throw new Error("WebCrypto 在当前环境不可用");
    const publicKey = await importEd25519PublicKey(options.publicKeyPem || CRISP_PUBLIC_KEY_PEM);
    const signature = base64UrlToUint8Array(signatureBase64);
    const signatureBuffer = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    );
    const data = new TextEncoder().encode(payloadBase64);
    const dataBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const signatureValid = await subtle.verify("Ed25519", publicKey, signatureBuffer, dataBuffer);
    if (!signatureValid) return { valid: false, reason: "授权签名无效或伪造" };

    const onlineRequest = options.request || requestUrl;
    try {
      const response = await onlineRequest({
        url: CRISP_LICENSE_VERIFY_URL,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseCode: trimmed,
          deviceId: (options.getDeviceId || getDeviceId)(),
          action: "activate",
          pluginId: permission.onlinePluginId,
        }),
      });
      const cloudResult = response.json;
      if (cloudResult && typeof cloudResult.valid === "boolean") {
        if (!cloudResult.valid) {
          return { valid: false, reason: cloudResult.reason || "设备数已达上限" };
        }
        return { valid: true, payload, message: cloudResult.message || null };
      }
    } catch {
      console.debug("Crisp Recall license online check offline fallback");
    }

    return { valid: true, payload, message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `解析授权码失败：${message}` };
  }
}

// --------------------------------------------------------------------------
// 1. Flashcard Extractor Engine
// --------------------------------------------------------------------------
function maskInlineCode(text) {
  const masked = text.split("");
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      index++;
      continue;
    }

    let markerEnd = index;
    while (text[markerEnd] === "`") markerEnd++;
    const marker = text.slice(index, markerEnd);
    const closingIndex = text.indexOf(marker, markerEnd);
    if (closingIndex === -1) {
      index = markerEnd;
      continue;
    }

    masked.fill(" ", index, closingIndex + marker.length);
    index = closingIndex + marker.length;
  }

  return masked.join("");
}

function stripCardPrefix(text) {
  return text.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim();
}

function findDoubleColonSeparator(searchableLine) {
  const withoutAnkiClozes = searchableLine.replace(/\{c\d+::[^}]+\}/gi, (match) => " ".repeat(match.length));
  const doubleIndex = withoutAnkiClozes.indexOf("::");
  if (doubleIndex === -1) return null;

  const tripleIndex = withoutAnkiClozes.indexOf(":::");
  const isBiDirectional = tripleIndex === doubleIndex;
  return {
    index: doubleIndex,
    separator: isBiDirectional ? ":::" : "::",
    isBiDirectional,
  };
}

function parseDoubleColonLine(line) {
  const separatorInfo = findDoubleColonSeparator(maskInlineCode(line));
  if (!separatorInfo) return null;

  const prompt = stripCardPrefix(line.slice(0, separatorInfo.index));
  const answer = line.slice(separatorInfo.index + separatorInfo.separator.length).trim();
  if (!prompt || !answer || /^https?:\/\//i.test(prompt)) return null;

  return { prompt, answer, isBiDirectional: separatorInfo.isBiDirectional };
}

function parseFlashcardsFromText(text, filePath = "", options = {}) {
  const cards = [];
  const lines = text.split("\n");
  const enableCloze = options.enableCloze !== false;
  const enableDoubleColon = options.enableDoubleColon !== false;
  let inFrontmatter = false;
  let fence = null;

  for (let i = 0; i < lines.length; i++) {
    const line = (i === 0 ? lines[i].replace(/^\uFEFF/, "") : lines[i]).trim();

    if (i === 0 && line === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === "---" || line === "...") inFrontmatter = false;
      continue;
    }

    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (!line) continue;

    // Structural Markdown is documentation, not card content.
    if (line.startsWith("|") || /^#{1,6}\s/.test(line)) continue;

    const searchableLine = maskInlineCode(line);

    // 1. Double colon cards: "Prompt :: Answer" or "Prompt ::: Answer"
    const doubleColonCard = enableDoubleColon ? parseDoubleColonLine(line) : null;
    if (doubleColonCard) {
      cards.push({
        id: `${filePath}:${i}:concept`,
        type: "concept",
        typeName: doubleColonCard.isBiDirectional ? "双向概念卡" : "问答 / 概念卡",
        prompt: doubleColonCard.prompt,
        answer: doubleColonCard.answer,
        line: i,
        filePath: filePath,
      });
      if (doubleColonCard.isBiDirectional) {
        cards.push({
          id: `${filePath}:${i}:concept:reverse`,
          type: "concept",
          typeName: "双向概念卡",
          prompt: doubleColonCard.answer,
          answer: doubleColonCard.prompt,
          line: i,
          filePath: filePath,
        });
      }
      continue;
    }

    // 2. RemNote Descriptor: "Concept ;; Property: Value"
    const descriptorIndex = enableDoubleColon ? searchableLine.indexOf(";;") : -1;
    if (descriptorIndex !== -1) {
      const concept = stripCardPrefix(line.slice(0, descriptorIndex));
      const prop = line.slice(descriptorIndex + 2).trim();
      if (concept && prop) {
        cards.push({
          id: `${filePath}:${i}:descriptor`,
          type: "descriptor",
          typeName: "属性描述卡",
          prompt: `${concept} 的相关属性`,
          answer: prop,
          line: i,
          filePath: filePath,
        });
      }
      continue;
    }

    // 3. Cloze Deletions: ==target== or {c1::target}
    if (!enableCloze) continue;
    const clozeRegex = /==([^=]+)==|\{c\d+::([^}]+)\}/g;
    let match;
    let clozeIdx = 0;
    while ((match = clozeRegex.exec(searchableLine)) !== null) {
      const target = (match[1] || match[2] || "").trim();
      if (!target) continue;
      clozeIdx++;
      // Prompt is the sentence with [ ... ] replacing the target
      const maskedSentence = `${line.slice(0, match.index)} [ ❓ …… ] ${line.slice(match.index + match[0].length)}`;
      cards.push({
        id: `${filePath}:${i}:cloze:${clozeIdx}`,
        type: "cloze",
        typeName: "挖空填空卡",
        prompt: stripCardPrefix(maskedSentence),
        answer: target,
        line: i,
        filePath: filePath,
      });
    }
  }

  return cards;
}

// --------------------------------------------------------------------------
// 2. 3D Zen Flashcard Review Modal
// --------------------------------------------------------------------------
class CrispRecallReviewModal extends Modal {
  constructor(app, cards, title = "Crisp Recall 抽认练习") {
    super(app);
    this.cards = cards;
    this.sessionTitle = title;
    this.currentIndex = 0;
    this.isFlipped = false;
    this.isComplete = false;
    this.stats = { good: 0, hard: 0, again: 0 };
    this.keyHandler = null;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("crisp-recall-modal");
    contentEl.empty();

    if (this.cards.length === 0) {
      this.renderEmptyState();
      return;
    }

    // Setup global keyboard shortcuts for fast review
    this.keyHandler = (e) => {
      if (e.repeat) return;
      const target = e.target;
      if (target?.closest?.("input, textarea, select, button, a, [contenteditable='true']")) return;
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        this.toggleFlip();
      } else if (this.isFlipped) {
        if (e.key === "1") this.rateCard("again");
        else if (e.key === "2") this.rateCard("hard");
        else if (e.key === "3") this.rateCard("good");
      }
    };
    window.addEventListener("keydown", this.keyHandler);

    this.renderCard();
  }

  onClose() {
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.contentEl.empty();
  }

  toggleFlip() {
    if (this.isComplete) {
      this.isFlipped = false;
      return;
    }
    this.isFlipped = !this.isFlipped;
    const cardEl = this.contentEl.querySelector(".crisp-recall-card-3d");
    if (cardEl) {
      cardEl.classList.toggle("is-flipped", this.isFlipped);
      cardEl.setAttr("aria-label", this.isFlipped ? "隐藏答案" : "揭晓答案");
    }
    this.renderFooter();
  }

  rateCard(rating) {
    if (this.isComplete || !this.isFlipped || !Object.hasOwn(this.stats, rating)) return;
    this.stats[rating]++;
    this.currentIndex++;
    this.isFlipped = false;

    if (this.currentIndex >= this.cards.length) {
      this.isComplete = true;
      this.renderSummary();
    } else {
      this.renderCard();
    }
  }

  renderEmptyState() {
    const { contentEl } = this;
    contentEl.empty();
    const empty = contentEl.createDiv("crisp-recall-summary");
    empty.createDiv({ cls: "crisp-recall-summary__icon", text: "📭" });
    empty.createEl("h3", { cls: "crisp-recall-summary__title", text: "当前文档暂无自测闪卡" });
    empty.createEl("p", {
      cls: "crisp-recall-card__flip-hint",
      text: "提示：在文档中输入「问题 :: 答案」或「==高亮挖空==」即可自动生成闪卡！",
    });
    const btn = empty.createEl("button", { cls: "crisp-recall-pill-btn crisp-recall-pill-btn--cta", text: "我知道了" });
    btn.onclick = () => this.close();
  }

  renderCard() {
    const { contentEl } = this;
    contentEl.empty();

    const currentCard = this.cards[this.currentIndex];
    const total = this.cards.length;
    const progressPercent = ((this.currentIndex + 1) / total) * 100;

    // 1. Top Header & Progress Bar
    const header = contentEl.createDiv("crisp-recall-modal__header");
    const titleGroup = header.createDiv("crisp-recall-modal__title-group");
    titleGroup.createDiv({ cls: "crisp-recall-modal__brand", text: `⚡ ${this.sessionTitle}` });
    titleGroup.createDiv({
      cls: "crisp-recall-modal__progress-badge",
      text: `${this.currentIndex + 1} / ${total}`,
    });

    const closeBtn = header.createEl("button", { cls: "crisp-recall-pill-btn", text: "✕ 退出" });
    closeBtn.onclick = () => this.close();

    const progressWrap = header.createDiv("crisp-recall-modal__progress-bar-wrap");
    progressWrap.createDiv({
      cls: "crisp-recall-modal__progress-bar",
      attr: { style: `width: ${progressPercent}%;` },
    });

    // 2. 3D Flip Card Scene
    const scene = contentEl.createDiv("crisp-recall-card-scene");
    const card3d = scene.createDiv(`crisp-recall-card-3d${this.isFlipped ? " is-flipped" : ""}`);
    card3d.setAttr("role", "button");
    card3d.setAttr("tabindex", "0");
    card3d.setAttr("aria-label", this.isFlipped ? "隐藏答案" : "揭晓答案");
    card3d.onclick = () => this.toggleFlip();

    // Front Face (Prompt / Question)
    const frontFace = card3d.createDiv("crisp-recall-card-face crisp-recall-card-face--front");
    const frontTag = frontFace.createDiv("crisp-recall-card__type-tag");
    frontTag.createSpan({ text: `💡 ${currentCard.typeName}` });
    frontFace.createDiv({ cls: "crisp-recall-card__content", text: currentCard.prompt });
    frontFace.createDiv({ cls: "crisp-recall-card__flip-hint", text: "点击卡片或按 [Space] 查看答案" });

    // Back Face (Answer)
    const backFace = card3d.createDiv("crisp-recall-card-face crisp-recall-card-face--back");
    const backTag = backFace.createDiv("crisp-recall-card__type-tag");
    backTag.createSpan({ text: "✅ 答案解析" });
    backFace.createDiv({ cls: "crisp-recall-card__content", text: currentCard.answer });
    backFace.createDiv({ cls: "crisp-recall-card__flip-hint", text: "请评估你的记忆掌握程度 (按 1 / 2 / 3)" });

    // 3. Bottom Footer Actions
    this.footerEl = contentEl.createDiv("crisp-recall-modal__footer");
    this.renderFooter();
  }

  renderFooter() {
    if (!this.footerEl) return;
    this.footerEl.empty();

    if (!this.isFlipped) {
      const flipBtn = this.footerEl.createEl("button", {
        cls: "crisp-recall-pill-btn crisp-recall-pill-btn--cta",
        text: "揭晓答案 (Space / Enter)",
      });
      flipBtn.onclick = () => this.toggleFlip();
    } else {
      const gradingGroup = this.footerEl.createDiv("crisp-recall-grading-group");

      const againBtn = gradingGroup.createEl("button", { cls: "crisp-recall-grade-btn crisp-recall-grade-btn--again" });
      againBtn.createSpan({ text: "🔴 没记住" });
      againBtn.createSpan({ cls: "crisp-recall-grade-btn__key", text: "按 1" });
      againBtn.onclick = () => this.rateCard("again");

      const hardBtn = gradingGroup.createEl("button", { cls: "crisp-recall-grade-btn crisp-recall-grade-btn--hard" });
      hardBtn.createSpan({ text: "🟡 有点犹豫" });
      hardBtn.createSpan({ cls: "crisp-recall-grade-btn__key", text: "按 2" });
      hardBtn.onclick = () => this.rateCard("hard");

      const goodBtn = gradingGroup.createEl("button", { cls: "crisp-recall-grade-btn crisp-recall-grade-btn--good" });
      goodBtn.createSpan({ text: "🟢 轻松记下" });
      goodBtn.createSpan({ cls: "crisp-recall-grade-btn__key", text: "按 3" });
      goodBtn.onclick = () => this.rateCard("good");
    }
  }

  renderSummary() {
    const { contentEl } = this;
    contentEl.empty();

    const total = this.cards.length;
    const accuracy = total > 0 ? Math.round((this.stats.good / total) * 100) : 100;

    const summary = contentEl.createDiv("crisp-recall-summary");
    summary.createDiv({ cls: "crisp-recall-summary__icon", text: "🎉" });
    summary.createEl("h2", { cls: "crisp-recall-summary__title", text: "自测练习完成！" });
    summary.createEl("p", {
      cls: "crisp-recall-card__flip-hint",
      text: `本次共复习了 ${total} 张卡片，记忆掌握度达 ${accuracy}%`,
    });

    const statsGroup = summary.createDiv("crisp-recall-summary__stats");
    const s1 = statsGroup.createDiv("crisp-recall-stat-box");
    s1.createDiv({ cls: "crisp-recall-stat-box__val", text: String(this.stats.good) });
    s1.createDiv({ cls: "crisp-recall-stat-box__label", text: "🟢 记住了" });

    const s2 = statsGroup.createDiv("crisp-recall-stat-box");
    s2.createDiv({ cls: "crisp-recall-stat-box__val", text: String(this.stats.hard) });
    s2.createDiv({ cls: "crisp-recall-stat-box__label", text: "🟡 较生疏" });

    const s3 = statsGroup.createDiv("crisp-recall-stat-box");
    s3.createDiv({ cls: "crisp-recall-stat-box__val", text: String(this.stats.again) });
    s3.createDiv({ cls: "crisp-recall-stat-box__label", text: "🔴 待巩固" });

    const actions = summary.createDiv({ cls: "crisp-recall-modal__footer", attr: { style: "width: 100%;" } });
    const retryBtn = actions.createEl("button", { cls: "crisp-recall-pill-btn", text: "🔁 再练一次" });
    retryBtn.onclick = () => {
      this.currentIndex = 0;
      this.isFlipped = false;
      this.isComplete = false;
      this.stats = { good: 0, hard: 0, again: 0 };
      this.renderCard();
    };

    const doneBtn = actions.createEl("button", { cls: "crisp-recall-pill-btn crisp-recall-pill-btn--cta", text: "完成打卡" });
    doneBtn.onclick = () => this.close();
  }
}

// --------------------------------------------------------------------------
// 3. Crisp Recall Plugin Main Class
// --------------------------------------------------------------------------
class CrispRecallPlugin extends Plugin {
  async onload() {
    this.cleanupInjectedUi();
    this.reviewModals = new Set();
    const storedSettings = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings, {
      licenseCode: typeof storedSettings?.licenseCode === "string"
        ? storedSettings.licenseCode.trim()
        : "",
    });
    this.licenseState = { valid: false, payload: null, reason: "尚未输入 Crisp 授权码" };
    await this.refreshLicenseState();

    // 1. Markdown Post Processor: Inline Cloze & Q&A Cards in Reading View
    this.registerMarkdownPostProcessor((element, context) => {
      this.processMarkdownView(element, context);
    });

    // 2. Register Commands
    this.addCommand({
      id: "start-active-note-review",
      name: "Start practice session for active note (开始当前笔记抽认自测)",
      callback: () => this.startActiveNoteReview(),
    });

    this.addCommand({
      id: "start-vault-random-review",
      name: "Start random flashcard review across vault (全库随机抽认自测)",
      callback: () => this.startVaultRandomReview(),
    });

    this.addCommand({
      id: "toggle-all-cloze-masks",
      name: "Toggle all cloze masks in active note (一键切换全篇遮罩/揭晓)",
      callback: () => this.toggleAllMasks(),
    });

    // 3. Add Settings Tab
    this.addSettingTab(new CrispRecallSettingTab(this.app, this));

    console.log("⚡ Crisp Recall Plugin loaded successfully.");
  }

  onunload() {
    if (this.reviewModals) {
      [...this.reviewModals].forEach((modal) => modal.close());
      this.reviewModals.clear();
    }
    this.cleanupInjectedUi();
    console.log("Crisp Recall Plugin unloaded.");
  }

  openReviewModal(cards, title) {
    if (!this.ensureLicenseActivated()) return;
    const modal = new CrispRecallReviewModal(this.app, cards, title);
    if (!this.reviewModals) this.reviewModals = new Set();
    this.reviewModals.add(modal);

    const originalOnClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      try {
        originalOnClose();
      } finally {
        this.reviewModals.delete(modal);
      }
    };
    modal.open();
  }

  cleanupInjectedUi() {
    document.querySelectorAll(".crisp-recall-floating-pill").forEach((pill) => pill.remove());

    document.querySelectorAll(".crisp-recall-card-line").forEach((cardLine) => {
      const originalHtml = cardLine.dataset.crispRecallOriginalHtml;
      if (originalHtml !== undefined) {
        cardLine.innerHTML = originalHtml;
        delete cardLine.dataset.crispRecallOriginalHtml;
      } else {
        // Restore legacy v0.1.0 transformations that predate reversible snapshots.
        const prompt = cardLine.querySelector(".crisp-recall-card-line__prompt")?.textContent || "";
        const divider = cardLine.querySelector(".crisp-recall-card-line__divider")?.textContent || "::";
        const answer = cardLine.querySelector(".crisp-recall-card-line__answer")?.textContent || "";
        cardLine.textContent = `${prompt} ${divider} ${answer}`.trim();
      }
      cardLine.classList.remove("crisp-recall-card-line");
    });

    document.querySelectorAll(".crisp-recall-cloze").forEach((cloze) => {
      cloze.classList.remove("crisp-recall-cloze", "is-revealed");
      if (cloze.title === "单击遮罩 / 翻转揭晓") cloze.removeAttribute("title");
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isLicenseValid() {
    return this.licenseState?.valid === true;
  }

  ensureLicenseActivated() {
    if (this.isLicenseValid()) return true;
    new Notice("Crisp Recall 未激活：请在 设置 → Crisp Recall 输入任一 Crisp 系列激活码。");
    return false;
  }

  async refreshLicenseState() {
    if (!this.settings.licenseCode) {
      this.licenseState = { valid: false, payload: null, reason: "尚未输入 Crisp 授权码" };
      return this.licenseState;
    }
    const result = await verifyCrispRecallLicense(this.settings.licenseCode);
    this.licenseState = result.valid
      ? { valid: true, payload: result.payload, reason: null }
      : { valid: false, payload: null, reason: result.reason || "授权码无效" };
    return this.licenseState;
  }

  async activateLicense(licenseCode) {
    this.settings.licenseCode = typeof licenseCode === "string" ? licenseCode.trim() : "";
    const state = await this.refreshLicenseState();
    await this.saveSettings();
    if (state.valid) this.refreshReadingViews();
    return state;
  }

  async clearLicense() {
    this.settings.licenseCode = "";
    this.licenseState = { valid: false, payload: null, reason: "尚未输入 Crisp 授权码" };
    await this.saveSettings();
    this.cleanupInjectedUi();
    this.refreshReadingViews();
  }

  refreshReadingViews() {
    this.app.workspace?.iterateAllLeaves?.((leaf) => {
      leaf.view?.previewMode?.rerender?.(true);
    });
    this.app.workspace?.updateOptions?.();
  }

  processMarkdownView(element, context) {
    if (!this.isLicenseValid()) return;
    if (!this.settings.enableCloze && !this.settings.enableDoubleColon) return;

    // Process cloze highlights ==target== into interactive mask pills
    if (this.settings.enableCloze) {
      const marks = element.querySelectorAll("mark");
      marks.forEach((mark) => {
        // Skip if inside crisp annotations
        if (
          mark.classList.contains("crisp-recall-cloze") ||
          mark.classList.contains("crisp-ann__target") ||
          mark.closest(".crisp-ann")
        ) return;

        mark.classList.add("crisp-recall-cloze");
        mark.title = "单击遮罩 / 翻转揭晓";
        this.registerDomEvent(mark, "click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          mark.classList.toggle("is-revealed");
        });
      });
    }

    // Double colon lines transformation in Reading Mode
    if (this.settings.enableDoubleColon) {
      const paragraphs = element.querySelectorAll("p, li");
      paragraphs.forEach((el) => {
        const text = el.textContent || "";
        const alreadyProcessed = el.classList?.contains?.("crisp-recall-card-line");
        const containsCode = el.querySelector("code, pre");
        const containsNestedList = el.querySelector("ul, ol");
        if (!alreadyProcessed && !containsCode && !containsNestedList) {
          const card = parseDoubleColonLine(text);
          if (card) {
            const { prompt, answer } = card;

            el.dataset.crispRecallOriginalHtml = el.innerHTML;
            el.empty();
            el.addClass("crisp-recall-card-line");

            const promptSpan = el.createSpan("crisp-recall-card-line__prompt");
            promptSpan.textContent = prompt;

            const dividerSpan = el.createSpan("crisp-recall-card-line__divider");
            dividerSpan.textContent = "::";

            const answerSpan = el.createSpan("crisp-recall-cloze crisp-recall-card-line__answer");
            answerSpan.textContent = answer;
            answerSpan.title = "单击遮罩 / 翻转揭晓";
            answerSpan.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              answerSpan.classList.toggle("is-revealed");
            };
          }
        }
      });
    }

    // Floating Pill Widget at bottom-right of preview view
    if (this.settings.enableFloatingPill) {
      const previewView = element.closest(".markdown-preview-view");
      const floatingHost = previewView?.closest(".workspace-leaf-content") || previewView;
      if (floatingHost) {
        this.injectFloatingWidget(floatingHost, context.sourcePath);
      }
    }
  }

  async injectFloatingWidget(container, sourcePath) {
    if (!this.isLicenseValid()) return;
    const existingPill = container.querySelector(".crisp-recall-floating-pill");
    if (existingPill?.dataset.crispRecallSource === sourcePath) return;

    if (!this.floatingWidgetRequests) this.floatingWidgetRequests = new WeakMap();
    const requestToken = {};
    this.floatingWidgetRequests.set(container, requestToken);
    existingPill?.remove();

    const file = this.app.vault.getFileByPath(sourcePath);
    if (!file) return;

    const content = await this.app.vault.cachedRead(file);
    if (!this.isLicenseValid()) return;
    if (this.floatingWidgetRequests.get(container) !== requestToken) return;
    const cards = parseFlashcardsFromText(content, sourcePath, this.settings);
    if (cards.length === 0) return;
    container.querySelector(".crisp-recall-floating-pill")?.remove();

    const pill = container.createDiv("crisp-recall-floating-pill");
    pill.dataset.crispRecallSource = sourcePath;
    const badge = pill.createDiv("crisp-recall-pill-badge");
    badge.createSpan({ text: "⚡ Recall" });
    badge.createSpan({ cls: "crisp-recall-pill-count", text: `${cards.length}` });

    const toggleBtn = pill.createEl("button", { cls: "crisp-recall-pill-btn", text: "👁️ 翻转全部" });
    toggleBtn.onclick = () => this.toggleAllMasks();

    const reviewBtn = pill.createEl("button", {
      cls: "crisp-recall-pill-btn crisp-recall-pill-btn--cta",
      text: "开始抽认",
    });
    reviewBtn.onclick = () => {
      this.openReviewModal(cards, file.basename);
    };
  }

  toggleAllMasks() {
    if (!this.ensureLicenseActivated()) return;
    const activeContainer = this.app.workspace.activeLeaf?.view?.containerEl;
    const clozes = activeContainer?.querySelectorAll(".crisp-recall-cloze") || [];
    if (clozes.length === 0) {
      new Notice("当前页面没有发现自测挖空或闪卡。");
      return;
    }
    const hasMasked = Array.from(clozes).some((c) => !c.classList.contains("is-revealed"));
    clozes.forEach((c) => {
      if (hasMasked) c.classList.add("is-revealed");
      else c.classList.remove("is-revealed");
    });
    new Notice(hasMasked ? "👁️ 已揭晓全部自测卡片" : "💡 已遮罩全部自测卡片");
  }

  async startActiveNoteReview() {
    if (!this.ensureLicenseActivated()) return;
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("请先打开一篇包含闪卡的 Markdown 笔记。");
      return;
    }
    const content = await this.app.vault.read(activeFile);
    const cards = parseFlashcardsFromText(content, activeFile.path, this.settings);
    if (cards.length === 0) {
      new Notice(`「${activeFile.basename}」中没有检测到 :: 问答或 ==挖空== 闪卡。`);
      return;
    }
    this.openReviewModal(cards, activeFile.basename);
  }

  async startVaultRandomReview() {
    if (!this.ensureLicenseActivated()) return;
    const files = this.app.vault.getMarkdownFiles();
    const allCards = [];
    new Notice("⚡ 正在从全库扫描自测闪卡...");

    let failedReads = 0;
    const batchSize = 25;
    for (let offset = 0; offset < files.length; offset += batchSize) {
      const batch = files.slice(offset, offset + batchSize);
      const results = await Promise.all(batch.map(async (file) => {
        try {
          const content = await this.app.vault.cachedRead(file);
          return parseFlashcardsFromText(content, file.path, this.settings);
        } catch (err) {
          failedReads++;
          console.warn(`Crisp Recall: failed to read ${file.path}`, err);
          return [];
        }
      }));
      results.forEach((cards) => allCards.push(...cards));
    }

    if (allCards.length === 0) {
      new Notice("全库中暂未找到任何自测闪卡，快去笔记中用「::」或「==挖空==」试试吧！");
      return;
    }

    if (failedReads > 0) {
      new Notice(`有 ${failedReads} 篇笔记读取失败，已跳过并继续抽认。`);
    }

    // Fisher-Yates shuffle avoids the bias of Array.sort(() => Math.random() - 0.5).
    for (let i = allCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allCards[i], allCards[j]] = [allCards[j], allCards[i]];
    }
    const shuffled = allCards.slice(0, 20);
    this.openReviewModal(shuffled, "全库随机抽认");
  }
}

// --------------------------------------------------------------------------
// 4. Settings Tab
// --------------------------------------------------------------------------
function renderRecallAboutCard(container) {
  const card = container.createDiv("crisp-recall-about");
  card.createEl("h3", { cls: "crisp-recall-about__title", text: "关于 Crisp Recall" });
  card.createEl("p", {
    cls: "crisp-recall-about__description",
    text: "把普通 Markdown 直接变成低摩擦的主动回忆与闪卡练习。",
  });
  const byline = card.createEl("p", { cls: "crisp-recall-about__author" });
  byline.createSpan({ text: "作者：" });
  byline.createEl("a", {
    cls: "crisp-recall-about__author-link",
    text: "小红书 letschips",
    attr: {
      href: "https://xhslink.cn/m/3MwtKu4822b",
      target: "_blank",
      rel: "noopener noreferrer",
    },
  });
}

class CrispRecallSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.pendingLicenseCode = plugin.settings?.licenseCode || "";
    this.licenseBusy = false;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "⚡ Crisp Recall 设置" });
    containerEl.createEl("p", {
      text: "基于 RemNote 理念的轻量级主动回忆与 3D 闪卡复习引擎，由 letschips 独立自研。",
    });

    const licenseState = this.plugin.licenseState || { valid: false, reason: "尚未输入 Crisp 授权码" };
    const statusSetting = new Setting(containerEl).setName("激活状态");
    if (licenseState.valid && licenseState.payload) {
      const expiresAt = licenseState.payload.expiresAt
        ? ` · 到期 ${String(licenseState.payload.expiresAt).split("T")[0]}`
        : "";
      statusSetting
        .setDesc(`已激活 · ${licenseState.payload.product}${expiresAt}`)
        .addButton((button) => button
          .setButtonText("清除激活")
          .onClick(async () => {
            await this.plugin.clearLicense();
            this.pendingLicenseCode = "";
            new Notice("Crisp Recall 已清除激活信息");
            this.display();
          }));
    } else {
      statusSetting.setDesc(`未激活 · ${licenseState.reason || "请输入 Crisp 系列激活码"}`);
    }

    new Setting(containerEl)
      .setName("Crisp 系列激活码")
      .setDesc("任一有效的 Crisp Suite 或 Crisp 系列插件激活码都可以激活 Crisp Recall。")
      .addText((text) => text
        .setPlaceholder("粘贴 Crisp 激活码...")
        .setValue(this.pendingLicenseCode)
        .onChange((value) => {
          this.pendingLicenseCode = value.trim();
        }))
      .addButton((button) => button
        .setButtonText(this.licenseBusy ? "验证中…" : "激活 / 重新验证")
        .setDisabled(this.licenseBusy)
        .setCta()
        .onClick(async () => {
          this.licenseBusy = true;
          this.display();
          const result = await this.plugin.activateLicense(this.pendingLicenseCode);
          if (result.valid && result.payload) {
            new Notice(`Crisp Recall 激活成功，欢迎使用，${result.payload.userName || "letschips 的朋友"}`);
          } else {
            new Notice(`Crisp Recall 激活失败：${result.reason || "授权码无效"}`);
          }
          this.licenseBusy = false;
          this.display();
        }));

    new Setting(containerEl)
      .setName("启用行内挖空自测 (Cloze Deletion)")
      .setDesc("将文章中的 ==高亮文本== 自动渲染为可点击遮罩/翻转的自测胶囊。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableCloze).onChange(async (v) => {
          this.plugin.settings.enableCloze = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("启用双冒号概念卡 (Concept :: Definition)")
      .setDesc("识别「概念 :: 定义」或「问题 :: 答案」语法，并在阅读模式下自动遮罩答案。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableDoubleColon).onChange(async (v) => {
          this.plugin.settings.enableDoubleColon = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("显示右下角自测浮动药丸 (Floating Recall Controller)")
      .setDesc("在有闪卡的笔记右下角显示轻量控制胶囊，方便一键翻转或开启 3D 抽认。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableFloatingPill).onChange(async (v) => {
          this.plugin.settings.enableFloatingPill = v;
          await this.plugin.saveSettings();
        })
      );

    renderRecallAboutCard(containerEl);
  }
}

module.exports = CrispRecallPlugin;
