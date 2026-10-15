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
    " renderRecallAboutCard: typeof renderRecallAboutCard === 'function' ? renderRecallAboutCard : undefined," +
    " scheduleRecallReview: typeof scheduleRecallReview === 'function' ? scheduleRecallReview : undefined," +
    " previewRecallIntervals: typeof previewRecallIntervals === 'function' ? previewRecallIntervals : undefined," +
    " recallAddDays: typeof recallAddDays === 'function' ? recallAddDays : undefined," +
    " RecallReviewStore: typeof RecallReviewStore === 'function' ? RecallReviewStore : undefined," +
    " buildDueReviewQueue: typeof buildDueReviewQueue === 'function' ? buildDueReviewQueue : undefined" +
    " };";
  vm.runInNewContext(source, sandbox, { filename: mainPath });

  return {
    PluginClass: module.exports,
    parseFlashcardsFromText: sandbox.__crispRecallTest.parseFlashcardsFromText,
    ReviewModal: sandbox.__crispRecallTest.CrispRecallReviewModal,
    resolveRecallLicensePermission: sandbox.__crispRecallTest.resolveRecallLicensePermission,
    verifyCrispRecallLicense: sandbox.__crispRecallTest.verifyCrispRecallLicense,
    renderRecallAboutCard: sandbox.__crispRecallTest.renderRecallAboutCard,
    scheduleRecallReview: sandbox.__crispRecallTest.scheduleRecallReview,
    previewRecallIntervals: sandbox.__crispRecallTest.previewRecallIntervals,
    recallAddDays: sandbox.__crispRecallTest.recallAddDays,
    RecallReviewStore: sandbox.__crispRecallTest.RecallReviewStore,
    buildDueReviewQueue: sandbox.__crispRecallTest.buildDueReviewQueue,
    notices,
  };
}

function makeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle: (name) => (values.has(name) ? !values.delete(name) : !!values.add(name)),
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

test("card prompts drop blockquote, task checkbox, and ordered list markers", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText([
    "> Quoted question :: Quoted answer",
    "> > Nested quote :: Nested answer",
    "- [ ] Task question :: Task answer",
    "> - [x] Quoted ==done== task",
    "1) Paren question :: Paren answer",
  ].join("\n"));

  assert.deepEqual(
    JSON.parse(JSON.stringify(cards.map(({ prompt }) => prompt))),
    ["Quoted question", "Nested quote", "Task question", "Quoted  [ ❓ …… ]  task", "Paren question"],
  );
});

