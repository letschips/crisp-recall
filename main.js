/* ==========================================================================
   Crisp Recall — Zero-Friction Active Recall & Zen Flashcard Engine (v0.2.4)
   Crafted by letschips (Xiaohongshu)
   ========================================================================== */

const {
  Plugin, Modal, Setting, PluginSettingTab, Notice, requestUrl, renderMath, finishRenderMath,
} = require("obsidian");

// Obsidian's Plugin.loadData() returns null for a missing data.json but undefined when the file exists
// and cannot be read or parsed (sync conflict, interrupted write), and Plugin.saveData() swallows write
// errors. These helpers keep such a file from being overwritten by defaults and make lost writes visible.

function dataSafetyStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Copies an unreadable data.json aside. On "failed" the caller must not write data.json this session. */
async function preserveUnreadableData(adapter, dataPath, now = new Date()) {
  try {
    if (!adapter) throw new Error("vault adapter unavailable");
    if (!(await adapter.exists(dataPath))) return { state: "missing" };
    const backupPath = `${dataPath}.unreadable-${dataSafetyStamp(now)}`;
    await adapter.write(backupPath, await adapter.read(dataPath));
    return { state: "preserved", backupPath };
  } catch (error) {
    return { state: "failed", error };
  }
}

const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
  enableCloze: true,
  enableDoubleColon: true,
  enableCallouts: true,
  enableFloatingPill: true,
  enableSelectionBubble: true,
  clozeDelimiter: "==",
  autoMaskInReadingView: true,
  clozeColor: "",
  newCardsPerDay: 20,
  licenseCode: "",
};

function sanitizeNewCardsPerDay(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 9999 ? count : DEFAULT_SETTINGS.newCardsPerDay;
}

const CRISP_LICENSE_VERIFY_URL = "https://license.letschips.xyz/api/verify-device";
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

function normalizeHexColor(str, fallback = "#6b84bf") {
  if (!str || typeof str !== "string") return fallback;
  const s = str.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return fallback;
}

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

