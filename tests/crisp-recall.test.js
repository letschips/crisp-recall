const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function loadPlugin({ document } = {}) {
  const notices = [];
  class Plugin {
    constructor(app) {
      this.app = app;
    }
  }
  class Modal {
    constructor(app) {
      this.app = app;
    }
    open() {
      this.opened = true;
    }
  }
  class PluginSettingTab {}
  class Setting {}
  class Notice {
    constructor(message) {
      notices.push(message);
    }
  }

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console,
    atob,
    btoa,
    crypto: webcrypto,
    TextDecoder,
    TextEncoder,
    window: { crypto: webcrypto },
    document: document || { querySelectorAll: () => [] },
    require(id) {
      if (id !== "obsidian") return require(id);
      return {
        Plugin,
        Modal,
        Setting,
        PluginSettingTab,
        Notice,
        requestUrl: async () => {
          throw new Error("Unexpected live request in test");
        },
      };
    },
  };
  const mainPath = path.join(__dirname, "..", "main.js");
  const source = `${fs.readFileSync(mainPath, "utf8")}\n` +
    "globalThis.__crispRecallTest = {" +
    " parseFlashcardsFromText," +
    " CrispRecallReviewModal," +
    " resolveRecallLicensePermission: typeof resolveRecallLicensePermission === 'function' ? resolveRecallLicensePermission : undefined," +
    " verifyCrispRecallLicense: typeof verifyCrispRecallLicense === 'function' ? verifyCrispRecallLicense : undefined," +
    " renderRecallAboutCard: typeof renderRecallAboutCard === 'function' ? renderRecallAboutCard : undefined" +
    " };";
  vm.runInNewContext(source, sandbox, { filename: mainPath });

  return {
    PluginClass: module.exports,
    parseFlashcardsFromText: sandbox.__crispRecallTest.parseFlashcardsFromText,
    ReviewModal: sandbox.__crispRecallTest.CrispRecallReviewModal,
    resolveRecallLicensePermission: sandbox.__crispRecallTest.resolveRecallLicensePermission,
    verifyCrispRecallLicense: sandbox.__crispRecallTest.verifyCrispRecallLicense,
    renderRecallAboutCard: sandbox.__crispRecallTest.renderRecallAboutCard,
    notices,
  };
}

function makeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
  };
}

class FakeElement {
  constructor(className = "", tagName = "div") {
    this.className = className;
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.textContent = "";
    this.parentElement = null;
    this.closestTargets = new Map();
  }

  addChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  createDiv(arg = "") {
    const className = typeof arg === "string" ? arg : arg.cls || "";
    const child = new FakeElement(className, "div");
    if (typeof arg === "object" && arg.text) child.textContent = arg.text;
    return this.addChild(child);
  }

  createSpan(arg = {}) {
    const child = new FakeElement(arg.cls || "", "span");
    if (arg.text) child.textContent = arg.text;
    return this.addChild(child);
  }

  createEl(tagName, arg = {}) {
    const child = new FakeElement(arg.cls || "", tagName);
    if (arg.text) child.textContent = arg.text;
    for (const [name, value] of Object.entries(arg.attr || {})) {
      child.setAttr(name, value);
    }
    return this.addChild(child);
  }

  setAttr(name, value) {
    this.attributes[name] = String(value);
    this[name] = String(value);
  }

  append(...children) {
    children.forEach((child) => this.addChild(child));
  }

  empty() {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
    this.textContent = "";
  }