test("parser ignores comments, math blocks, and fences closed by an info string", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText([
    "%% Hidden :: Not a card %%",
    "%%",
    "Block comment :: Not a card",
    "%%",
    "<!-- Html :: Not a card -->",
    "<!--",
    "Html block ==not a card==",
    "-->",
    "$$",
    "a::b",
    "$$",
    "```js",
    "code",
    "```js",
    "Still code :: Not a card",
    "```",
    "Visible %%note%% question :: Real answer",
  ].join("\n"));

  assert.deepEqual(
    JSON.parse(JSON.stringify(cards.map(({ prompt, answer }) => [prompt, answer]))),
    [["Visible  question", "Real answer"]],
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

test("toggle all masks also reaches sections Obsidian has not mounted yet", () => {
  const mountedMask = { classList: makeClassList() };
  const unmountedMask = { classList: makeClassList() };
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass({
    workspace: {
      activeLeaf: {
        view: {
          containerEl: { querySelectorAll: () => [mountedMask] },
          previewMode: {
            renderer: {
              sections: [
                { el: { querySelectorAll: () => [mountedMask] } },
                { el: { querySelectorAll: () => [unmountedMask] } },
              ],
            },
          },
        },
      },
    },
  });
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  plugin.toggleAllMasks();
  assert.equal(mountedMask.classList.contains("is-revealed"), true);
  assert.equal(unmountedMask.classList.contains("is-revealed"), true);

  plugin.toggleAllMasks();
  assert.equal(unmountedMask.classList.contains("is-revealed"), false);
});

function makeClickNode(parent, { classes = [], tagName = "span" } = {}) {
  const classList = makeClassList();
  classes.forEach((name) => classList.add(name));
  const node = {
    parentElement: parent,
    tagName,
    classList,
    closest(selector) {
      for (let current = node; current; current = current.parentElement) {
        if (selector === "a" && current.tagName === "a") return current;
        if (selector.startsWith(".") && current.classList.contains(selector.slice(1))) return current;
      }
      return null;
    },
  };
  return node;
}

function makeClickEvent(target) {
  return {
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

test("reading view masks share one click listener instead of one per highlight", () => {
  const { PluginClass } = loadPlugin();
  const marks = [1, 2, 3].map(() => ({ classList: makeClassList(), closest: () => null }));
  const root = {
    querySelectorAll: (selector) => (selector === "mark" ? marks : []),
    closest: () => null,
  };
  const plugin = new PluginClass();
  let registeredListeners = 0;
  plugin.registerDomEvent = () => { registeredListeners += 1; };
  plugin.settings = { enableCloze: true, enableDoubleColon: false, enableFloatingPill: false };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  plugin.processMarkdownView(root, {});
  plugin.processMarkdownView(root, {});

  assert.equal(registeredListeners, 0);
  assert.ok(marks.every((mark) => mark.classList.contains("crisp-recall-cloze")));
});

test("clicking a mask toggles it, and links work once the answer is revealed", () => {
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass();
  const answer = makeClickNode(null, { classes: ["crisp-recall-cloze"] });
  const link = makeClickNode(answer, { tagName: "a" });

  const maskedClick = makeClickEvent(link);
  plugin.handleClozeClick(maskedClick);
  assert.equal(answer.classList.contains("is-revealed"), true);
  assert.equal(maskedClick.defaultPrevented, true);

  const revealedLinkClick = makeClickEvent(link);
  plugin.handleClozeClick(revealedLinkClick);
  assert.equal(answer.classList.contains("is-revealed"), true);
  assert.equal(revealedLinkClick.defaultPrevented, false);

  plugin.handleClozeClick(makeClickEvent(answer));
  assert.equal(answer.classList.contains("is-revealed"), false);

  const outside = makeClickEvent(makeClickNode(null));
  plugin.handleClozeClick(outside);
  assert.equal(outside.defaultPrevented, false);
});

test("changing card settings refreshes the floating controller count", async () => {
  const { PluginClass } = loadPlugin();
  const file = { path: "note.md", basename: "note" };
  const container = new FakeElement("workspace-leaf-content");
  const view = { file, containerEl: container, getMode: () => "preview" };
  const plugin = new PluginClass({
    workspace: { getLeavesOfType: () => [{ view }], iterateAllLeaves() {} },
    vault: {
      getFileByPath: () => file,
      async cachedRead() {
        return "Question :: Answer\nRemember ==this==";
      },
    },
  });
  plugin.settings = { enableCloze: true, enableDoubleColon: true, enableFloatingPill: true };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };

  await plugin.updateActiveLeafFloatingWidget();
  assert.equal(container.querySelector(".crisp-recall-pill-count").textContent, "2");

  plugin.settings.enableCloze = false;
  await plugin.refreshReadingViews();
  assert.equal(container.querySelector(".crisp-recall-pill-count").textContent, "1");
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

test("custom cloze color applies to documentElement and cleans up on unload", async () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
  assert.match(css, /--crisp-recall-cloze-color:\s*var\(--interactive-accent\)/);

  const styleMap = new Map();
  const fakeDoc = {
    querySelectorAll: () => [],
    documentElement: {
      style: {
        setProperty: (prop, val) => styleMap.set(prop, val),
        removeProperty: (prop) => styleMap.delete(prop),
      },
    },
  };

  const { PluginClass } = loadPlugin({ document: fakeDoc });
  const plugin = new PluginClass({
    workspace: {
      iterateAllLeaves: () => {},
      on: () => {},
      onLayoutReady: (cb) => cb(),
    },
  });

  plugin.settings = { clozeColor: "#f59e0b" };
  plugin.applyCustomColor();
  assert.equal(styleMap.get("--crisp-recall-cloze-color"), "#f59e0b");

  plugin.settings.clozeColor = "";
  plugin.applyCustomColor();
  assert.equal(styleMap.has("--crisp-recall-cloze-color"), false);

  plugin.settings.clozeColor = "#10b981";
  plugin.applyCustomColor();
  assert.equal(styleMap.get("--crisp-recall-cloze-color"), "#10b981");

  plugin.onunload();
  assert.equal(styleMap.has("--crisp-recall-cloze-color"), false);
});

// --------------------------------------------------------------------------
// Spaced repetition
// --------------------------------------------------------------------------

const REVIEW_STATE_PATH = ".obsidian/plugins/crisp-recall/review-state.json";

function makeMemoryAdapter(initial = {}) {
  const files = new Map(Object.entries(initial));
  const adapter = {
    files,
    writes: [],
    failWrites: false,
    dropWrites: false,
    failReadPaths: new Set(),
    async exists(filePath) {
      return files.has(filePath);
    },
    async read(filePath) {
      if (adapter.failReadPaths.has(filePath)) throw new Error("read failed");
      if (!files.has(filePath)) throw new Error(`ENOENT ${filePath}`);
      return files.get(filePath);
    },
    async write(filePath, data) {
      adapter.writes.push(filePath);
      if (adapter.failWrites) throw new Error("disk full");
      if (adapter.dropWrites) return;
      files.set(filePath, data);
    },
  };
  return adapter;
}

function reviewStateText(files, version = 1) {
  return JSON.stringify({ version, algorithm: "fsrs-5", files });
}

function reviewRecord(overrides = {}) {
  return {
    s: 3.173, d: 5.28243442, due: "2026-10-15", last: "2026-10-12", at: 100, reps: 1, lapses: 0, first: "2026-10-12",
    ...overrides,
  };
}

async function loadedStore(RecallReviewStore, initialFiles) {
  const adapter = makeMemoryAdapter(
    initialFiles === undefined ? {} : { [REVIEW_STATE_PATH]: reviewStateText(initialFiles) },
  );
  const store = new RecallReviewStore(adapter, REVIEW_STATE_PATH);
  const result = await store.load();
  return { adapter, store, result };
}

function savedFiles(adapter) {
  return JSON.parse(adapter.files.get(REVIEW_STATE_PATH)).files;
}

test("card keys survive lines being inserted above and are independent of line numbers", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const before = parseFlashcardsFromText("Q :: A\nF ::: B\nRemember ==x== here", "n.md");
  const after = parseFlashcardsFromText("intro\n\n- [ ] Q :: A\n\nF ::: B\n\nRemember ==x== here", "n.md");

  assert.equal(before.length, 4);
  assert.ok(before.every((card) => typeof card.key === "string" && card.key.length >= 6));
  assert.deepEqual(after.map((card) => card.key), before.map((card) => card.key));
  assert.equal(
    parseFlashcardsFromText("Q  with   space :: A")[0].key,
    parseFlashcardsFromText("Q with space :: A")[0].key,
  );
});

test("card keys change with content and stay unique inside one note", () => {
  const { parseFlashcardsFromText } = loadPlugin();
  const cards = parseFlashcardsFromText("Q :: A\nQ :: A\nF ::: B\nThe ==a== and ==b==.\nB :: F", "n.md");
  const keys = cards.map((card) => card.key);

  assert.equal(new Set(keys).size, keys.length);
  assert.equal(cards[1].key, `${cards[0].key}#2`);
  // The reverse side of "F ::: B" asks the same question as "B :: F" but is a different card.
  assert.notEqual(cards[3].key, cards[6].key);
  assert.notEqual(parseFlashcardsFromText("Q :: A changed")[0].key, cards[0].key);
});

test("FSRS scheduling matches the ts-fsrs FSRS-5 reference for day-based reviews", () => {
  const { scheduleRecallReview, previewRecallIntervals, recallAddDays } = loadPlugin();
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "fsrs5-reference.json"), "utf8"));
  const start = "2026-01-01";

  for (const [name, steps] of Object.entries(fixture.sequences)) {
    let record = null;
    for (const [index, step] of steps.entries()) {
      const label = `${name}[${index}]`;
      const today = recallAddDays(start, step.day);
      const preview = previewRecallIntervals(record, today);
      assert.deepEqual([preview.again, preview.hard, preview.good], step.preview, `${label} preview`);

      record = scheduleRecallReview(record, step.rating, today, 1000 + index);
      assert.ok(Math.abs(record.s - step.s) < 1e-6, `${label} stability ${record.s} vs ${step.s}`);
      assert.ok(Math.abs(record.d - step.d) < 1e-6, `${label} difficulty ${record.d} vs ${step.d}`);
      assert.equal(record.due, recallAddDays(today, step.ivl), `${label} due`);
      assert.equal(record.reps, step.reps, `${label} reps`);
      assert.equal(record.lapses, step.lapses, `${label} lapses`);
      assert.equal(record.last, today);
      assert.equal(record.first, start);
      assert.equal(record.at, 1000 + index);
    }
  }
});