// 库内其它 Crisp 插件保存的授权码，按磁盘上的目录顺序去重收集（不含 Recall 自己）。
function collectVaultCrispLicenseCandidates(app) {
  const candidates = [];
  const seen = new Set();
  try {
    const configDir = app?.vault?.configDir || ".obsidian";
    const basePath = app?.vault?.adapter?.basePath || "";
    if (!basePath) return candidates;
    const pluginsDir = path.join(basePath, configDir, "plugins");
    if (!fs.existsSync(pluginsDir)) return candidates;

    for (const dir of fs.readdirSync(pluginsDir)) {
      if (!dir.startsWith("crisp-") || dir === "crisp-recall") continue;
      const dataPath = path.join(pluginsDir, dir, "data.json");
      if (!fs.existsSync(dataPath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
        const code = typeof data?.licenseCode === "string" ? data.licenseCode.trim() : "";
        if (code.includes(".") && !seen.has(code)) {
          seen.add(code);
          candidates.push(code);
        }
      } catch (e) {}
    }
  } catch (e) {}
  return candidates;
}

// 返回一张本地校验通过的授权码，找不到则返回 null。校验必须发生在写入设置之前：
// 先保存后校验会把一张无效码固化下来，之后设置里已有码，就再也不会重新扫描。
async function discoverVaultCrispLicense(app) {
  for (const code of collectVaultCrispLicenseCandidates(app)) {
    const local = await verifyCrispRecallLicense(code, { online: false });
    if (local.valid) return code;
  }
  return null;
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

    if (options.online === true || typeof options.request === "function") {
      const onlineRequest = options.request || requestUrl;
      try {
        const response = await Promise.race([
          onlineRequest({
            url: CRISP_LICENSE_VERIFY_URL,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              licenseCode: trimmed,
              deviceId: (options.getDeviceId || getDeviceId)(),
              action: "activate",
              pluginId: permission.onlinePluginId,
            }),
            throw: false,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Crisp license check timeout")), 2500))
        ]);

        let cloudResult = null;
        try {
          cloudResult = response.json;
        } catch {
          cloudResult = null;
        }

        // 1. 明确的服务端业务拒绝（200/400/401/403 且带有明确的 valid: false）
        const isAuthDenial =
          (response.status === 200 || response.status === 400 || response.status === 401 || response.status === 403) &&
          cloudResult !== null &&
          cloudResult.valid === false;

        if (isAuthDenial) {
          return {
            valid: false,
            reason: cloudResult?.reason || "授权已被服务端拒绝或设备数已达上限"
          };
        }

        // 2. 服务端明确批准（200 OK 且 valid: true）
        if (response.status === 200 && cloudResult && cloudResult.valid === true) {
          return { valid: true, payload, message: cloudResult.message || null, source: "online" };
        }

        // 其余情况（404/408/429/5xx、网关故障等）均视为服务不可用，降级离线可用
        if (response.status >= 400) {
          console.warn(`[Crisp Recall] License server unavailable (status ${response.status}), offline fallback`);
        }
      } catch {
        console.debug("Crisp Recall license online check offline fallback");
      }
    }

    return { valid: true, payload, message: "离线验证成功", source: "offline" };
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

// Obsidian math: $$...$$ (may span lines) or $...$ on one line with no space just inside either dollar.
// A backslash escapes a dollar. Each range covers the delimiters; content sits between them.
function findMathRanges(text) {
  const ranges = [];
  const isDollar = (i) => text[i] === "$" && text[i - 1] !== "\\";
  let index = 0;

  while (index < text.length) {
    if (!isDollar(index)) {
      index++;
      continue;
    }
    if (isDollar(index + 1)) {
      const close = text.indexOf("$$", index + 2);
      if (close <= index + 2) {
        index += 2;
        continue;
      }
      ranges.push({ start: index, end: close + 2, contentStart: index + 2, contentEnd: close, display: true });
      index = close + 2;
      continue;
    }
    let close = -1;
    if (text[index + 1] && !/\s/.test(text[index + 1])) {
      for (let j = index + 1; j < text.length && text[j] !== "\n"; j++) {
        if (isDollar(j) && !/\s/.test(text[j - 1])) {
          close = j;
          break;
        }
      }
    }
    if (close === -1) {
      index++;
      continue;
    }
    ranges.push({ start: index, end: close + 1, contentStart: index + 1, contentEnd: close, display: false });
    index = close + 1;
  }

  return ranges;
}

// Formula content is never card syntax: "=" and "::" inside it belong to the formula.
function maskMath(text) {
  const masked = text.split("");
  for (const range of findMathRanges(text)) masked.fill(" ", range.contentStart, range.contentEnd);
  return masked.join("");
}

// ==target== written inside a formula marks a cloze; the target itself may contain "=". In "E===mc^2=="
// the first "=" belongs to the formula, so a cloze never starts with "=".
const MATH_CLOZE_PATTERN = /==(?!=)((?:(?!==)[\s\S])+?)==/g;
const MATH_CLOZE_BLANK = "\\boxed{\\,?\\,}";

// Splits LaTeX at its top-level & and \\ (outside braces and environments). Even indexes hold content and
// odd indexes the separators, which must stay outside any group for a matrix or alignment to typeset.
function splitMathAlignment(latex) {
  const parts = [];
  let braces = 0;
  let environments = 0;
  let start = 0;
  for (let i = 0; i < latex.length; i++) {
    const topLevel = braces === 0 && environments === 0;
    if (latex[i] === "\\") {
      if (latex[i + 1] === "\\" && topLevel) {
        parts.push(latex.slice(start, i), "\\\\");
        start = i + 2;
      } else if (latex.startsWith("\\begin{", i)) environments++;
      else if (latex.startsWith("\\end{", i)) environments = Math.max(0, environments - 1);
      i++;
    } else if (latex[i] === "{") braces++;
    else if (latex[i] === "}") braces = Math.max(0, braces - 1);
    else if (latex[i] === "&" && topLevel) {
      parts.push(latex.slice(start, i), "&");
      start = i + 1;
    }
  }
  parts.push(latex.slice(start));
  return parts;
}

// Applies wrap(content) to every aligned part of a cloze target, keeping & and \\ between the parts.
function wrapMathClozeParts(target, wrap) {
  return splitMathAlignment(target).map((part, index) => {
    if (index % 2 === 1 || !part.trim()) return part;
    const [, lead, content, trail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return `${lead}${wrap(content)}${trail}`;
  }).join("");
}

// A cloze answer typesets on its own, so aligned parts need an environment of their own.
function mathClozeAnswer(target) {
  const latex = target.trim();
  return splitMathAlignment(latex).length > 1 ? `\\begin{matrix}${latex}\\end{matrix}` : latex;
}

// Removes cloze markers from every formula in a line of Markdown.
function unwrapLineMathClozes(text) {
  let output = "";
  let index = 0;
  for (const range of findMathRanges(maskInlineCode(text))) {
    output += text.slice(index, range.contentStart) + unwrapMathClozes(text.slice(range.contentStart, range.contentEnd));
    index = range.contentEnd;
  }
  return output + text.slice(index);
}

function findMathClozes(latex) {
  return Array.from(latex.matchAll(MATH_CLOZE_PATTERN)).filter((match) => match[1].trim());
}

// Rewrites each cloze in a formula: replacer(target, clozeIndex) returns its LaTeX.
function replaceMathClozes(latex, replacer) {
  let clozeIndex = 0;
  return latex.replace(MATH_CLOZE_PATTERN, (match, target) => (
    target.trim() ? replacer(target, clozeIndex++) : match
  ));
}

const unwrapMathClozes = (latex) => replaceMathClozes(latex, (target) => target);

// The formula with one cloze blanked out and the others shown as written.
function blankMathCloze(latex, clozeIndex) {
  return replaceMathClozes(latex, (target, k) => (
    k === clozeIndex ? wrapMathClozeParts(target, () => MATH_CLOZE_BLANK) : target
  ));
}

const stripQuoteMarkers = (text) => text.replace(/^(?:>\s*)+/, "");

function maskCrispAnnotationDirectives(text) {
  return text.replace(
    /\{ann\s+(?:"(?:\\.|[^"\\])*"|[^}])*\}/gi,
    (match) => " ".repeat(match.length),
  );
}

function stripCrispAnnotationDirectives(text) {
  return text.replace(/\{ann\s+(?:"(?:\\.|[^"\\])*"|[^}])*\}/gi, "").trim();
}

function stripCardPrefix(text) {
  return text
    .replace(/^(?:>\s*)+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[.\]\s+/, "")
    .trim();
}

// Removes Obsidian %%comments%% and HTML <!-- comments -->, which never render. `state.closer` carries an
// unterminated comment into the following lines. Delimiters inside inline code are not comments.
function stripMarkdownComments(line, state) {
  const searchable = maskInlineCode(line);
  let output = "";
  let index = 0;

  while (index < line.length) {
    if (state.closer) {
      const closeIndex = searchable.indexOf(state.closer, index);
      if (closeIndex === -1) return output;
      index = closeIndex + state.closer.length;
      state.closer = null;
      continue;
    }

    const percentIndex = searchable.indexOf("%%", index);
    const htmlIndex = searchable.indexOf("<!--", index);
    if (percentIndex === -1 && htmlIndex === -1) {
      output += line.slice(index);
      break;
    }
    const isPercent = percentIndex !== -1 && (htmlIndex === -1 || percentIndex < htmlIndex);
    const openIndex = isPercent ? percentIndex : htmlIndex;
    output += line.slice(index, openIndex);
    index = openIndex + (isPercent ? 2 : 4);
    state.closer = isPercent ? "%%" : "-->";
  }

  return output;
}

function formatClozeSelection(selection) {
  const chunks = selection.split(/(\r?\n)/);
  const lines = chunks
    .filter((_chunk, index) => index % 2 === 0)
    .map((line) => {
      const match = line.match(/^(\s*(?:(?:>\s*)+)?(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?)(.*)$/);
      const prefix = match?.[1] || "";
      const rawBody = match?.[2] || "";
      const suffix = rawBody.match(/\s*$/)?.[0] || "";
      const body = suffix ? rawBody.slice(0, -suffix.length) : rawBody;
      return {
        prefix,
        body,
        suffix,
        eligible: body.length > 0 && body !== "$$",
        wrapped: body.startsWith("==") && body.endsWith("==") && body.length >= 4,
      };
    });
  const eligibleLines = lines.filter((line) => line.eligible);
  // Lines of a formula are one formula: wrapping each line would split an environment such as aligned.
  const isFormula = lines.some((line) => line.body === "$$" || /^\\(?:begin|end)\{/.test(line.body));
  if (isFormula && eligibleLines.length > 0) {
    const first = eligibleLines[0];
    const last = eligibleLines[eligibleLines.length - 1];
    const unwrapFormula = first.body.startsWith("==") && last.body.endsWith("==")
      && (first !== last || first.wrapped);
    let lineIndex = 0;
    return chunks.map((chunk, index) => {
      if (index % 2 === 1) return chunk;
      const line = lines[lineIndex++];
      if (line !== first && line !== last) return chunk;
      let body = line.body;
      if (line === first) body = unwrapFormula ? body.slice(2) : `==${body}`;
      if (line === last) body = unwrapFormula ? body.slice(0, -2) : `${body}==`;
      return `${line.prefix}${body}${line.suffix}`;
    }).join("");
  }
  const unwrap = eligibleLines.length > 0 && eligibleLines.every((line) => line.wrapped);
  let lineIndex = 0;

  return chunks.map((chunk, index) => {
    if (index % 2 === 1) return chunk;
    const line = lines[lineIndex++];
    if (!line.eligible) return chunk;
    if (unwrap) {
      return `${line.prefix}${line.body.slice(2, -2)}${line.suffix}`;
    }
    if (line.wrapped) return chunk;
    return `${line.prefix}==${line.body}==${line.suffix}`;
  }).join("");
}

function findDoubleColonSeparator(searchableLine) {
  const withoutAnkiClozes = searchableLine.replace(/\{\{?c\d+::[^}]+\}\}?/gi, (match) => " ".repeat(match.length));
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

// `searchable` is the rendered line with its formulas blanked out (see renderedCardText).
function parseDoubleColonLine(line, { allowEmptyAnswer = false, searchable } = {}) {
  const separatorInfo = findDoubleColonSeparator(searchable === undefined
    ? maskMath(maskCrispAnnotationDirectives(maskInlineCode(line)))
    : maskCrispAnnotationDirectives(maskInlineCode(searchable)));
  if (!separatorInfo) return null;

  const prompt = stripCardPrefix(stripCrispAnnotationDirectives(line.slice(0, separatorInfo.index)));
  const answer = stripCrispAnnotationDirectives(
    line.slice(separatorInfo.index + separatorInfo.separator.length),
  );
  if (!prompt || (!answer && !allowEmptyAnswer) || /^https?:\/\//i.test(prompt)) return null;

  return { prompt, answer, isBiDirectional: separatorInfo.isBiDirectional };
}

// "Question ::" with nothing after the separator: the math block on the next line is its answer.
function parseMathQuestionLine(line) {
  const text = (line || "").trim();
  if (text.startsWith("|") || /^#{1,6}\s/.test(text)) return null;
  const card = parseDoubleColonLine(text, { allowEmptyAnswer: true });
  return card && !card.answer ? card : null;
}

// For each math block a section renders, in order: whether it answers the "Question ::" line right above
// it, read from the section's source as the review parser reads it. Null without source lines.
function mathBlockAnswerFlags(info) {
  if (!info?.text) return null;
  const lines = info.text.split("\n");
  const flags = [];
  let inBlock = false;
  for (let i = info.lineStart; i <= info.lineEnd && i < lines.length; i++) {
    const line = stripQuoteMarkers(lines[i].trim());
    if (inBlock) {
      if (line.endsWith("$$")) inBlock = false;
      continue;
    }
    if (line.startsWith("$$")) {
      flags.push(!!parseMathQuestionLine(lines[i - 1]));
      const rest = line.slice(2);
      inBlock = !(rest.length >= 2 && rest.endsWith("$$"));
      continue;
    }
    for (const range of findMathRanges(maskInlineCode(line))) {
      if (range.display) flags.push(false);
    }
  }
  return flags;
}

// Without source lines: a one-line $$formula$$ under "Question ::" shares its paragraph after a soft break.
function isSoftBreakMathAnswer(mathEl) {
  let node = mathEl.previousSibling;
  while (node?.nodeType === 3 && !node.nodeValue.trim()) node = node.previousSibling;
  if (node?.nodeName !== "BR") return false;
  let text = "";
  for (let prev = node.previousSibling; prev && prev.nodeName !== "BR"; prev = prev.previousSibling) {
    text = prev.textContent + text;
  }
  return !!parseMathQuestionLine(text);
}

function restoreRecallMath(mathEl) {
  const originalHtml = mathEl.dataset.crispRecallOriginalHtml;
  if (originalHtml !== undefined) mathEl.innerHTML = originalHtml;
  delete mathEl.dataset.crispRecallOriginalHtml;
  mathEl.classList.remove("crisp-recall-math");
}

// Splits a rendered "prompt :: answer" paragraph or list item around the separator while keeping its
// links, emphasis and highlights. List bullets and task checkboxes stay in place. Returns null when the
// DOM cannot be split, and the caller falls back to plain text.
function extractCardLineParts(el, searchable) {
  const doc = el.ownerDocument;
  if (!doc?.createRange || !doc.createTreeWalker || !el.lastChild) return null;
  const separatorInfo = findDoubleColonSeparator(maskCrispAnnotationDirectives(maskInlineCode(searchable)));
  if (!separatorInfo) return null;

  const separatorStart = separatorInfo.index;
  const separatorEnd = separatorStart + separatorInfo.separator.length;
  let start = null;
  let end = null;
  let offset = 0;
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node && !end; node = walker.nextNode()) {
    const length = node.nodeValue.length;
    if (!start && separatorStart < offset + length) start = { node, offset: separatorStart - offset };
    if (start && separatorEnd <= offset + length) end = { node, offset: separatorEnd - offset };
    offset += length;
  }
  if (!start || !end) return null;

  const isStructural = (node) => node.nodeType === 1
    && node.matches?.(".list-bullet, .list-collapse-indicator, .task-list-item-checkbox");
  let firstContent = el.firstChild;
  while (firstContent && isStructural(firstContent)) firstContent = firstContent.nextSibling;
  if (!firstContent) return null;

  const answerRange = doc.createRange();
  answerRange.setStart(end.node, end.offset);
  answerRange.setEndAfter(el.lastChild);
  const answer = answerRange.extractContents();

  const separatorRange = doc.createRange();
  separatorRange.setStart(start.node, start.offset);
  separatorRange.setEnd(end.node, end.offset);
  separatorRange.deleteContents();

  const promptRange = doc.createRange();
  promptRange.setStartBefore(firstContent);
  promptRange.setEndAfter(el.lastChild);
  return { prompt: promptRange.extractContents(), answer };
}

// The text of rendered nodes, and a copy of the same length with formula glyphs blanked so that "::"
// inside a formula is never taken for a card separator.
function renderedCardText(nodes) {
  let text = "";
  let searchable = "";
  const add = (textNode) => {
    const value = textNode.nodeValue;
    text += value;
    searchable += textNode.parentElement?.closest?.(".math") ? " ".repeat(value.length) : value;
  };
  for (const node of nodes) {
    if (node.nodeType === 3) {
      add(node);
      continue;
    }
    const walker = node.ownerDocument?.createTreeWalker?.(node, 4 /* NodeFilter.SHOW_TEXT */);
    if (!walker) {
      text += node.textContent || "";
      searchable += node.textContent || "";
      continue;
    }
    for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) add(textNode);
  }
  return { text, searchable };
}

function trimEdgeWhitespace(el) {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  const textNodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node);
  if (textNodes.length === 0) return;
  textNodes[0].nodeValue = textNodes[0].nodeValue.trimStart();
  const last = textNodes[textNodes.length - 1];
  last.nodeValue = last.nodeValue.trimEnd();
}

function parseFlashcardsFromText(text, filePath = "", options = {}) {
  const cards = [];
  const lines = text.split("\n");
  const enableCloze = options.enableCloze !== false;
  const enableDoubleColon = options.enableDoubleColon !== false;
  let inFrontmatter = false;
  let fence = null;
  let mathBlock = null;
  let mathQuestion = null;
  const commentState = { closer: null };

  const pushConceptCards = (card, line) => {
    cards.push({
      id: `${filePath}:${line}:concept`,
      type: "concept",
      typeName: card.isBiDirectional ? "双向概念卡" : "问答 / 概念卡",
      prompt: card.prompt,
      answer: card.answer,
      line,
      filePath: filePath,
    });
    if (card.isBiDirectional) {
      cards.push({
        id: `${filePath}:${line}:concept:reverse`,
        type: "concept",
        isReverse: true,
        typeName: "双向概念卡",
        prompt: card.answer,
        answer: card.prompt,
        line,
        filePath: filePath,
      });
    }
  };

  // A math block answers the "Question ::" line right above it; otherwise each ==target== inside it is a
  // cloze that hides that part of the formula.
  const emitMathBlock = (block) => {
    const latex = block.lines.join("\n").trim();
    const question = mathQuestion?.line === block.line - 1 ? mathQuestion : null;
    mathQuestion = null;
    if (!latex) return;
    if (question) {
      pushConceptCards({ ...question, answer: `$$${unwrapMathClozes(latex)}$$` }, question.line);
      return;
    }
    if (!enableCloze) return;
    findMathClozes(latex).forEach((match, clozeIndex) => {
      cards.push({
        id: `${filePath}:${block.line}:cloze:${clozeIndex + 1}`,
        type: "cloze",
        typeName: "挖空填空卡",
        prompt: `$$${blankMathCloze(latex, clozeIndex)}$$`,
        answer: `$$${mathClozeAnswer(match[1])}$$`,
        line: block.line,
        filePath: filePath,
      });
    });
  };

  for (let i = 0; i < lines.length; i++) {
    let line = (i === 0 ? lines[i].replace(/^\uFEFF/, "") : lines[i]).trim();

    if (i === 0 && line === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === "---" || line === "...") inFrontmatter = false;
      continue;
    }

    if (!fence) line = stripMarkdownComments(line, commentState).trim();

    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], length: marker.length };
      // A closing fence carries no info string; "```js" inside a block is still code.
      else if (
        marker[0] === fence.char
        && marker.length >= fence.length
        && !line.slice(marker.length).trim()
      ) fence = null;
      continue;
    }
    if (fence) continue;

    // Math blocks may sit in a blockquote or callout, behind ">" markers.
    const mathLine = stripQuoteMarkers(line);
    if (mathBlock) {
      const closes = mathLine.endsWith("$$");
      mathBlock.lines.push(closes ? mathLine.slice(0, -2) : mathLine);
      if (closes) {
        emitMathBlock(mathBlock);
        mathBlock = null;
      }
      continue;
    }
    if (mathLine.startsWith("$$")) {
      const rest = mathLine.slice(2);
      const closes = rest.length >= 2 && rest.endsWith("$$");
      mathBlock = { line: i, lines: [closes ? rest.slice(0, -2) : rest] };
      if (closes) {
        emitMathBlock(mathBlock);
        mathBlock = null;
      }
      continue;
    }
    if (!line) continue;

    // Structural Markdown is documentation, not card content.
    if (line.startsWith("|") || /^#{1,6}\s/.test(line)) continue;

    const codeMaskedLine = maskCrispAnnotationDirectives(maskInlineCode(line));
    const searchableLine = maskMath(codeMaskedLine);

    // 1. Double colon cards: "Prompt :: Answer" or "Prompt ::: Answer"
    if (enableDoubleColon && stripQuoteMarkers((lines[i + 1] || "").trim()).startsWith("$$")) {
      const question = parseMathQuestionLine(line);
      if (question) {
        mathQuestion = { ...question, line: i };
        continue;
      }
    }
    const doubleColonCard = enableDoubleColon ? parseDoubleColonLine(line) : null;
    if (doubleColonCard) {
      // A formula answer is one whole answer; markers inside it are not clozes of their own.
      pushConceptCards({
        ...doubleColonCard,
        prompt: unwrapLineMathClozes(doubleColonCard.prompt),
        answer: unwrapLineMathClozes(doubleColonCard.answer),
      }, i);
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

    // 3. Cloze Deletions: ==target==, {{c1::target::hint}}, or legacy {c1::target}; inside a $formula$,
    // ==target== hides that part of the formula.
    if (!enableCloze) continue;
    const clozes = [];
    const clozeRegex = /==([^=]+)==|\{\{c\d+::((?:(?!::)[^}])+)(?:::[^}]*)?\}\}|\{c\d+::((?:(?!::)[^}])+)(?:::[^}]*)?\}/g;
    let match;
    while ((match = clozeRegex.exec(searchableLine)) !== null) {
      const group = match[1] ?? match[2] ?? match[3] ?? "";
      const groupStart = match.index + (match[1] !== undefined ? 2 : match[0].indexOf("::") + 2);
      // Read the target from the line itself: the searchable copy blanks out formulas.
      const target = line.slice(groupStart, groupStart + group.length).trim();
      if (!target) continue;
      // Prompt is the sentence with [ ... ] replacing the target
      clozes.push({
        index: match.index,
        prompt: `${line.slice(0, match.index)} [ ❓ …… ] ${line.slice(match.index + match[0].length)}`,
        answer: target,
      });
    }
    for (const range of findMathRanges(codeMaskedLine)) {
      const latex = line.slice(range.contentStart, range.contentEnd);
      const delimiter = range.display ? "$$" : "$";
      findMathClozes(latex).forEach((mathMatch, clozeIndex) => {
        const blanked = blankMathCloze(latex, clozeIndex);
        clozes.push({
          index: range.contentStart + mathMatch.index,
          prompt: `${line.slice(0, range.contentStart)}${blanked}${line.slice(range.contentEnd)}`,
          answer: `${delimiter}${mathClozeAnswer(mathMatch[1])}${delimiter}`,
        });
      });
    }
    clozes.sort((a, b) => a.index - b.index);
    clozes.forEach((cloze, clozeIndex) => {
      cards.push({
        id: `${filePath}:${i}:cloze:${clozeIndex + 1}`,
        type: "cloze",
        typeName: "挖空填空卡",
        prompt: stripCardPrefix(stripCrispAnnotationDirectives(cloze.prompt)),
        answer: cloze.answer,
        line: i,
        filePath: filePath,
      });
    });
  }

  assignCardKeys(cards);
  return cards;
}