  querySelector(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    if (className && this.className.split(/\s+/).includes(className)) return this;
    if (!className && this.tagName === selector.toLowerCase()) return this;
    for (const child of this.children) {
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    if (className && this.className.split(/\s+/).includes(className)) matches.push(this);
    if (!className && this.tagName === selector.toLowerCase()) matches.push(this);
    for (const child of this.children) matches.push(...child.querySelectorAll(selector));
    return matches;
  }

  closest(selector) {
    if (this.closestTargets.has(selector)) return this.closestTargets.get(selector);
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    if (className && this.className.split(/\s+/).includes(className)) return this;
    return this.parentElement?.closest(selector) || null;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function spkiToPem(spki) {
  const body = Buffer.from(spki).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

test("any signed Crisp product permission can unlock Crisp Recall", () => {
  const { resolveRecallLicensePermission } = loadPlugin();

  assert.deepEqual(
    JSON.parse(JSON.stringify(resolveRecallLicensePermission({
      product: "Crisp Focus",
      features: ["crisp-focus"],
    }))),
    { allowed: true, onlinePluginId: "crisp-focus" }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolveRecallLicensePermission({
      product: "Crisp Annotations",
      features: [],
    }))),
    { allowed: true, onlinePluginId: "crisp-annotations" }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolveRecallLicensePermission({
      product: "Crisp Suite",
      features: ["all"],
    }))),
    { allowed: true, onlinePluginId: "crisp-recall" }
  );
});

test("non-Crisp licenses cannot unlock Crisp Recall", () => {
  const { resolveRecallLicensePermission } = loadPlugin();

  assert.deepEqual(
    JSON.parse(JSON.stringify(resolveRecallLicensePermission({
      product: "Other Product",
      features: ["all"],
    }))),
    { allowed: false, reason: "授权码不属于 Crisp 系列插件" }
  );
});

test("license verification checks a real signature and preserves the original product device scope", async () => {
  const { verifyCrispRecallLicense } = loadPlugin();
  const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKeyPem = spkiToPem(await webcrypto.subtle.exportKey("spki", keys.publicKey));
  const payload = {
    product: "Crisp Reading Rail",
    licenseId: "test-license",
    userName: "Test User",
    expiresAt: "2030-01-01T00:00:00.000Z",
    maxDevices: 3,
    features: ["crisp-reading-rail"],
  };
  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  const signature = await webcrypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(payloadBase64)
  );
  const licenseCode = `${payloadBase64}.${toBase64Url(signature)}`;
  let requestBody = null;

  const result = await verifyCrispRecallLicense(licenseCode, {
    publicKeyPem,
    now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    getDeviceId: () => "test-device",
    request: async (options) => {
      requestBody = JSON.parse(options.body);
      return { json: { valid: true, message: "ok" } };
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.product, "Crisp Reading Rail");
  assert.deepEqual(requestBody, {
    licenseCode,
    deviceId: "test-device",
    action: "activate",
    pluginId: "crisp-reading-rail",
  });
});

test("settings About card links safely to letschips on Xiaohongshu", () => {
  const { renderRecallAboutCard } = loadPlugin();
  const container = new FakeElement();

  renderRecallAboutCard(container);

  const card = container.querySelector(".crisp-recall-about");
  const author = card.querySelector(".crisp-recall-about__author-link");
  assert.equal(card.querySelector("h3").textContent, "关于 Crisp Recall");
  assert.equal(author.textContent, "小红书 letschips");
  assert.equal(author.href, "https://xhslink.cn/m/3MwtKu4822b");
  assert.equal(author.target, "_blank");
  assert.equal(author.rel, "noopener noreferrer");
});

test("unlicensed reading views are left unchanged", () => {
  const { PluginClass } = loadPlugin();
  let rewrites = 0;
  const paragraph = {
    textContent: "Question :: Answer",
    querySelector: () => null,
    classList: { contains: () => false },
    empty() { rewrites += 1; },
    addClass() {},
    createSpan() { return {}; },
  };
  const root = {
    querySelectorAll(selector) {
      if (selector === "mark") return [];
      if (selector === "p, li") return [paragraph];
      return [];
    },
    closest() { return null; },
  };
  const plugin = new PluginClass();
  plugin.settings = { enableCloze: true, enableDoubleColon: true, enableFloatingPill: false };
  plugin.licenseState = { valid: false, payload: null };

  plugin.processMarkdownView(root, {});

  assert.equal(rewrites, 0);
});

test("parser ignores Markdown metadata, headings, fenced code, and inline code", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText(`---
title: Wrong :: Card
---
# Syntax :: Reference
Use \`Question :: Answer\` and \`==cloze==\` as examples.
\`\`\`
Code :: Not a card
Code ==not a card==
\`\`\`
Real question :: Real answer
Remember ==this== today.`);

  assert.deepEqual(
    JSON.parse(JSON.stringify(cards.map(({ type, answer }) => [type, answer]))),
    [["concept", "Real answer"], ["cloze", "this"]]
  );
});