test("calendar day arithmetic crosses month, year, and DST boundaries", () => {
  const { recallAddDays } = loadPlugin();

  assert.equal(recallAddDays("2026-03-28", 3), "2026-03-31");
  assert.equal(recallAddDays("2026-10-24", 2), "2026-10-26");
  assert.equal(recallAddDays("2026-12-31", 1), "2027-01-01");
  assert.equal(recallAddDays("2028-02-28", 1), "2028-02-29");
});

test("a missing review file starts empty and the first rating is written and verified", async () => {
  const { RecallReviewStore } = loadPlugin();
  const { adapter, store, result } = await loadedStore(RecallReviewStore);

  assert.equal(result.state, "missing");
  assert.equal(store.get("a.md", "k1"), null);

  store.rate("a.md", "k1", "good", "2026-10-15", 500);
  const saved = await store.save();

  assert.equal(saved.ok, true);
  const state = JSON.parse(adapter.files.get(REVIEW_STATE_PATH));
  assert.equal(state.version, 1);
  assert.equal(state.files["a.md"].k1.due, "2026-10-18");
  assert.equal(adapter.files.has(`${REVIEW_STATE_PATH}.bak`), false);
});

test("an unparseable review file is backed up before an empty state is used", async () => {
  const { RecallReviewStore } = loadPlugin();
  const adapter = makeMemoryAdapter({ [REVIEW_STATE_PATH]: "{\"version\":1,\"files\":{" });
  const store = new RecallReviewStore(adapter, REVIEW_STATE_PATH);

  const result = await store.load();

  assert.equal(result.state, "preserved");
  assert.equal(adapter.files.get(result.backupPath), "{\"version\":1,\"files\":{");
  assert.match(result.backupPath, /review-state\.json\.unreadable-\d{8}-\d{6}$/);
  store.rate("a.md", "k1", "good", "2026-10-15", 500);
  assert.equal((await store.save()).ok, true);
  assert.equal(adapter.files.get(result.backupPath), "{\"version\":1,\"files\":{");
});

