// 授权继承回归：库内有多张 Crisp 授权时，必须采用第一张“本地校验通过”的，
// 而不是第一张看起来像授权码的。全部用本地生成的临时密钥，不接触真实卡密，也不联网。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { generateKeyPairSync, sign, webcrypto } = require("node:crypto");

const PLUGIN_ID = "crisp-recall";
const pair = generateKeyPairSync("ed25519");
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();

function code(features, extra = {}) {
  const payload = Buffer.from(JSON.stringify({
    product: "Crisp Suite", licenseId: "LOCAL-TEST", userName: "local", expiresAt: "2999-01-01T00:00:00.000Z", features, ...extra,
  })).toString("base64url");
  return `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString("base64url")}`;
}
const forged = (features) => `${code(features).split(".")[0]}.${Buffer.alloc(64).toString("base64url")}`;

function load() {
  const mainPath = path.join(__dirname, "..", "main.js");
  const original = fs.readFileSync(mainPath, "utf8");
  const PEM_RE = /`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`/;
  assert.ok(PEM_RE.test(original), "main.js 应内置一把公钥");
  const source = `${original.replace(PEM_RE, "`" + pem + "`")}\nglobalThis.__t = { discoverVaultCrispLicense, verifyCrispRecallLicense };`;
  const module = { exports: {} };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const obsidian = new Proxy({
    requestUrl: async () => { throw new Error("no network in tests"); },
    addIcon() {}, setIcon() {}, Platform: {},
  }, { get: (target, key) => (key in target ? target[key] : class {}) });
  const sandbox = {
    module, exports: module.exports, console: quiet, atob, btoa, crypto: webcrypto, TextDecoder, TextEncoder, Buffer,
    setTimeout, clearTimeout, structuredClone,
    require: (name) => (name === "obsidian" ? obsidian : require(name)),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: mainPath });
  return { ...sandbox.__t, PluginClass: module.exports };
}

// 真实目录结构的临时库：entries 为 [插件目录名, data.json 内容或原始字符串]。
function makeVault(t, entries, loaded = {}) {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "crisp-inherit-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  for (const [dir, data] of entries) {
    const pluginDir = path.join(basePath, ".obsidian", "plugins", dir);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "data.json"), typeof data === "string" ? data : JSON.stringify(data));
  }
  const plugins = Object.fromEntries(Object.entries(loaded).map(([id, licenseCode]) => [id, { settings: { licenseCode } }]));
  return {
    appId: "local-fixture",
    vault: { adapter: { basePath }, configDir: ".obsidian" },
    plugins: { plugins },
    workspace: { getLeavesOfType: () => [] },
  };
}

const lib = load();

function makePlugin(app) {
  const plugin = new lib.PluginClass();
  plugin.app = app;
  plugin.settings = { licenseCode: "" };
  plugin.saved = [];
  plugin.saveData = async (data) => { plugin.saved.push(JSON.parse(JSON.stringify(data))); };
  return plugin;
}

test("继承跳过伪造签名的码，采用后面的有效码", async (t) => {
  const good = code(["crisp-focus"]); // Recall 接受任意已签名的 Crisp 授权（既定策略）
  const app = makeVault(t, [["crisp-annotations", { licenseCode: forged(["all"]) }], ["crisp-reading-rail", { licenseCode: good }]]);
  assert.equal(await lib.discoverVaultCrispLicense(app), good);
});

test("继承跳过已过期的码，损坏的 data.json 不中断扫描", async (t) => {
  const good = code(["all"]);
  const app = makeVault(t, [
    ["crisp-a", { licenseCode: code(["all"], { expiresAt: "2001-01-01T00:00:00.000Z" }) }],
    ["crisp-b", "{ this is not json"],
    ["crisp-c", { licenseCode: good }],
  ]);
  assert.equal(await lib.discoverVaultCrispLicense(app), good);
});

test("只有无效候选时不写入设置、不保存，下次仍会重新扫描", async (t) => {
  const app = makeVault(t, [["crisp-a", { licenseCode: forged(["all"]) }]]);
  const plugin = makePlugin(app);
  const state = await plugin.refreshLicenseState({ online: false });
  assert.equal(state.valid, false);
  assert.equal(plugin.settings.licenseCode, "", "无效的继承码不得被固化进设置");
  assert.equal(plugin.saved.length, 0);

  // 之后库里出现了可用码：因为没有固化坏码，这次能继承成功。
  const good = code(["all"]);
  const dir = path.join(app.vault.adapter.basePath, ".obsidian", "plugins", "crisp-z");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({ licenseCode: good }));
  const next = await plugin.refreshLicenseState({ online: false });
  assert.equal(next.valid, true, next.reason);
  assert.equal(plugin.settings.licenseCode, good);
  assert.equal(plugin.saved.length, 1);
  assert.equal(plugin.saved[0].licenseCode, good);
});

test("不扫描自己的 data.json", async (t) => {
  const app = makeVault(t, [[PLUGIN_ID, { licenseCode: code(["all"]) }]]);
  assert.equal(await lib.discoverVaultCrispLicense(app), null);
});