test("Anki cloze syntax is parsed as a cloze instead of a double-colon card", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText("The capital is {c1::Paris}.");

  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, "cloze");
  assert.equal(cards[0].answer, "Paris");
  assert.match(cards[0].prompt, /capital is\s+\[ ❓ …… \]\s+\./);
});

test("standard double-brace Anki clozes remove both braces and optional hints", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText("The capital is {{c1::Paris::city}}.");

  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, "cloze");
  assert.equal(cards[0].answer, "Paris");
  assert.equal(cards[0].prompt, "The capital is  [ ❓ …… ] .");
  assert.doesNotMatch(cards[0].prompt, /[{}]/);
});

test("Anki cloze answers may contain a single colon", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText("The meeting starts at {{c1::10:30::time}}.");

  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, "cloze");
  assert.equal(cards[0].answer, "10:30");
  assert.equal(cards[0].prompt, "The meeting starts at  [ ❓ …… ] .");
});

test("Crisp Annotations directives stay out of review cards", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText(
    'Explain ==active recall=={ann note="compare :: recognition" place=bottom-right color=red}.'
  );

  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, "cloze");
  assert.equal(cards[0].answer, "active recall");
  assert.equal(cards[0].prompt, "Explain  [ ❓ …… ] .");
  assert.doesNotMatch(cards[0].prompt, /\{ann\b/);
});

test("triple-colon cards generate both forward and reverse prompts", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText("Front ::: Back", "note.md");

  assert.equal(cards.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(cards.map(({ prompt, answer }) => [prompt, answer]))),
    [["Front", "Back"], ["Back", "Front"]]
  );
  assert.notEqual(cards[0].id, cards[1].id);
});

test("repeated clozes mask the occurrence represented by each card", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText("The ==same== and ==same==.");

  assert.equal(cards.length, 2);
  assert.match(cards[0].prompt, /\[ ❓ …… \].*==same==/);
  assert.match(cards[1].prompt, /==same==.*\[ ❓ …… \]/);
});

test("completed review sessions ignore further grading and flipping", () => {
  const { ReviewModal } = loadPlugin();
  const modal = new ReviewModal({}, [{}]);
  modal.contentEl = { querySelector: () => null };
  modal.renderSummary = () => {};
  modal.isFlipped = true;

  modal.rateCard("good");
  modal.isFlipped = true;
  modal.rateCard("good");
  modal.toggleFlip();

  assert.equal(modal.currentIndex, 1);
  assert.equal(modal.stats.good, 1);
  assert.equal(modal.isFlipped, false);
});

test("reading view leaves syntax examples containing inline code intact", () => {
  const { PluginClass } = loadPlugin();
  let rewrites = 0;
  const paragraph = {
    textContent: "Use `Question :: Answer` to create a card.",
    querySelector(selector) {
      if (selector === "code, pre") return {};
      return null;
    },
    empty() { rewrites += 1; },
    addClass() {},
    createSpan() { return {}; },
  };
  const root = {
    querySelectorAll(selector) {
      if (selector === "p, li") return [paragraph];
      return [];
    },
    closest() { return null; },
  };
  const plugin = new PluginClass();
  plugin.settings = { enableCloze: false, enableDoubleColon: true, enableFloatingPill: false };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  plugin.processMarkdownView(root, {});

  assert.equal(rewrites, 0);
});

test("reading view does not flatten Crisp Annotations markup", () => {
  const { PluginClass } = loadPlugin();
  let rewrites = 0;
  const annotation = new FakeElement("crisp-ann");
  const paragraph = new FakeElement();
  paragraph.textContent = "Question :: Annotated answer";
  paragraph.addChild(annotation);
  paragraph.empty = () => { rewrites += 1; };
  paragraph.addClass = () => {};
  paragraph.createSpan = () => ({});
  const root = {
    querySelectorAll(selector) {
      if (selector === "mark") return [];
      if (selector === "p, li") return [paragraph];
      return [];
    },
    closest() { return null; },
  };
  const plugin = new PluginClass();
  plugin.settings = { enableCloze: true, enableDoubleColon: true, enableFloatingPill: false };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  plugin.processMarkdownView(root, {});

  assert.equal(rewrites, 0);
  assert.equal(paragraph.querySelector(".crisp-ann"), annotation);
});