test("an unreadable review file that cannot be backed up is never overwritten", async () => {
  const { RecallReviewStore } = loadPlugin();
  const adapter = makeMemoryAdapter({ [REVIEW_STATE_PATH]: "original" });
  adapter.failReadPaths.add(REVIEW_STATE_PATH);
  const store = new RecallReviewStore(adapter, REVIEW_STATE_PATH);

  const result = await store.load();
  store.rate("a.md", "k1", "good", "2026-10-15", 500);
  const saved = await store.save();

  assert.equal(result.state, "failed");
  assert.equal(store.writeBlocked, true);
  assert.equal(saved.ok, false);
  assert.equal(adapter.files.get(REVIEW_STATE_PATH), "original");
  assert.deepEqual(adapter.writes, []);
});

test("a review file written by a newer plugin version is read but not overwritten", async () => {
  const { RecallReviewStore } = loadPlugin();
  const text = reviewStateText({ "a.md": { k1: reviewRecord() } }, 2);
  const adapter = makeMemoryAdapter({ [REVIEW_STATE_PATH]: text });
  const store = new RecallReviewStore(adapter, REVIEW_STATE_PATH);

  const result = await store.load();
  store.rate("a.md", "k2", "good", "2026-10-15", 500);
  const saved = await store.save();

  assert.equal(result.state, "newer");
  assert.equal(store.get("a.md", "k1").due, "2026-10-15");
  assert.equal(saved.ok, false);
  assert.equal(adapter.files.get(REVIEW_STATE_PATH), text);
});