// --------------------------------------------------------------------------
// 1b. Spaced repetition: content keys, FSRS-5 scheduling, review-state.json
// --------------------------------------------------------------------------

// cyrb53: a small 53-bit string hash that needs no Node or WebCrypto, so it also runs on mobile.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function normalizeCardText(text) {
  return String(text ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Keys depend on card content only, so inserting lines above a card keeps its review history. */
function assignCardKeys(cards) {
  const seen = new Map();
  for (const card of cards) {
    const kind = card.isReverse ? `${card.type}-reverse` : card.type;
    const base = cyrb53(`${kind}\u0000${normalizeCardText(card.prompt)}\u0000${normalizeCardText(card.answer)}`).toString(36);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    card.key = occurrence === 1 ? base : `${base}#${occurrence}`;
  }
  return cards;
}

// Review days are local calendar dates ("YYYY-MM-DD"); a new day starts at local midnight.
function recallDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function recallKeyToUtc(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function recallDayDiff(fromKey, toKey) {
  return Math.round((recallKeyToUtc(toKey) - recallKeyToUtc(fromKey)) / 86400000);
}

function recallAddDays(key, days) {
  const date = new Date(recallKeyToUtc(key) + days * 86400000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// FSRS-5 with its default weights and 90% desired retention, scheduled in whole days. Mirrors the
// long-term scheduler of ts-fsrs 4.x (enable_short_term: false, no fuzz); tests replay its output.
const RECALL_FSRS_WEIGHTS = Object.freeze([
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
]);
const RECALL_FSRS_DECAY = -0.5;
const RECALL_FSRS_FACTOR = 19 / 81;
const RECALL_FSRS_RETENTION = 0.9;
const RECALL_FSRS_MAX_INTERVAL = 36500;
const RECALL_FSRS_S_MIN = 0.01;
const RECALL_FSRS_INTERVAL_MODIFIER = +(
  (Math.pow(RECALL_FSRS_RETENTION, 1 / RECALL_FSRS_DECAY) - 1) / RECALL_FSRS_FACTOR
).toFixed(8);
const RECALL_RATING_GRADES = Object.freeze({ again: 1, hard: 2, good: 3 });
const RECALL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const fsrsRound = (value) => +value.toFixed(8);
const fsrsClamp = (value, min, max) => Math.min(Math.max(value, min), max);

function fsrsConstrainDifficulty(difficulty) {
  return Math.min(Math.max(fsrsRound(difficulty), 1), 10);
}

function fsrsInitDifficulty(grade) {
  const w = RECALL_FSRS_WEIGHTS;
  return fsrsConstrainDifficulty(w[4] - Math.exp((grade - 1) * w[5]) + 1);
}

function fsrsNextDifficulty(difficulty, grade) {
  const w = RECALL_FSRS_WEIGHTS;
  const delta = -w[6] * (grade - 3);
  const damped = difficulty + fsrsRound((delta * (10 - difficulty)) / 9);
  return fsrsConstrainDifficulty(fsrsRound(w[7] * fsrsInitDifficulty(4) + (1 - w[7]) * damped));
}

function fsrsRetrievability(elapsedDays, stability) {
  return fsrsRound(Math.pow(1 + (RECALL_FSRS_FACTOR * elapsedDays) / stability, RECALL_FSRS_DECAY));
}

function fsrsRecallStability(difficulty, stability, retrievability, grade) {
  const w = RECALL_FSRS_WEIGHTS;
  const hardPenalty = grade === RECALL_RATING_GRADES.hard ? w[15] : 1;
  const growth = Math.exp(w[8]) * (11 - difficulty) * Math.pow(stability, -w[9])
    * (Math.exp((1 - retrievability) * w[10]) - 1) * hardPenalty;
  return fsrsRound(fsrsClamp(stability * (1 + growth), RECALL_FSRS_S_MIN, 36500));
}

function fsrsForgetStability(difficulty, stability, retrievability) {
  const w = RECALL_FSRS_WEIGHTS;
  return fsrsRound(fsrsClamp(
    w[11] * Math.pow(difficulty, -w[12]) * (Math.pow(stability + 1, w[13]) - 1) * Math.exp((1 - retrievability) * w[14]),
    RECALL_FSRS_S_MIN,
    36500,
  ));
}

function fsrsInterval(stability) {
  return Math.min(Math.max(1, Math.round(stability * RECALL_FSRS_INTERVAL_MODIFIER)), RECALL_FSRS_MAX_INTERVAL);
}

function isValidRecallRecord(record) {
  return !!record && typeof record === "object"
    && Number.isFinite(record.s) && record.s >= RECALL_FSRS_S_MIN
    && Number.isFinite(record.d) && record.d >= 1 && record.d <= 10
    && RECALL_DATE_PATTERN.test(record.due) && RECALL_DATE_PATTERN.test(record.last)
    && Number.isInteger(record.reps) && record.reps >= 0;
}

/** Memory state and interval in days for each rating, after enforcing again < hard < good. */
function fsrsNextStates(record, today) {
  const states = {};
  if (!isValidRecallRecord(record)) {
    for (const [rating, grade] of Object.entries(RECALL_RATING_GRADES)) {
      states[rating] = { s: Math.max(RECALL_FSRS_WEIGHTS[grade - 1], 0.1), d: fsrsInitDifficulty(grade) };
    }
  } else {
    const elapsed = Math.max(0, recallDayDiff(record.last, today));
    const r = fsrsRetrievability(elapsed, record.s);
    states.again = {
      s: fsrsClamp(fsrsRound(record.s), RECALL_FSRS_S_MIN, fsrsForgetStability(record.d, record.s, r)),
      d: fsrsNextDifficulty(record.d, RECALL_RATING_GRADES.again),
    };
    states.hard = {
      s: fsrsRecallStability(record.d, record.s, r, RECALL_RATING_GRADES.hard),
      d: fsrsNextDifficulty(record.d, RECALL_RATING_GRADES.hard),
    };
    states.good = {
      s: fsrsRecallStability(record.d, record.s, r, RECALL_RATING_GRADES.good),
      d: fsrsNextDifficulty(record.d, RECALL_RATING_GRADES.good),
    };
  }
  let again = fsrsInterval(states.again.s);
  let hard = fsrsInterval(states.hard.s);
  let good = fsrsInterval(states.good.s);
  again = Math.min(again, hard);
  hard = Math.max(hard, again + 1);
  good = Math.max(good, hard + 1);
  states.again.interval = again;
  states.hard.interval = hard;
  states.good.interval = good;
  return states;
}

function previewRecallIntervals(record, today) {
  const states = fsrsNextStates(record, today);
  return { again: states.again.interval, hard: states.hard.interval, good: states.good.interval };
}

function scheduleRecallReview(record, rating, today, at = Date.now()) {
  if (!Object.hasOwn(RECALL_RATING_GRADES, rating)) throw new Error(`Unknown rating: ${rating}`);
  const previous = isValidRecallRecord(record) ? record : null;
  const next = fsrsNextStates(previous, today)[rating];
  return {
    s: next.s,
    d: next.d,
    due: recallAddDays(today, next.interval),
    last: today,
    at,
    reps: previous ? previous.reps + 1 : 1,
    lapses: (Number.isInteger(previous?.lapses) ? previous.lapses : 0) + (previous && rating === "again" ? 1 : 0),
    first: previous && RECALL_DATE_PATTERN.test(previous.first) ? previous.first : today,
  };
}

function formatRecallInterval(days) {
  const oneDecimal = (value) => String(Math.round(value * 10) / 10);
  if (days <= 1) return "明天";
  if (days < 30) return `${days} 天`;
  if (days < 365) return `${oneDecimal(days / 30)} 个月`;
  return `${oneDecimal(days / 365)} 年`;
}

const RECALL_REVIEW_STATE_VERSION = 1;

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseRecallReviewState(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || !Number.isInteger(parsed.version) || parsed.version < 1) return null;
  if (!isPlainRecord(parsed.files) || !Object.values(parsed.files).every(isPlainRecord)) return null;
  return { version: parsed.version, files: parsed.files };
}

/** Copies records from source into target; per card, the record reviewed later wins. */
function mergeRecallRecords(target, source) {
  for (const [key, record] of Object.entries(source)) {
    const current = Object.hasOwn(target, key) ? target[key] : null;
    if (!current || (Number(record?.at) || 0) > (Number(current?.at) || 0)) target[key] = record;
  }
  return target;
}

/**
 * Review records live in their own file so frequent review writes never touch the license and settings
 * in data.json. Like data.json, an unreadable file is copied aside before anything replaces it, and
 * every write is read back because a vault adapter write can fail without throwing.
 */
class RecallReviewStore {
  constructor(adapter, filePath) {
    this.adapter = adapter;
    this.filePath = filePath;
    this.files = {};
    this.diskText = null;
    this.writeBlocked = false;
    this.blockReason = null;
    this.backedUp = false;
    this.saveQueue = Promise.resolve();
  }

  async load() {
    let text;
    try {
      if (!this.adapter) throw new Error("vault adapter unavailable");
      if (!(await this.adapter.exists(this.filePath))) return { state: "missing" };
      text = await this.adapter.read(this.filePath);
    } catch (error) {
      return this.preserveUnreadable(error);
    }
    const parsed = parseRecallReviewState(text);
    if (!parsed) return this.preserveUnreadable(null, text);
    this.files = parsed.files;
    this.diskText = text;
    if (parsed.version > RECALL_REVIEW_STATE_VERSION) {
      this.block("newer");
      return { state: "newer" };
    }
    return { state: "loaded" };
  }

  async preserveUnreadable(readError, text = null) {
    const result = await preserveUnreadableData(this.adapter, this.filePath);
    if (result.state === "preserved") {
      // The unreadable original now has a copy, so the next save may replace it.
      this.diskText = text;
      this.backedUp = true;
      return result;
    }
    this.block("unreadable");
    return { state: "failed", error: result.error || readError };
  }

  block(reason) {
    this.writeBlocked = true;
    this.blockReason = reason;
  }

  get(filePath, key) {
    const records = Object.hasOwn(this.files, filePath) ? this.files[filePath] : null;
    const record = records && Object.hasOwn(records, key) ? records[key] : null;
    return isValidRecallRecord(record) ? record : null;
  }

  rate(filePath, key, rating, today, at = Date.now()) {
    const record = scheduleRecallReview(this.get(filePath, key), rating, today, at);
    if (!Object.hasOwn(this.files, filePath)) this.files[filePath] = {};
    this.files[filePath][key] = record;
    return record;
  }

  countIntroducedOn(today) {
    let count = 0;
    for (const records of Object.values(this.files)) {
      for (const record of Object.values(records)) {
        if (record?.first === today) count++;
      }
    }
    return count;
  }

  /** Moves records for a renamed note, or for every note under a renamed folder. */
  renamePath(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return false;
    const moved = Object.keys(this.files).filter((filePath) =>
      filePath === oldPath || filePath.startsWith(`${oldPath}/`)
    );
    for (const filePath of moved) {
      const target = `${newPath}${filePath.slice(oldPath.length)}`;
      if (!Object.hasOwn(this.files, target)) this.files[target] = {};
      mergeRecallRecords(this.files[target], this.files[filePath]);
      delete this.files[filePath];
    }
    return moved.length > 0;
  }

  /** Saves are queued so two writes never interleave; each one writes the whole current state. */
  save() {
    const run = this.saveQueue.then(() => this.writeNow());
    this.saveQueue = run.catch(() => {});
    return run;
  }

  async writeNow() {
    if (this.writeBlocked) return { ok: false, reason: this.blockReason };
    try {
      const adapter = this.adapter;
      if (await adapter.exists(this.filePath)) {
        const disk = await adapter.read(this.filePath);
        if (disk !== this.diskText) {
          // Another device (or a sync conflict) changed the file since we last read or wrote it.
          const parsed = parseRecallReviewState(disk);
          if (!parsed) {
            const result = await preserveUnreadableData(adapter, this.filePath);
            if (result.state !== "preserved") return { ok: false, error: result.error };
          } else if (parsed.version > RECALL_REVIEW_STATE_VERSION) {
            this.block("newer");
            return { ok: false, reason: "newer" };
          } else {
            for (const [filePath, records] of Object.entries(parsed.files)) {
              if (!Object.hasOwn(this.files, filePath)) this.files[filePath] = {};
              mergeRecallRecords(this.files[filePath], records);
            }
          }
        }
        if (!this.backedUp) {
          const backupPath = `${this.filePath}.bak`;
          await adapter.write(backupPath, disk);
          if ((await adapter.read(backupPath)) !== disk) {
            return { ok: false, error: new Error("review-state.json.bak did not read back") };
          }
          this.backedUp = true;
        }
      }
      const text = JSON.stringify({
        version: RECALL_REVIEW_STATE_VERSION,
        algorithm: "fsrs-5",
        files: this.files,
      });
      await adapter.write(this.filePath, text);
      if ((await adapter.read(this.filePath)) !== text) {
        return { ok: false, error: new Error("review-state.json did not read back") };
      }
      this.diskText = text;
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }
}

/** Due cards (most overdue first), then as many new cards as today's new-card quota allows. */
function buildDueReviewQueue(cards, store, today, { newLimit = 20, random = Math.random } = {}) {
  const due = [];
  const fresh = [];
  for (const card of cards) {
    const record = store?.get(card.filePath, card.key);
    if (!record) fresh.push(card);
    else if (record.due <= today) due.push({ card, due: record.due });
  }
  due.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  const quota = Math.max(0, newLimit - (store?.countIntroducedOn(today) || 0));
  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
  }
  return [...due.map((entry) => entry.card), ...fresh.slice(0, quota)];
}

// --------------------------------------------------------------------------
// 2. 3D Zen Flashcard Review Modal
// --------------------------------------------------------------------------
// Card text with its $formulas$ typeset. A formula that cannot be typeset stays as written.
function renderRecallCardContent(container, text) {
  const flow = container.createSpan();
  let index = 0;
  let typeset = false;
  if (typeof renderMath === "function") {
    for (const range of findMathRanges(maskInlineCode(text))) {
      let mathEl = null;
      try {
        mathEl = renderMath(text.slice(range.contentStart, range.contentEnd).trim(), range.display);
      } catch (error) {
        console.debug("Crisp Recall could not typeset a formula:", error);
      }
      if (!mathEl) continue;
      if (range.start > index) flow.createSpan({ text: text.slice(index, range.start) });
      flow.append(mathEl);
      index = range.end;
      typeset = true;
    }
  }
  if (index < text.length) flow.createSpan({ text: text.slice(index) });
  if (typeset && typeof finishRenderMath === "function") {
    Promise.resolve(finishRenderMath()).catch(() => {});
  }
}

class CrispRecallReviewModal extends Modal {
  constructor(app, cards, title = "Crisp Recall 抽认练习", { onRate = null, getIntervals = null } = {}) {
    super(app);
    this.cards = cards;
    this.sessionTitle = title;
    this.onRate = onRate;
    this.getIntervals = getIntervals;
    this.currentIndex = 0;
    this.isFlipped = false;
    this.isComplete = false;
    this.stats = { good: 0, hard: 0, again: 0 };
    this.keyHandler = null;
    this.keyWindow = null;
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
    this.keyWindow = modalEl.ownerDocument?.defaultView || window;
    this.keyWindow.addEventListener("keydown", this.keyHandler);

    this.renderCard();
  }

  onClose() {
    if (this.keyHandler && this.keyWindow) {
      this.keyWindow.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
      this.keyWindow = null;
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
    try {
      this.onRate?.(this.cards[this.currentIndex], rating);
    } catch (error) {
      console.error("Crisp Recall could not record a rating", error);
    }
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
    renderRecallCardContent(frontFace.createDiv("crisp-recall-card__content"), currentCard.prompt);
    frontFace.createDiv({ cls: "crisp-recall-card__flip-hint", text: "点击卡片或按 [Space] 查看答案" });

    // Back Face (Answer)
    const backFace = card3d.createDiv("crisp-recall-card-face crisp-recall-card-face--back");
    const backTag = backFace.createDiv("crisp-recall-card__type-tag");
    backTag.createSpan({ text: "✅ 答案解析" });
    renderRecallCardContent(backFace.createDiv("crisp-recall-card__content"), currentCard.answer);
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
      let intervals = null;
      try {
        intervals = this.getIntervals?.(this.cards[this.currentIndex]) || null;
      } catch (error) {
        console.error("Crisp Recall could not preview review intervals", error);
      }
      const addInterval = (button, rating) => {
        if (Number.isFinite(intervals?.[rating])) {
          button.createSpan({ cls: "crisp-recall-grade-btn__interval", text: formatRecallInterval(intervals[rating]) });
        }
      };

      const againBtn = gradingGroup.createEl("button", { cls: "crisp-recall-grade-btn crisp-recall-grade-btn--again" });
      againBtn.createSpan({ text: "🔴 没记住" });
      addInterval(againBtn, "again");
      againBtn.createSpan({ cls: "crisp-recall-grade-btn__key", text: "按 1" });
      againBtn.onclick = () => this.rateCard("again");

      const hardBtn = gradingGroup.createEl("button", { cls: "crisp-recall-grade-btn crisp-recall-grade-btn--hard" });
      hardBtn.createSpan({ text: "🟡 有点犹豫" });
      addInterval(hardBtn, "hard");
      hardBtn.createSpan({ cls: "crisp-recall-grade-btn__key", text: "按 2" });
      hardBtn.onclick = () => this.rateCard("hard");

      const goodBtn = gradingGroup.createEl("button", { cls: "crisp-recall-grade-btn crisp-recall-grade-btn--good" });
      goodBtn.createSpan({ text: "🟢 轻松记下" });
      addInterval(goodBtn, "good");
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

  // Never overwrite a data.json that could not be read and could not be backed up either.
  async saveData(data) {
    if (this.dataWriteBlocked) return;
    await super.saveData(data);
  }

  // loadData() yields undefined when data.json exists but cannot be read; keep a copy before defaults take over.
  async protectUnreadableData(raw) {
    if (raw !== undefined) return;
    const result = await preserveUnreadableData(this.app?.vault?.adapter, `${this.manifest?.dir}/data.json`);
    if (result.state === "preserved") {
      new Notice(`Crisp Recall 的设置文件无法读取，已备份为 ${result.backupPath.split("/").pop()} 并恢复默认设置。`, 12000);
    } else if (result.state === "failed") {
      this.dataWriteBlocked = true;
      console.error("Crisp Recall could not back up unreadable data.json", result.error);
      new Notice("Crisp Recall 的设置文件无法读取，也无法备份。为保护原文件，本次运行不会保存设置。", 0);
    }
  }
  async onload() {
    this.unloaded = false;
    this.selectionDocuments = new Set();
    this.selectionBubbleEls = new Map();
    this.selectionFrames = new Map();
    this.pointerSelectingDocuments = new Set();
    this.cleanupInjectedUi();
    this.reviewModals = new Set();
    const storedSettings = await this.loadData();
    await this.protectUnreadableData(storedSettings);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings, {
      licenseCode: typeof storedSettings?.licenseCode === "string"
        ? storedSettings.licenseCode.trim()
        : "",
      clozeColor: typeof storedSettings?.clozeColor === "string"
        ? storedSettings.clozeColor.trim()
        : "",
      newCardsPerDay: sanitizeNewCardsPerDay(storedSettings?.newCardsPerDay ?? DEFAULT_SETTINGS.newCardsPerDay),
    });
    this.reviewStore = new RecallReviewStore(this.app?.vault?.adapter, `${this.manifest?.dir}/review-state.json`);
    this.reportReviewStoreLoad(await this.reviewStore.load());
    this.licenseState = { valid: false, payload: null, reason: "尚未输入 Crisp 授权码" };
    await this.refreshLicenseState({ online: false });
    this.applyCustomColor();

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
      id: "start-due-review",
      name: "Review cards due today (今日到期复习)",
      callback: () => this.startDueReview(),
    });

    this.addCommand({
      id: "toggle-all-cloze-masks",
      name: "Toggle all cloze masks in active note (一键切换全篇遮罩/揭晓)",
      callback: () => this.toggleAllMasks(),
    });

    this.addCommand({
      id: "wrap-selection-cloze",
      name: "Wrap selection as Cloze (制作挖空 ==文本==)",
      editorCallback: (editor) => this.handleSelectionAction("cloze", editor),
    });

    this.addCommand({
      id: "make-selection-qa",
      name: "Make selection Q&A card (制作问答卡 ::)",
      editorCallback: (editor) => this.handleSelectionAction("qa", editor),
    });

    this.addCommand({
      id: "make-selection-bidirectional",
      name: "Make selection Bidirectional card (制作双向卡 :::)",
      editorCallback: (editor) => this.handleSelectionAction("bidirectional", editor),
    });

    // 3. Add Settings Tab
    this.addSettingTab(new CrispRecallSettingTab(this.app, this));

    // 4. Register Workspace events for Reactive Floating Pill Widget
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateActiveLeafFloatingWidget();
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.updateActiveLeafFloatingWidget();
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && file?.path === activeFile.path) {
          this.updateActiveLeafFloatingWidget(file.path);
        }
      })
    );

    // Review records follow notes and folders that are renamed or moved inside Obsidian.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.handleVaultRename(file, oldPath);
      })
    );

    // 5. Register selection events in the main window and every Obsidian popout.
    if (typeof this.registerDomEvent === "function") {
      const mainDocument = this.app.workspace?.containerEl?.ownerDocument
        || (typeof document !== "undefined" ? document : null);
      this.registerSelectionDocument(mainDocument);
      this.app.workspace?.iterateAllLeaves?.((leaf) => {
        this.registerSelectionDocument(leaf.view?.containerEl?.ownerDocument);
      });
      this.registerEvent(
        this.app.workspace.on("window-open", (_workspaceWindow, windowObj) => {
          this.registerSelectionDocument(windowObj?.document);
          if (windowObj?.document) {
            this.applyCustomColorToDocument(windowObj.document);
          }
        })
      );
      this.registerEvent(
        this.app.workspace.on("window-close", (_workspaceWindow, windowObj) => {
          this.detachSelectionDocument(windowObj?.document);
        })
      );
    }

    this.app.workspace.onLayoutReady(() => {
      if (!this.unloaded) this.updateActiveLeafFloatingWidget();
    });

    console.log("⚡ Crisp Recall Plugin loaded successfully.");
  }

  onunload() {
    this.unloaded = true;
    this.cancelSelectionFrames();
    if (this.reviewModals) {
      [...this.reviewModals].forEach((modal) => modal.close());
      this.reviewModals.clear();
    }
    this.cleanupInjectedUi();
    this.removeCustomColor();
    console.log("Crisp Recall Plugin unloaded.");
  }

  reportReviewStoreLoad(result) {
    if (result.state === "preserved") {
      new Notice(`Crisp Recall 的复习记录无法读取，已备份为 ${result.backupPath.split("/").pop()}，复习进度从空白开始。`, 12000);
    } else if (result.state === "failed") {
      console.error("Crisp Recall could not back up unreadable review-state.json", result.error);
      new Notice("Crisp Recall 的复习记录无法读取，也无法备份。为保护原文件，本次运行不会保存复习进度。", 0);
    } else if (result.state === "newer") {
      new Notice("Crisp Recall 的复习记录由更新版本的插件写入。本次运行只读取、不保存复习进度，请升级 Crisp Recall。", 0);
    }
  }

  async saveReviewState() {
    if (!this.reviewStore) return { ok: false };
    const result = await this.reviewStore.save();
    if (result.ok) {
      this.reviewSaveWarned = false;
    } else if (!result.reason && !this.reviewSaveWarned) {
      // Blocked stores were already reported on load; a failed write is reported once until one succeeds.
      this.reviewSaveWarned = true;
      console.error("Crisp Recall could not save review-state.json", result.error);
      new Notice("Crisp Recall 复习记录未能保存，下一次评分时会重试。", 8000);
    }
    return result;
  }

  recordReviewRating(card, rating) {
    if (!this.reviewStore || !card?.key || !card.filePath) return Promise.resolve({ ok: false });
    this.reviewStore.rate(card.filePath, card.key, rating, recallDateKey(), Date.now());
    return this.saveReviewState();
  }

  async handleVaultRename(file, oldPath) {
    if (!this.reviewStore?.renamePath(oldPath, file?.path)) return;
    await this.saveReviewState();
  }

  openReviewModal(cards, title) {
    if (this.unloaded || !this.ensureLicenseActivated()) return;
    this.hideSelectionBubble();
    const modal = new CrispRecallReviewModal(this.app, cards, title, {
      onRate: (card, rating) => this.recordReviewRating(card, rating),
      getIntervals: (card) => previewRecallIntervals(this.reviewStore?.get(card.filePath, card.key) || null, recallDateKey()),
    });
    if (!this.reviewModals) this.reviewModals = new Set();
    this.reviewModals.add(modal);

    const originalOnClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      try {
        originalOnClose();
      } finally {
        this.reviewModals.delete(modal);
        // Ratings change how many cards are due in each open note.
        if (!this.unloaded) this.updateActiveLeafFloatingWidget(null, { forceAll: true });
      }
    };
    modal.open();
  }

  registerSelectionDocument(doc) {
    if (!doc || !doc.body || this.selectionDocuments?.has(doc)) return;
    this.selectionDocuments.add(doc);

    this.registerDomEvent(doc, "pointerdown", (event) => {
      const bubble = this.selectionBubbleEls?.get(doc);
      if (bubble?.contains?.(event.target)) return;
      this.pointerSelectingDocuments.add(doc);
      this.hideSelectionBubble(doc);
    });

    this.registerDomEvent(doc, "pointerup", (event) => {
      this.pointerSelectingDocuments.delete(doc);
      const bubble = this.selectionBubbleEls?.get(doc);
      if (bubble?.contains?.(event.target)) return;
      this.scheduleSelectionBubbleUpdate(doc);
    });

    this.registerDomEvent(doc, "selectionchange", () => {
      if (!this.pointerSelectingDocuments.has(doc)) {
        this.scheduleSelectionBubbleUpdate(doc);
      }
    });

    this.registerDomEvent(doc, "scroll", (event) => {
      const bubble = this.selectionBubbleEls?.get(doc);
      if (!bubble?.contains?.(event.target)) this.hideSelectionBubble(doc);
    }, true);

    this.registerDomEvent(doc, "keydown", (event) => {
      if (event.key === "Escape") this.hideSelectionBubble(doc);
    });

    // One delegated listener per window for every Reading View mask. Capture phase runs before Obsidian's
    // link handler, so a link inside a masked answer reveals it instead of navigating away.
    this.registerDomEvent(doc, "click", (event) => this.handleClozeClick(event), true);
  }

  handleClozeClick(event) {
    if (this.unloaded) return;
    const cloze = event.target?.closest?.(".crisp-recall-cloze");
    if (!cloze) return;
    if (cloze.classList.contains("is-revealed") && event.target.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    cloze.classList.toggle("is-revealed");
    // The parts of one formula cloze, split around & or \\, reveal together.
    const group = cloze.dataset?.crispRecallGroup;
    if (group) {
      const revealed = cloze.classList.contains("is-revealed");
      cloze.closest(".crisp-recall-math")?.querySelectorAll(`[data-crisp-recall-group="${group}"]`)
        .forEach((part) => part.classList.toggle("is-revealed", revealed));
    }
  }

  detachSelectionDocument(doc) {
    if (!doc) return;
    this.cancelSelectionFrame(doc);
    this.selectionBubbleEls?.get(doc)?.remove();
    this.selectionBubbleEls?.delete(doc);
    this.pointerSelectingDocuments?.delete(doc);
    this.selectionDocuments?.delete(doc);
  }

  scheduleSelectionBubbleUpdate(doc) {
    if (this.unloaded || !doc) return;
    this.cancelSelectionFrame(doc);
    const win = doc.defaultView;
    if (!win?.requestAnimationFrame) return;
    const frameId = win.requestAnimationFrame(() => {
      this.selectionFrames?.delete(doc);
      if (!this.unloaded) this.updateSelectionBubble(doc);
    });
    this.selectionFrames.set(doc, { frameId, win });
  }

  cancelSelectionFrame(doc) {
    const pending = this.selectionFrames?.get(doc);
    if (!pending) return;
    pending.win?.cancelAnimationFrame?.(pending.frameId);
    this.selectionFrames.delete(doc);
  }

  cancelSelectionFrames() {
    if (!this.selectionFrames) return;
    for (const [doc] of this.selectionFrames) this.cancelSelectionFrame(doc);
  }

  ensureSelectionBubble(doc) {
    const existing = this.selectionBubbleEls?.get(doc);
    if (existing?.isConnected) return existing;
    if (!doc?.body) return null;

    const bubble = doc.createElement("div");
    bubble.className = "crisp-recall-selection-bubble";
    bubble.setAttribute("role", "toolbar");
    bubble.setAttribute("aria-label", "Crisp Recall 划词制卡");
    bubble.setAttribute("aria-hidden", "true");

    const addButton = (action, icon, label, title) => {
      const button = doc.createElement("button");
      button.className = "crisp-recall-bubble-btn";
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      const iconEl = doc.createElement("span");
      iconEl.className = "crisp-recall-bubble-icon";
      iconEl.textContent = icon;
      const labelEl = doc.createElement("span");
      labelEl.textContent = label;
      button.append(iconEl, labelEl);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.handleSelectionAction(action);
      });
      bubble.append(button);
    };
    const addDivider = () => {
      const divider = doc.createElement("div");
      divider.className = "crisp-recall-bubble-divider";
      divider.setAttribute("aria-hidden", "true");
      bubble.append(divider);
    };

    addButton("cloze", "⚡", "挖空", "制作挖空 (Cloze ==文本==)");
    addDivider();
    addButton("qa", "🗂️", "问答", "制作问答卡 (问题 :: 答案)");
    addDivider();
    addButton("bidirectional", "🔄", "双向", "制作双向卡 (正面 ::: 背面)");

    doc.body.appendChild(bubble);
    this.selectionBubbleEls?.set(doc, bubble);
    return bubble;
  }

  getActiveEditor(doc = null) {
    const activeLeaf = this.app.workspace?.activeLeaf;
    if (!activeLeaf || activeLeaf.view?.getViewType?.() !== "markdown") return null;
    if (doc && activeLeaf.view.containerEl?.ownerDocument !== doc) return null;
    return activeLeaf.view.editor || null;
  }

  handleSelectionAction(action, directEditor = null) {
    if (this.unloaded || !this.ensureLicenseActivated()) {
      this.hideSelectionBubble();
      return;
    }
    const editor = directEditor || this.getActiveEditor();
    if (!editor) {
      this.hideSelectionBubble();
      return;
    }
    const selection = editor.getSelection?.();
    if (!selection) {
      this.hideSelectionBubble();
      return;
    }

    if (action === "cloze") {
      editor.replaceSelection(formatClozeSelection(selection));
    } else if (action === "qa") {
      editor.replaceSelection(`${selection} :: `);
    } else if (action === "bidirectional") {
      editor.replaceSelection(`${selection} ::: `);
    }

    this.hideSelectionBubble();
    editor.focus?.();
  }

  updateSelectionBubble(doc = null) {
    if (this.unloaded) return;
    const activeLeaf = this.app.workspace?.activeLeaf;
    const view = activeLeaf?.view;
    const activeDocument = view?.containerEl?.ownerDocument
      || (typeof document !== "undefined" ? document : null);
    doc = doc || activeDocument;
    if (!doc || this.pointerSelectingDocuments?.has(doc)) return;
    if (!this.settings?.enableSelectionBubble) {
      this.hideSelectionBubble(doc);
      return;
    }
    if (!this.licenseState?.valid) {
      this.hideSelectionBubble(doc);
      return;
    }

    if (!activeLeaf || view?.getViewType?.() !== "markdown" || activeDocument !== doc) {
      this.hideSelectionBubble(doc);
      return;
    }

    const mode = view.getMode?.() || view.currentMode?.type;
    if (mode === "preview") {
      this.hideSelectionBubble(doc);
      return;
    }

    const editor = view.editor;
    if (!editor) {
      this.hideSelectionBubble(doc);
      return;
    }

    const selectedText = editor.getSelection?.();
    if (!selectedText || selectedText.trim().length === 0) {
      this.hideSelectionBubble(doc);
      return;
    }

    const win = doc.defaultView;
    if (!win || typeof win.getSelection !== "function") {
      this.hideSelectionBubble(doc);
      return;
    }

    const domSelection = win.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
      this.hideSelectionBubble(doc);
      return;
    }

    const range = domSelection.getRangeAt(0);
    const commonNode = range.commonAncestorContainer;
    const commonElement = commonNode?.nodeType === 1 ? commonNode : commonNode?.parentElement;
    if (
      !commonElement
      || !view.containerEl?.contains?.(commonElement)
      || !commonElement.closest?.(".cm-editor")
    ) {
      this.hideSelectionBubble(doc);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideSelectionBubble(doc);
      return;
    }

    this.hideSelectionBubble();
    const bubble = this.ensureSelectionBubble(doc);
    if (!bubble) return;

    const bubbleWidth = bubble.offsetWidth || 190;
    const bubbleHeight = bubble.offsetHeight || 32;

    let top = rect.top - 6;
    let placeBelow = false;
    if (rect.top - bubbleHeight - 6 < 10) {
      top = rect.bottom + 6;
      placeBelow = true;
    }

    let left = rect.left + rect.width / 2;
    const minLeft = bubbleWidth / 2 + 12;
    const maxLeft = (win.innerWidth || 1000) - bubbleWidth / 2 - 12;
    left = Math.max(minLeft, Math.min(maxLeft, left));

    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.transform = placeBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)";
    bubble.setAttribute("aria-hidden", "false");
    bubble.classList.add("is-visible");
  }

  hideSelectionBubble(doc = null) {
    const bubbles = doc
      ? [this.selectionBubbleEls?.get(doc)].filter(Boolean)
      : Array.from(this.selectionBubbleEls?.values?.() || []);
    for (const bubble of bubbles) {
      bubble.classList.remove("is-visible");
      bubble.setAttribute?.("aria-hidden", "true");
    }
  }

  getPluginDocuments() {
    const documents = new Set(this.selectionDocuments || []);
    if (typeof document !== "undefined") documents.add(document);
    this.app?.workspace?.iterateAllLeaves?.((leaf) => {
      const doc = leaf.view?.containerEl?.ownerDocument;
      if (doc) documents.add(doc);
    });
    return documents;
  }

  cleanupInjectedUi() {
    for (const doc of this.getPluginDocuments()) {
      doc.querySelectorAll(".crisp-recall-selection-bubble").forEach((bubble) => bubble.remove());
      doc.querySelectorAll(".crisp-recall-floating-pill").forEach((pill) => pill.remove());

      // Paragraphs split into several cards are restored whole, which also removes their card lines.
      doc.querySelectorAll(".crisp-recall-card-lines").forEach((paragraph) => {
        const originalHtml = paragraph.dataset.crispRecallOriginalHtml;
        if (originalHtml !== undefined) paragraph.innerHTML = originalHtml;
        delete paragraph.dataset.crispRecallOriginalHtml;
        paragraph.classList.remove("crisp-recall-card-lines");
      });

      doc.querySelectorAll(".crisp-recall-card-line").forEach((cardLine) => {
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

      doc.querySelectorAll(".crisp-recall-math").forEach(restoreRecallMath);

      doc.querySelectorAll(".crisp-recall-cloze").forEach((cloze) => {
        cloze.classList.remove("crisp-recall-cloze", "is-revealed");
        if (cloze.title === "单击遮罩 / 翻转揭晓") cloze.removeAttribute("title");
      });
    }
    this.selectionBubbleEls?.clear();
  }

  applyCustomColor() {
    for (const doc of this.getPluginDocuments()) {
      this.applyCustomColorToDocument(doc);
    }
  }

  applyCustomColorToDocument(doc) {
    if (!doc?.documentElement?.style) return;
    const color = typeof this.settings.clozeColor === "string"
      ? this.settings.clozeColor.trim()
      : "";
    if (color) {
      doc.documentElement.style.setProperty("--crisp-recall-cloze-color", color);
    } else {
      doc.documentElement.style.removeProperty("--crisp-recall-cloze-color");
    }
  }

  removeCustomColor() {
    for (const doc of this.getPluginDocuments()) {
      if (doc?.documentElement?.style) {
        doc.documentElement.style.removeProperty("--crisp-recall-cloze-color");
      }
    }
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

  async refreshLicenseState(options = {}) {
    let targetCode = this.settings.licenseCode;
    if (!targetCode) {
      const discovered = await discoverVaultCrispLicense(this.app);
      if (discovered) {
        targetCode = discovered;
        this.settings.licenseCode = targetCode;
        await this.saveSettings();
      }
    }

    if (!targetCode) {
      this.licenseState = { valid: false, payload: null, reason: "尚未输入 Crisp 授权码" };
      return this.licenseState;
    }
    const result = await verifyCrispRecallLicense(targetCode, options);
    this.licenseState = result.valid
      ? { valid: true, payload: result.payload, reason: null }
      : { valid: false, payload: null, reason: result.reason || "授权码无效" };
    return this.licenseState;
  }

  async activateLicense(licenseCode) {
    this.settings.licenseCode = typeof licenseCode === "string" ? licenseCode.trim() : "";
    const state = await this.refreshLicenseState({ online: true });
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
    // Card settings change the count even when the note itself did not change.
    return this.updateActiveLeafFloatingWidget(null, { forceAll: true });
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
      });
    }

    // Double colon lines transformation in Reading Mode
    if (this.settings.enableDoubleColon) {
      const paragraphs = element.querySelectorAll("p, li");
      paragraphs.forEach((el) => {
        if (el.classList?.contains?.("crisp-recall-card-lines")) return;
        if (el.querySelector("br")) this.renderSoftBreakCardLines(el);
        else this.renderCardLine(el);
      });
    }

    this.renderMathCards(element, context);

    // Floating Pill Widget at bottom-right of preview view
    if (this.settings.enableFloatingPill) {
      if (this.app.workspace?.getLeavesOfType) {
        this.updateActiveLeafFloatingWidget();
      } else {
        const previewView = element.closest(".markdown-preview-view");
        const floatingHost = previewView?.closest(".workspace-leaf-content") || previewView;
        if (floatingHost) this.injectFloatingWidget(floatingHost, context.sourcePath);
      }
    }
  }

  // Turns one rendered "prompt :: answer" line into a card with a masked answer. Returns false when the
  // line is not a card or must be left as written.
  renderCardLine(el) {
    const text = el.textContent || "";
    const alreadyProcessed = el.classList?.contains?.("crisp-recall-card-line");
    const containsCode = el.querySelector("code, pre");
    const containsNestedList = el.querySelector("ul, ol");
    const containsAnnotation = el.querySelector(".crisp-ann")
      || el.querySelector(".crisp-ann__target")
      || maskCrispAnnotationDirectives(text) !== text;
    if (alreadyProcessed || containsCode || containsNestedList || containsAnnotation) return false;
    const { searchable } = renderedCardText([el]);
    const card = parseDoubleColonLine(text, { searchable });
    if (!card) return false;
    const { prompt, answer } = card;

    el.dataset.crispRecallOriginalHtml = el.innerHTML;
    const parts = extractCardLineParts(el, searchable);
    if (!parts) el.empty();
    el.addClass("crisp-recall-card-line");

    const promptSpan = el.createSpan("crisp-recall-card-line__prompt");
    const dividerSpan = el.createSpan("crisp-recall-card-line__divider");
    dividerSpan.textContent = "::";
    const answerSpan = el.createSpan("crisp-recall-cloze crisp-recall-card-line__answer");
    answerSpan.title = "单击遮罩 / 翻转揭晓";

    if (parts) {
      promptSpan.append(parts.prompt);
      answerSpan.append(parts.answer);
      trimEdgeWhitespace(promptSpan);
      trimEdgeWhitespace(answerSpan);
      // The whole line is one card, so highlights inside it are not separate masks.
      el.querySelectorAll("mark.crisp-recall-cloze").forEach((mark) => {
        mark.classList.remove("crisp-recall-cloze", "is-revealed");
        mark.removeAttribute("title");
      });
    } else {
      promptSpan.textContent = prompt;
      answerSpan.textContent = answer;
    }
    return true;
  }

  // Formulas: a math block that answers the "Question ::" line above it is masked whole, and each
  // ==target== written inside a formula is typeset as its own mask.
  renderMathCards(element, context) {
    const blocks = Array.from(element.querySelectorAll(".math-block"));
    const answerFlags = mathBlockAnswerFlags(context?.getSectionInfo?.(element));
    const useFlags = answerFlags?.length === blocks.length;
    element.querySelectorAll(".math").forEach((mathEl) => {
      if (mathEl.classList.contains("crisp-recall-cloze") || mathEl.closest(".crisp-ann")) return;
      const isBlock = mathEl.classList.contains("math-block");
      const isAnswer = this.settings.enableDoubleColon && isBlock
        && (useFlags ? answerFlags[blocks.indexOf(mathEl)] : isSoftBreakMathAnswer(mathEl));
      if (mathEl.classList.contains("crisp-recall-math")) {
        // Callout content is rendered on its own before its section, which alone knows the source lines.
        if (!isAnswer) return;
        restoreRecallMath(mathEl);
      }
      if (isAnswer) {
        mathEl.classList.add("crisp-recall-math", "crisp-recall-cloze");
        mathEl.title = "单击遮罩 / 翻转揭晓";
      }
      const latex = mathEl.querySelector("mjx-math")?.getAttribute("data-latex") || "";
      if (findMathClozes(latex).length === 0) return;
      // A formula that is already one whole answer shows its markers as plain formula text.
      const insideAnswer = isAnswer || !!mathEl.closest(".crisp-recall-card-line__answer");
      if (!insideAnswer && !this.settings.enableCloze) return;
      const source = insideAnswer
        ? unwrapMathClozes(latex)
        // MathJax only keeps classes that start with "mjx-". Parts split around & or \\ share a group.
        : replaceMathClozes(latex, (target, group) => wrapMathClozeParts(
          target,
          (part) => `\\class{mjx-crisp-recall-cloze-${group}}{${part}}`,
        ));
      if (!this.typesetRecallMath(mathEl, source, isBlock)) return;
      mathEl.querySelectorAll("[class*='mjx-crisp-recall-cloze-']").forEach((mask) => {
        mask.classList.add("crisp-recall-cloze");
        mask.dataset.crispRecallGroup = mask.getAttribute("class").match(/mjx-crisp-recall-cloze-(\d+)/)?.[1] || "";
        mask.setAttribute("title", "单击遮罩 / 翻转揭晓");
      });
    });
  }

  typesetRecallMath(mathEl, source, display) {
    if (typeof renderMath !== "function") return false;
    let rendered;
    try {
      rendered = renderMath(source, display);
    } catch (error) {
      console.debug("Crisp Recall could not typeset a formula:", error);
      return false;
    }
    if (!rendered) return false;
    mathEl.dataset.crispRecallOriginalHtml = mathEl.innerHTML;
    mathEl.classList.add("crisp-recall-math");
    mathEl.replaceChildren(rendered);
    if (typeof finishRenderMath === "function") Promise.resolve(finishRenderMath()).catch(() => {});
    return true;
  }

  // Lines written without a blank line between them render as one paragraph joined by <br>. The review
  // parser reads them line by line, so each line becomes its own card here too. Lines that are not cards
  // stay untouched, and so does a paragraph whose <br> sits inside inline formatting. A list bullet or
  // checkbox goes into the first line's card, where it lines up as it does on a single-line card item.
  renderSoftBreakCardLines(el) {
    if (el.querySelector("ul, ol")) return;
    const nodes = Array.from(el.childNodes);
    if (nodes.some((node) => node.nodeName !== "BR" && node.querySelector?.("br"))) return;

    const lines = [[]];
    for (const node of nodes) {
      if (node.nodeName === "BR") lines.push([]);
      else lines[lines.length - 1].push(node);
    }

    const originalHtml = el.innerHTML;
    let changed = false;
    for (const line of lines) {
      const { text, searchable } = renderedCardText(line);
      if (!parseDoubleColonLine(text, { searchable })) continue;
      const wrapper = el.ownerDocument.createElement("span");
      el.insertBefore(wrapper, line[0]);
      wrapper.append(...line);
      if (this.renderCardLine(wrapper)) changed = true;
      else wrapper.replaceWith(...wrapper.childNodes);
    }
    if (!changed) return;
    el.dataset.crispRecallOriginalHtml = originalHtml;
    el.addClass("crisp-recall-card-lines");
  }

  async updateActiveLeafFloatingWidget(forceSourcePath = null, { forceAll = false } = {}) {
    if (this.unloaded || !this.settings.enableFloatingPill || !this.isLicenseValid()) {
      for (const doc of this.getPluginDocuments()) {
        doc.querySelectorAll(".crisp-recall-floating-pill").forEach((pill) => pill.remove());
      }
      return;
    }

    const leaves = this.app.workspace?.getLeavesOfType?.("markdown") || [];
    await Promise.all(leaves.map(async (leaf) => {
      const view = leaf.view;
      if (!view || !view.file) return;
      const container = view.containerEl;
      if (!container) return;

      const isPreview = view.getMode ? view.getMode() === "preview" : true;
      if (!isPreview) {
        container.querySelector(".crisp-recall-floating-pill")?.remove();
        return;
      }

      try {
        const sourcePath = view.file.path;
        await this.injectFloatingWidget(container, sourcePath, {
          force: forceAll || sourcePath === forceSourcePath,
        });
      } catch (err) {
        console.debug("Crisp Recall floating widget update error:", err);
      }
    }));
  }

  async injectFloatingWidget(container, sourcePath, { force = false } = {}) {
    if (this.unloaded || !this.isLicenseValid()) return;

    const existingPill = container.querySelector(".crisp-recall-floating-pill");
    if (!force && existingPill?.dataset.crispRecallSource === sourcePath) return;

    if (!this.floatingWidgetRequests) this.floatingWidgetRequests = new WeakMap();
    const pendingRequest = this.floatingWidgetRequests.get(container);
    if (!force && pendingRequest?.sourcePath === sourcePath) return;

    const requestToken = {};
    this.floatingWidgetRequests.set(container, { sourcePath, requestToken });
    if (existingPill?.dataset.crispRecallSource !== sourcePath) existingPill?.remove();

    try {
      const file = this.app.vault.getFileByPath(sourcePath);
      if (!file) {
        container.querySelector(".crisp-recall-floating-pill")?.remove();
        return;
      }

      const content = await this.app.vault.cachedRead(file);
      if (this.unloaded || !this.isLicenseValid()) return;
      if (this.floatingWidgetRequests.get(container)?.requestToken !== requestToken) return;

      const cards = parseFlashcardsFromText(content, sourcePath, this.settings);
      if (cards.length === 0) {
        container.querySelector(".crisp-recall-floating-pill")?.remove();
        return;
      }
      if (this.unloaded) return;

      container.querySelector(".crisp-recall-floating-pill")?.remove();
      const pill = container.createDiv("crisp-recall-floating-pill");
      pill.dataset.crispRecallSource = sourcePath;
      const badge = pill.createDiv("crisp-recall-pill-badge");
      badge.createSpan({ text: "⚡ Recall" });
      badge.createSpan({ cls: "crisp-recall-pill-count", text: `${cards.length}` });

      const today = recallDateKey();
      const dueCards = buildDueReviewQueue(cards, this.reviewStore, today, { newLimit: 0 });
      if (dueCards.length > 0) {
        const dueBtn = pill.createEl("button", {
          cls: "crisp-recall-pill-btn crisp-recall-pill-due",
          text: `到期 ${dueCards.length}`,
        });
        dueBtn.onclick = (event) => {
          event.stopPropagation();
          this.openReviewModal(dueCards, `${file.basename} · 到期复习`);
        };
      }

      const toggleBtn = pill.createEl("button", { cls: "crisp-recall-pill-btn", text: "👁️ 翻转全部" });
      toggleBtn.onclick = (event) => {
        event.stopPropagation();
        this.toggleAllMasks();
      };

      const reviewBtn = pill.createEl("button", {
        cls: "crisp-recall-pill-btn crisp-recall-pill-btn--cta",
        text: "开始抽认",
      });
      reviewBtn.onclick = (event) => {
        event.stopPropagation();
        this.openReviewModal(cards, file.basename);
      };
    } finally {
      if (this.floatingWidgetRequests.get(container)?.requestToken === requestToken) {
        this.floatingWidgetRequests.delete(container);
      }
    }
  }

  toggleAllMasks() {
    if (!this.ensureLicenseActivated()) return;
    const activeView = this.app.workspace.activeLeaf?.view;
    // Long notes only mount the sections near the viewport; the renderer keeps every section's element.
    const roots = [activeView?.containerEl];
    activeView?.previewMode?.renderer?.sections?.forEach((section) => roots.push(section?.el));
    const clozes = new Set();
    roots.forEach((root) => root?.querySelectorAll?.(".crisp-recall-cloze").forEach((c) => clozes.add(c)));
    if (clozes.size === 0) {
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
    if (this.unloaded || !this.ensureLicenseActivated()) return;
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("请先打开一篇包含闪卡的 Markdown 笔记。");
      return;
    }
    const content = await this.app.vault.read(activeFile);
    if (this.unloaded) return;
    const cards = parseFlashcardsFromText(content, activeFile.path, this.settings);
    if (cards.length === 0) {
      new Notice(`「${activeFile.basename}」中没有检测到 :: 问答或 ==挖空== 闪卡。`);
      return;
    }
    this.openReviewModal(cards, activeFile.basename);
  }

  async startVaultRandomReview() {
    if (this.unloaded || !this.ensureLicenseActivated()) return;
    const allCards = await this.scanVaultCards();
    if (!allCards) return;

    // Fisher-Yates shuffle avoids the bias of Array.sort(() => Math.random() - 0.5).
    for (let i = allCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allCards[i], allCards[j]] = [allCards[j], allCards[i]];
    }
    const shuffled = allCards.slice(0, 20);
    this.openReviewModal(shuffled, "全库随机抽认");
  }

  async startDueReview() {
    if (this.unloaded || !this.ensureLicenseActivated()) return;
    const allCards = await this.scanVaultCards();
    if (!allCards) return;

    const today = recallDateKey();
    const queue = buildDueReviewQueue(allCards, this.reviewStore, today, {
      newLimit: sanitizeNewCardsPerDay(this.settings?.newCardsPerDay ?? DEFAULT_SETTINGS.newCardsPerDay),
    });
    if (queue.length === 0) {
      const tomorrow = recallAddDays(today, 1);
      const dueTomorrow = allCards.filter((card) => this.reviewStore?.get(card.filePath, card.key)?.due === tomorrow).length;
      new Notice(dueTomorrow > 0
        ? `今天没有到期的卡片，明天有 ${dueTomorrow} 张。`
        : "今天没有到期的卡片。");
      return;
    }
    this.openReviewModal(queue, "今日到期复习");
  }

  /** Every card in the vault, or null after the plugin unloads or when the vault has none. */
  async scanVaultCards() {
    const files = this.app.vault.getMarkdownFiles();
    const allCards = [];
    new Notice("⚡ 正在从全库扫描自测闪卡...");

    let failedReads = 0;
    const batchSize = 25;
    for (let offset = 0; offset < files.length; offset += batchSize) {
      if (this.unloaded) return null;
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

    if (this.unloaded) return null;

    if (allCards.length === 0) {
      new Notice("全库中暂未找到任何自测闪卡，快去笔记中用「::」或「==挖空==」试试吧！");
      return null;
    }

    if (failedReads > 0) {
      new Notice(`有 ${failedReads} 篇笔记读取失败，已跳过并继续抽认。`);
    }
    return allCards;
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
          this.plugin.refreshReadingViews();
        })
      );

    const COLOR_PRESETS = [
      { id: "default", name: "跟随主题强调色 (默认)", value: "" },
      { id: "amber", name: "琥珀金黄 (Amber)", value: "#f59e0b" },
      { id: "orange", name: "活力鲜橙 (Orange)", value: "#f97316" },
      { id: "green", name: "清新薄荷绿 (Green)", value: "#10b981" },
      { id: "blue", name: "湖水蔚蓝 (Blue)", value: "#3b82f6" },
      { id: "purple", name: "优雅紫罗兰 (Purple)", value: "#8b5cf6" },
      { id: "red", name: "珊瑚朱红 (Red)", value: "#ef4444" },
      { id: "custom", name: "自定义拾色器 (Custom)", value: "custom" },
    ];

    const currentClozeColor = (this.plugin.settings.clozeColor || "").toLowerCase();
    let currentPreset = COLOR_PRESETS.find((p) => p.value && p.value.toLowerCase() === currentClozeColor);
    if (!currentPreset && currentClozeColor) {
      currentPreset = COLOR_PRESETS.find((p) => p.id === "custom");
    }
    const selectedPresetId = currentPreset ? currentPreset.id : "default";

    const getThemeAccentHex = () => {
      try {
        const doc = this.app?.workspace?.containerEl?.ownerDocument
          || (typeof document !== "undefined" ? document : null);
        if (!doc) return "#6b84bf";
        const raw = getComputedStyle(doc.body).getPropertyValue("--interactive-accent").trim();
        return normalizeHexColor(raw, "#6b84bf");
      } catch (e) {
        return "#6b84bf";
      }
    };

    const colorSetting = new Setting(containerEl)
      .setName("挖空自测高亮颜色 (Cloze Mask Color)")
      .setDesc(
        currentClozeColor
          ? `当前已指定独立颜色：${currentClozeColor}。可在下拉选择预设、或用拾色器微调。`
          : "当前跟随 Obsidian 全局主题强调色。指定独立颜色后将仅应用于自测挖空与翻转卡片。"
      );

    colorSetting.addDropdown((dropdown) => {
      COLOR_PRESETS.forEach((p) => dropdown.addOption(p.id, p.name));
      dropdown.setValue(selectedPresetId).onChange(async (newId) => {
        if (newId === "default") {
          this.plugin.settings.clozeColor = "";
        } else if (newId === "custom") {
          if (!this.plugin.settings.clozeColor) {
            this.plugin.settings.clozeColor = getThemeAccentHex();
          }
        } else {
          const found = COLOR_PRESETS.find((p) => p.id === newId);
          if (found) this.plugin.settings.clozeColor = found.value;
        }
        await this.plugin.saveSettings();
        this.plugin.applyCustomColor();
        this.display();
      });
    });

    colorSetting.addColorPicker((picker) => {
      picker
        .setValue(normalizeHexColor(currentClozeColor || getThemeAccentHex()))
        .onChange(async (val) => {
          this.plugin.settings.clozeColor = val;
          await this.plugin.saveSettings();
          this.plugin.applyCustomColor();
          this.display();
        });
    });

    colorSetting.addExtraButton((btn) => {
      btn
        .setIcon("reset")
        .setTooltip("重置为跟随主题强调色")
        .onClick(async () => {
          this.plugin.settings.clozeColor = "";
          await this.plugin.saveSettings();
          this.plugin.applyCustomColor();
          this.display();
        });
    });

    new Setting(containerEl)
      .setName("启用双冒号概念卡 (Concept :: Definition)")
      .setDesc("识别「概念 :: 定义」或「问题 :: 答案」语法，并在阅读模式下自动遮罩答案。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableDoubleColon).onChange(async (v) => {
          this.plugin.settings.enableDoubleColon = v;
          await this.plugin.saveSettings();
          this.plugin.refreshReadingViews();
        })
      );

    new Setting(containerEl)
      .setName("显示右下角自测浮动药丸 (Floating Recall Controller)")
      .setDesc("在有闪卡的笔记右下角显示轻量控制胶囊，方便一键翻转或开启 3D 抽认。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableFloatingPill).onChange(async (v) => {
          this.plugin.settings.enableFloatingPill = v;
          await this.plugin.saveSettings();
          await this.plugin.updateActiveLeafFloatingWidget();
        })
      );

    new Setting(containerEl)
      .setName("每日新卡上限 (New cards per day)")
      .setDesc("「今日到期复习」每天最多引入多少张从未复习过的卡片。0 表示只复习已排期的卡片；在当前笔记或全库随机里练过的新卡也计入当天额度。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text
          .setValue(String(this.plugin.settings.newCardsPerDay))
          .onChange(async (value) => {
            if (!/^\d+$/.test(value.trim())) return;
            this.plugin.settings.newCardsPerDay = sanitizeNewCardsPerDay(Number(value.trim()));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("启用划词制卡悬浮气泡 (Selection Floating Toolbar)")
      .setDesc("在编辑模式选中文本时，自动在选区上方浮现制卡微胶囊。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableSelectionBubble).onChange(async (v) => {
          this.plugin.settings.enableSelectionBubble = v;
          if (!v) this.plugin.hideSelectionBubble();
          await this.plugin.saveSettings();
        })
      );

    renderRecallAboutCard(containerEl);
  }
}

module.exports = CrispRecallPlugin;