test("reading view preserves raw annotation directives regardless of processor order", () => {
  const { PluginClass } = loadPlugin();
  let rewrites = 0;
  const paragraph = new FakeElement();
  paragraph.textContent = 'Question :: ==Annotated answer=={ann note="detail" place=bottom}';
  paragraph.empty = () => { rewrites += 1; };
  paragraph.addClass = () => {};
  paragraph.createSpan = () => ({});
  const root = {
    querySelectorAll(selector) {
      if (selector === "mark") return [];
      if (selector === "p, li") return [paragraph];
      return [];
    },
    closest() { return null; },
  };
  const plugin = new PluginClass();
  plugin.settings = { enableCloze: true, enableDoubleColon: true, enableFloatingPill: false };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  plugin.processMarkdownView(root, {});

  assert.equal(rewrites, 0);
});

test("selection card commands require an activated Crisp license", () => {
  const { PluginClass, notices } = loadPlugin();
  let replacement = null;
  const editor = {
    getSelection: () => "selected text",
    replaceSelection(value) { replacement = value; },
    focus() {},
  };
  const plugin = new PluginClass();
  plugin.licenseState = { valid: false, payload: null };

  plugin.handleSelectionAction("cloze", editor);

  assert.equal(replacement, null);
  assert.equal(notices.length, 1);
});

test("multiline Cloze selection wraps each content line without breaking Markdown prefixes", () => {
  const { PluginClass } = loadPlugin();
  let replacement = null;
  const editor = {
    getSelection: () => "first line\n\n- second line\n> quoted line",
    replaceSelection(value) { replacement = value; },
    focus() {},
  };
  const plugin = new PluginClass();
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  plugin.handleSelectionAction("cloze", editor);

  assert.equal(
    replacement,
    "==first line==\n\n- ==second line==\n> ==quoted line=="
  );
});

test("multiline Cloze selection toggles independently wrapped lines back to plain text", () => {
  const { PluginClass } = loadPlugin();
  let replacement = null;
  const editor = {
    getSelection: () => "==first line==\r\n- ==second line==",
    replaceSelection(value) { replacement = value; },
    focus() {},
  };
  const plugin = new PluginClass();
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  plugin.handleSelectionAction("cloze", editor);

  assert.equal(replacement, "first line\r\n- second line");
});

test("plugin unload removes injected controls and restores transformed content", () => {
  let removedPills = 0;
  const pill = { remove: () => { removedPills += 1; } };
  const removedClasses = [];
  const cardLine = {
    dataset: { crispRecallOriginalHtml: "<strong>Question</strong> :: Answer" },
    innerHTML: "transformed",
    classList: { remove: (...names) => removedClasses.push(...names) },
  };
  const cloze = {
    classList: { remove: (...names) => removedClasses.push(...names) },
    removeAttribute() {},
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === ".crisp-recall-floating-pill") return [pill];
      if (selector === ".crisp-recall-card-line") return [cardLine];
      if (selector === ".crisp-recall-cloze") return [cloze];
      return [];
    },
  };
  const { PluginClass } = loadPlugin({ document });
  const plugin = new PluginClass();

  plugin.onunload();

  assert.equal(removedPills, 1);
  assert.equal(cardLine.innerHTML, "<strong>Question</strong> :: Answer");
  assert.ok(removedClasses.includes("crisp-recall-card-line"));
  assert.ok(removedClasses.includes("crisp-recall-cloze"));
});

test("plugin unload closes review modals it opened", () => {
  const { PluginClass } = loadPlugin();
  let closes = 0;
  const plugin = new PluginClass();
  plugin.reviewModals = new Set([{ close: () => { closes += 1; } }]);

  plugin.onunload();

  assert.equal(closes, 1);
  assert.equal(plugin.reviewModals.size, 0);
});