test("a write that does not read back is reported and retried by the next save", async () => {
  const { RecallReviewStore } = loadPlugin();
  const { adapter, store } = await loadedStore(RecallReviewStore, { "a.md": { k1: reviewRecord() } });

  adapter.dropWrites = true;
  store.rate("a.md", "k2", "good", "2026-10-15", 500);
  const dropped = await store.save();
  assert.equal(dropped.ok, false);
  assert.equal(store.get("a.md", "k2").reps, 1);

  adapter.dropWrites = false;
  adapter.failWrites = true;
  const thrown = await store.save();
  assert.equal(thrown.ok, false);

  adapter.failWrites = false;
  const retried = await store.save();
  assert.equal(retried.ok, true);
  assert.equal(savedFiles(adapter)["a.md"].k2.reps, 1);
});

test("the first write of a session keeps the previous review file as .bak", async () => {
  const { RecallReviewStore } = loadPlugin();
  const { adapter, store } = await loadedStore(RecallReviewStore, { "a.md": { k1: reviewRecord() } });
  const original = adapter.files.get(REVIEW_STATE_PATH);

  store.rate("a.md", "k2", "good", "2026-10-15", 500);
  await store.save();
  store.rate("a.md", "k3", "good", "2026-10-15", 600);
  await store.save();

  assert.equal(adapter.files.get(`${REVIEW_STATE_PATH}.bak`), original);
});

test("saving merges reviews another device synced in, keeping the newer record per card", async () => {
  const { RecallReviewStore } = loadPlugin();
  const { adapter, store } = await loadedStore(RecallReviewStore, {
    "a.md": { k1: reviewRecord({ at: 100 }), k2: reviewRecord({ at: 100 }) },
  });

  adapter.files.set(REVIEW_STATE_PATH, reviewStateText({
    "a.md": {
      k1: reviewRecord({ at: 200, reps: 7 }),
      k2: reviewRecord({ at: 50, reps: 9 }),
      k4: reviewRecord({ at: 200 }),
    },
    "b.md": { k5: reviewRecord({ at: 200 }) },
  }));
  store.rate("a.md", "k2", "good", "2026-10-15", 300);
  store.rate("a.md", "k3", "good", "2026-10-15", 300);
  assert.equal((await store.save()).ok, true);

  const files = savedFiles(adapter);
  assert.equal(files["a.md"].k1.reps, 7);
  assert.equal(files["a.md"].k2.at, 300);
  assert.ok(files["a.md"].k3);
  assert.ok(files["a.md"].k4);
  assert.ok(files["b.md"].k5);
});

test("overlapping saves are serialized and keep every rating", async () => {
  const { RecallReviewStore } = loadPlugin();
  const { adapter, store } = await loadedStore(RecallReviewStore);

  store.rate("a.md", "k1", "good", "2026-10-15", 500);
  const first = store.save();
  store.rate("a.md", "k2", "hard", "2026-10-15", 600);
  const second = store.save();
  const results = await Promise.all([first, second]);

  assert.ok(results.every((result) => result.ok));
  const files = savedFiles(adapter);
  assert.ok(files["a.md"].k1);
  assert.ok(files["a.md"].k2);
});

test("renaming a note or folder moves its review records", async () => {
  const { RecallReviewStore } = loadPlugin();
  const { store } = await loadedStore(RecallReviewStore, {
    "old/a.md": { k1: reviewRecord({ at: 100 }) },
    "old/sub/b.md": { k2: reviewRecord() },
    "older/c.md": { k3: reviewRecord() },
    "x.md": { k1: reviewRecord({ at: 50, reps: 4 }), k9: reviewRecord() },
  });

  assert.equal(store.renamePath("old", "new"), true);
  assert.equal(store.get("old/a.md", "k1"), null);
  assert.equal(store.get("new/a.md", "k1").at, 100);
  assert.ok(store.get("new/sub/b.md", "k2"));
  assert.ok(store.get("older/c.md", "k3"));

  // Moving onto a path that already has records keeps the newer record per card.
  assert.equal(store.renamePath("new/a.md", "x.md"), true);
  assert.equal(store.get("x.md", "k1").at, 100);
  assert.ok(store.get("x.md", "k9"));
  assert.equal(store.renamePath("missing.md", "y.md"), false);
});

test("today's queue puts overdue cards first and caps new cards by today's remaining quota", async () => {
  const { RecallReviewStore, buildDueReviewQueue } = loadPlugin();
  const { store } = await loadedStore(RecallReviewStore, {
    "a.md": {
      today: reviewRecord({ due: "2026-10-15" }),
      overdue: reviewRecord({ due: "2026-10-10" }),
      later: reviewRecord({ due: "2026-10-18", first: "2026-10-15" }),
    },
    "gone.md": { orphan: reviewRecord({ due: "2026-10-01" }) },
  });
  const card = (key, filePath = "a.md") => ({ key, filePath, prompt: key, answer: key });
  const cards = [card("today"), card("later"), card("overdue"), card("n1"), card("n2"), card("n3", "b.md")];

  const queue = buildDueReviewQueue(cards, store, "2026-10-15", { newLimit: 2, random: () => 0 });

  assert.deepEqual(Array.from(queue.slice(0, 2), (c) => c.key), ["overdue", "today"]);
  // "later" was introduced today, so only one of the two daily new-card slots is left.
  assert.equal(queue.length, 3);
  assert.ok(["n1", "n2", "n3"].includes(queue[2].key));
  assert.equal(buildDueReviewQueue(cards, store, "2026-10-15", { newLimit: 0 }).length, 2);
});

test("the review modal reports each rating and shows the next interval on each button", () => {
  const { ReviewModal } = loadPlugin();
  const rated = [];
  const card = { key: "k1", filePath: "a.md", prompt: "Q", answer: "A", typeName: "问答 / 概念卡" };
  const modal = new ReviewModal({}, [card], "title", {
    onRate: (ratedCard, rating) => rated.push([ratedCard.key, rating]),
    getIntervals: () => ({ again: 1, hard: 2, good: 45 }),
  });
  modal.contentEl = new FakeElement();
  modal.isFlipped = true;
  modal.renderCard();

  const labels = modal.contentEl.querySelectorAll(".crisp-recall-grade-btn__interval").map((el) => el.textContent);
  assert.deepEqual(labels, ["明天", "2 天", "1.5 个月"]);

  modal.renderSummary = () => {};
  modal.rateCard("hard");
  assert.deepEqual(rated, [["k1", "hard"]]);
});

test("plugin ratings persist to the review store", async () => {
  const { PluginClass, RecallReviewStore } = loadPlugin();
  const { adapter, store } = await loadedStore(RecallReviewStore);
  const plugin = new PluginClass({});
  plugin.reviewStore = store;

  await plugin.recordReviewRating({ key: "k1", filePath: "a.md" }, "good");

  assert.ok(savedFiles(adapter)["a.md"].k1);
});