test("toggle all masks only affects the active Markdown pane", () => {
  const activeMask = { classList: makeClassList() };
  const otherMask = { classList: makeClassList() };
  const document = { querySelectorAll: () => [activeMask, otherMask] };
  const { PluginClass } = loadPlugin({ document });
  const plugin = new PluginClass({
    workspace: {
      activeLeaf: {
        view: { containerEl: { querySelectorAll: () => [activeMask] } },
      },
    },
  });
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  plugin.toggleAllMasks();

  assert.equal(activeMask.classList.contains("is-revealed"), true);
  assert.equal(otherMask.classList.contains("is-revealed"), false);
});

test("concurrent post-processors inject only one floating controller", async () => {
  const { PluginClass } = loadPlugin();
  const file = { path: "note.md", basename: "note" };
  const plugin = new PluginClass({
    vault: {
      getFileByPath: () => file,
      async cachedRead() {
        await Promise.resolve();
        return "Question :: Answer";
      },
    },
  });
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };
  const container = new FakeElement();

  await Promise.all([
    plugin.injectFloatingWidget(container, file.path),
    plugin.injectFloatingWidget(container, file.path),
  ]);

  const pills = container.children.filter((child) =>
    child.className.split(/\s+/).includes("crisp-recall-floating-pill")
  );
  assert.equal(pills.length, 1);
});

test("floating controller is hosted outside the scrolling preview", async () => {
  const { PluginClass } = loadPlugin();
  const file = { path: "note.md", basename: "note" };
  const plugin = new PluginClass({
    vault: {
      getFileByPath: () => file,
      async cachedRead() {
        return "Remember ==answer==";
      },
    },
  });
  plugin.settings = {
    enableCloze: true,
    enableDoubleColon: false,
    enableFloatingPill: true,
  };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  const leafHost = new FakeElement("workspace-leaf-content");
  const preview = leafHost.addChild(new FakeElement("markdown-preview-view"));
  const section = preview.addChild(new FakeElement("markdown-preview-section"));

  plugin.processMarkdownView(section, { sourcePath: file.path });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(preview.querySelector(".crisp-recall-floating-pill"), null);
  assert.ok(leafHost.querySelector(".crisp-recall-floating-pill"));
});

test("floating controller refreshes when the leaf opens another note", async () => {
  const { PluginClass } = loadPlugin();
  const files = {
    "first.md": { path: "first.md", basename: "first" },
    "second.md": { path: "second.md", basename: "second" },
  };
  const plugin = new PluginClass({
    vault: {
      getFileByPath: (sourcePath) => files[sourcePath],
      async cachedRead(file) {
        return file.path === "first.md"
          ? "First :: Answer"
          : "Second :: Answer\nAnother :: Card";
      },
    },
  });
  plugin.settings = {
    enableCloze: true,
    enableDoubleColon: true,
    enableFloatingPill: true,
  };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };
  const leafHost = new FakeElement("workspace-leaf-content");
  const preview = leafHost.addChild(new FakeElement("markdown-preview-view"));
  const section = preview.addChild(new FakeElement("markdown-preview-section"));

  plugin.processMarkdownView(section, { sourcePath: "first.md" });
  await new Promise((resolve) => setImmediate(resolve));
  plugin.processMarkdownView(section, { sourcePath: "second.md" });
  await new Promise((resolve) => setImmediate(resolve));

  const pills = leafHost.querySelectorAll(".crisp-recall-floating-pill");
  assert.equal(pills.length, 1);
  assert.equal(pills[0].dataset.crispRecallSource, "second.md");
  assert.equal(pills[0].querySelector(".crisp-recall-pill-count").textContent, "2");
});