test("vault rename events move review records and save them", async () => {
  const { PluginClass, RecallReviewStore } = loadPlugin();
  const { adapter, store } = await loadedStore(RecallReviewStore, { "old.md": { k1: reviewRecord() } });
  const plugin = new PluginClass({});
  plugin.reviewStore = store;

  await plugin.handleVaultRename({ path: "new.md" }, "old.md");

  const files = savedFiles(adapter);
  assert.equal(files["old.md"], undefined);
  assert.ok(files["new.md"].k1);
});

function makeReviewPlugin(PluginClass, fileContents, store) {
  const files = Object.keys(fileContents).map((filePath) => ({ path: filePath, basename: filePath.replace(/\.md$/, "") }));
  const plugin = new PluginClass({
    vault: {
      getMarkdownFiles: () => files,
      getFileByPath: (filePath) => files.find((file) => file.path === filePath) || null,
      async cachedRead(file) {
        return fileContents[file.path];
      },
    },
  });
  plugin.settings = { enableCloze: true, enableDoubleColon: true, enableFloatingPill: true, newCardsPerDay: 0 };
  plugin.licenseState = { valid: true, payload: { product: "Crisp Suite" } };
  plugin.reviewStore = store;
  const opened = [];
  plugin.openReviewModal = (cards, title) => opened.push({ cards, title });
  return { plugin, opened };
}

test("the due review command opens only cards that are due today", async () => {
  const { PluginClass, RecallReviewStore, parseFlashcardsFromText } = loadPlugin();
  const dueKey = parseFlashcardsFromText("Due :: Yes")[0].key;
  const laterKey = parseFlashcardsFromText("Later :: Yes")[0].key;
  const { store } = await loadedStore(RecallReviewStore, {
    "a.md": { [dueKey]: reviewRecord({ due: "2000-01-01" }), [laterKey]: reviewRecord({ due: "2999-01-01" }) },
  });
  const { plugin, opened } = makeReviewPlugin(PluginClass, {
    "a.md": "Due :: Yes\nLater :: Yes\nNew :: Card",
  }, store);

  await plugin.startDueReview();

  assert.equal(opened.length, 1);
  assert.deepEqual(Array.from(opened[0].cards, (card) => card.prompt), ["Due"]);
});

test("the due review command explains when nothing is due", async () => {
  const { PluginClass, RecallReviewStore, notices } = loadPlugin();
  const { store } = await loadedStore(RecallReviewStore);
  const { plugin, opened } = makeReviewPlugin(PluginClass, { "a.md": "New :: Card" }, store);

  await plugin.startDueReview();

  assert.equal(opened.length, 0);
  assert.ok(notices.some((message) => message.includes("今天没有到期")));
});

test("the floating controller shows due cards for the note and reviews only them", async () => {
  const { PluginClass, RecallReviewStore, parseFlashcardsFromText } = loadPlugin();
  const dueKey = parseFlashcardsFromText("Due :: Yes")[0].key;
  const { store } = await loadedStore(RecallReviewStore, { "a.md": { [dueKey]: reviewRecord({ due: "2000-01-01" }) } });
  const { plugin, opened } = makeReviewPlugin(PluginClass, {
    "a.md": "Due :: Yes\nNew :: Card",
    "b.md": "New :: Card",
  }, store);
  const container = new FakeElement("workspace-leaf-content");

  await plugin.injectFloatingWidget(container, "a.md");
  const due = container.querySelector(".crisp-recall-pill-due");
  assert.equal(due.textContent, "到期 1");
  due.onclick({ stopPropagation() {} });
  assert.deepEqual(Array.from(opened[0].cards, (card) => card.prompt), ["Due"]);

  const other = new FakeElement("workspace-leaf-content");
  await plugin.injectFloatingWidget(other, "b.md");
  assert.ok(other.querySelector(".crisp-recall-floating-pill"));
  assert.equal(other.querySelector(".crisp-recall-pill-due"), null);
});