test("reactive floating controller ignores a stale note read", async () => {
  const { PluginClass } = loadPlugin();
  const firstFile = { path: "first.md", basename: "first" };
  const secondFile = { path: "second.md", basename: "second" };
  let resolveFirstRead;
  const firstRead = new Promise((resolve) => { resolveFirstRead = resolve; });
  const container = new FakeElement("workspace-leaf-content");
  const view = {
    file: firstFile,
    containerEl: container,
    getMode: () => "preview",
  };
  const plugin = new PluginClass({
    workspace: { getLeavesOfType: () => [{ view }] },
    vault: {
      async cachedRead(file) {
        if (file.path === firstFile.path) return firstRead;
        return "Second :: Answer\nAnother :: Card";
      },
      getFileByPath(sourcePath) {
        return sourcePath === firstFile.path ? firstFile : secondFile;
      },
    },
  });
  plugin.settings = {
    enableCloze: true,
    enableDoubleColon: true,
    enableFloatingPill: true,
  };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  const staleUpdate = plugin.updateActiveLeafFloatingWidget();
  view.file = secondFile;
  await plugin.updateActiveLeafFloatingWidget();
  resolveFirstRead("First :: Answer");
  await staleUpdate;

  const pills = container.querySelectorAll(".crisp-recall-floating-pill");
  assert.equal(pills.length, 1);
  assert.equal(pills[0].dataset.crispRecallSource, secondFile.path);
  assert.equal(pills[0].querySelector(".crisp-recall-pill-count").textContent, "2");
});

test("floating controller retries after a temporarily unavailable file", async () => {
  const { PluginClass } = loadPlugin();
  const file = { path: "note.md", basename: "note" };
  let fileAvailable = false;
  const plugin = new PluginClass({
    vault: {
      getFileByPath: () => (fileAvailable ? file : null),
      async cachedRead() {
        return "Question :: Answer";
      },
    },
  });
  plugin.settings = {
    enableCloze: true,
    enableDoubleColon: true,
    enableFloatingPill: true,
  };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };
  const container = new FakeElement("workspace-leaf-content");

  await plugin.injectFloatingWidget(container, file.path);
  fileAvailable = true;
  await plugin.injectFloatingWidget(container, file.path);

  assert.equal(container.querySelectorAll(".crisp-recall-floating-pill").length, 1);
});

test("pending note reads cannot recreate floating controls after plugin unload", async () => {
  const { PluginClass } = loadPlugin();
  const file = { path: "note.md", basename: "note" };
  let resolveRead;
  const pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  const plugin = new PluginClass({
    vault: {
      getFileByPath: () => file,
      cachedRead: () => pendingRead,
    },
  });
  plugin.settings = {
    enableCloze: true,
    enableDoubleColon: true,
    enableFloatingPill: true,
  };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };
  const container = new FakeElement("workspace-leaf-content");

  const injection = plugin.injectFloatingWidget(container, file.path);
  plugin.onunload();
  resolveRead("Question :: Answer");
  await injection;

  assert.equal(container.querySelectorAll(".crisp-recall-floating-pill").length, 0);
});

test("vault review scans every Markdown file, including files after the first 50", async () => {
  const { PluginClass } = loadPlugin();
  const files = Array.from({ length: 51 }, (_, index) => ({
    path: `${index}.md`,
    basename: String(index),
  }));
  let reads = 0;
  const plugin = new PluginClass({
    vault: {
      getMarkdownFiles: () => files,
      async cachedRead(file) {
        reads += 1;
        return file.path === "50.md" ? "Last card :: Found" : "";
      },
    },
  });
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  await plugin.startVaultRandomReview();

  assert.equal(reads, 51);
});

test("release metadata keeps package, manifest, and minimum Obsidian version aligned", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));

  assert.equal(packageJson.version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});

test("floating controller CSS avoids Reading Rail and the mobile navigation bar", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

  assert.match(css, /:has\(> \.crisp-reading-rail:not\(\[hidden\]\)\)[^{]*> \.crisp-recall-floating-pill/);
  assert.match(css, /body\.is-mobile \.crisp-recall-floating-pill\s*\{[^}]*safe-area-inset-bottom/s);
  assert.match(css, /body\.is-mobile \.crisp-recall-floating-pill\s*\{[^}]*bottom:\s*calc\(96px/s);
  assert.match(css, /\.crisp-recall-selection-bubble \.crisp-recall-bubble-btn\s*\{[^}]*box-shadow:\s*none/s);
});
