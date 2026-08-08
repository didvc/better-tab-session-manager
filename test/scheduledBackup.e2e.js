// E2E: loads the real unpacked extension in Chromium and exercises the
// scheduled-backup feature end to end (settings UI -> chrome.alarms -> downloaded file).
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO = path.resolve(__dirname, "..");
const EXT = path.join(REPO, "dev/chrome");

let pass = 0,
  fail = 0;
const eq = (a, e, label) => {
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${label}`);
  if (!ok) console.log(`         expected: ${e}\n         actual:   ${a}`);
};
const ok_ = (cond, label) => eq(!!cond, true, label);

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsm-e2e-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsm-dl-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    acceptDownloads: true
  });

  // --- resolve the extension's service worker -----------------------------
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  console.log(`\nextension id: ${extId}\nservice worker: ${sw.url()}\n`);
  ok_(extId, "extension loaded with a service worker (MV3)");

  // Route downloads to a temp dir so nothing lands in the real ~/Downloads.
  // CDP rewrites the saved name to a GUID, and the extension calls downloads.erase()
  // on backups, so to see the path the extension actually requests we spy on
  // chrome.downloads.download inside the worker instead.
  const cdp = await context.newCDPSession(await context.newPage());
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // (re)install the spy — the service worker can be torn down between phases
  const installDownloadSpy = () =>
    sw.evaluate(() => {
      if (!globalThis.__dlCalls) {
        globalThis.__dlCalls = [];
        const orig = chrome.downloads.download.bind(chrome.downloads);
        chrome.downloads.download = opts => {
          globalThis.__dlCalls.push(opts.filename);
          return orig(opts);
        };
      }
      globalThis.__dlCalls.length = 0;
    });
  const downloadCalls = () => sw.evaluate(() => globalThis.__dlCalls || []);
  const getSettings = () =>
    sw.evaluate(async () => (await chrome.storage.local.get("Settings")).Settings);
  const setSetting = (id, value) =>
    sw.evaluate(
      async ([id, value]) => {
        const s = (await chrome.storage.local.get("Settings")).Settings || {};
        s[id] = value;
        await chrome.storage.local.set({ Settings: s });
      },
      [id, value]
    );
  const getAlarms = () => sw.evaluate(() => chrome.alarms.getAll());

  // --- 1. defaults --------------------------------------------------------
  console.log("defaults on fresh install");
  await sleep(2500);
  let s = await getSettings();
  eq(s.ifBackup, true, "ifBackup defaults to true");
  eq(s.ifScheduledBackup, true, "ifScheduledBackup defaults to true");
  eq(s.scheduledBackupFrequency, "daily", "frequency defaults to daily");
  eq(s.scheduledBackupTime, "06:00", "time defaults to 06:00");
  eq(s.individualBackup, true, "individualBackup (incremental) defaults to true");
  eq(s.shouldRunMissedBackup, true, "missed-backup catch-up defaults to true");
  eq(s.ifBackupOnStartup, true, "startup backup still defaults to true");

  // --- 2. alarm actually scheduled ---------------------------------------
  console.log("\nchrome.alarms registration");
  let alarms = await getAlarms();
  const sched = alarms.find(a => a.name === "scheduledBackup");
  ok_(sched, "scheduledBackup alarm exists");
  if (sched) {
    const d = new Date(sched.scheduledTime);
    eq(d.getHours(), 6, "scheduled for 06:00 local — hour");
    eq(d.getMinutes(), 0, "scheduled for 06:00 local — minute");
    ok_(sched.scheduledTime > Date.now(), "scheduled in the future");
    eq(sched.periodInMinutes, undefined, "one-shot alarm (re-armed after each fire)");
    console.log(`         next run: ${d.toString()}`);
  }

  // --- 3. options UI renders the new controls -----------------------------
  console.log("\noptions UI");
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options/index.html#settings`);
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  for (const id of [
    "ifBackup",
    "ifScheduledBackup",
    "scheduledBackupFrequency",
    "scheduledBackupTime",
    "scheduledBackupDayOfWeek",
    "shouldRunMissedBackup",
    "ifBackupOnStartup"
  ]) {
    ok_(await page.locator(`#${id}`).count(), `control #${id} rendered`);
  }

  eq(await page.locator("#scheduledBackupTime").inputValue(), "06:00", "time input shows 06:00");
  eq(
    await page.locator("#scheduledBackupTime").getAttribute("type"),
    "time",
    "time input is a native <input type=time>"
  );
  eq(
    await page.locator("#scheduledBackupFrequency").inputValue(),
    "daily",
    "frequency select shows daily"
  );
  const freqOpts = await page.locator("#scheduledBackupFrequency option").allTextContents();
  eq(freqOpts.join("|"), "Every hour|Every day|Every week", "frequency options are localized");
  const dowOpts = await page.locator("#scheduledBackupDayOfWeek option").allTextContents();
  eq(dowOpts.length, 7, "day-of-week has 7 localized options");
  ok_(
    !(await page.locator("#ifScheduledBackup").locator("..").innerText()).includes("__MSG"),
    "no missing i18n placeholders"
  );

  // label text sanity (proves messages.json keys resolve)
  const bodyText = await page.locator("body").innerText();
  ok_(bodyText.includes("Back up on a schedule"), 'label "Back up on a schedule" visible');
  ok_(bodyText.includes("Run missed backups on startup"), "label for catch-up visible");

  // --- 4. changing the time through the UI re-arms the alarm --------------
  console.log("\nchanging schedule via the UI re-arms the alarm");
  await page.locator("#scheduledBackupTime").fill("23:45");
  await page.locator("#scheduledBackupTime").dispatchEvent("change");
  await sleep(1500);
  s = await getSettings();
  eq(s.scheduledBackupTime, "23:45", "setting persisted from UI");
  alarms = await getAlarms();
  const resched = alarms.find(a => a.name === "scheduledBackup");
  ok_(resched, "alarm still present after change");
  if (resched) {
    const d = new Date(resched.scheduledTime);
    eq(d.getHours(), 23, "alarm re-armed to 23:xx");
    eq(d.getMinutes(), 45, "alarm re-armed to xx:45");
    console.log(`         next run: ${d.toString()}`);
  }

  // weekly
  await page.selectOption("#scheduledBackupFrequency", "weekly");
  await page.selectOption("#scheduledBackupDayOfWeek", "3"); // Wednesday
  await sleep(1500);
  alarms = await getAlarms();
  const weekly = alarms.find(a => a.name === "scheduledBackup");
  if (weekly) {
    const d = new Date(weekly.scheduledTime);
    eq(d.getDay(), 3, "weekly alarm lands on Wednesday");
    console.log(`         next run: ${d.toString()}`);
  }

  // the real checkbox is visually hidden behind a styled span, so click the span
  const setChecked = async (id, want) => {
    const input = page.locator(`#${id}`);
    if ((await input.isChecked()) === want) return;
    await input.locator("xpath=following-sibling::span[1]").click();
    await sleep(300);
    eq(await input.isChecked(), want, `  #${id} is now ${want ? "checked" : "unchecked"}`);
  };

  // --- 5. disabling clears the alarm --------------------------------------
  console.log("\ndisable / re-enable");
  await setChecked("ifScheduledBackup", false);
  await sleep(1500);
  alarms = await getAlarms();
  eq(
    alarms.find(a => a.name === "scheduledBackup"),
    undefined,
    "unchecking removes the alarm"
  );

  await setChecked("ifScheduledBackup", true);
  await sleep(1500);
  alarms = await getAlarms();
  ok_(
    alarms.find(a => a.name === "scheduledBackup"),
    "re-checking restores the alarm"
  );

  // master toggle wins
  await setChecked("ifBackup", false);
  await sleep(1500);
  alarms = await getAlarms();
  eq(
    alarms.find(a => a.name === "scheduledBackup"),
    undefined,
    "master ifBackup off clears the alarm"
  );
  await setChecked("ifBackup", true);
  await sleep(1500);
  ok_(
    (await getAlarms()).find(a => a.name === "scheduledBackup"),
    "master back on restores it"
  );

  // --- 6. the scheduled run actually writes files -------------------------
  console.log("\nfiring the schedule for real (saves a session, then fires the alarm)");
  await setSetting("scheduledBackupFrequency", "daily");
  await setSetting("scheduledBackupTime", "06:00");
  await setSetting("backupFolder", "TSM-E2E");
  await sleep(800);

  // create a session to back up
  const extra = await context.newPage();
  await extra.goto("data:text/html,<title>E2E Tab</title><h1>e2e</h1>");
  await sleep(500);
  // messages must come from an extension page: a service worker does not receive its own sendMessage
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      message: "saveCurrentSession",
      name: "e2e-session",
      property: "saveAllWindows"
    })
  );
  await sleep(2500);
  const sessionCount = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({
      message: "getSessions",
      needKeys: ["id", "name"]
    });
    return Array.isArray(r) ? r.length : 0;
  });
  ok_(sessionCount > 0, `at least one session exists to back up (${sessionCount})`);

  // fire the alarm handler the same way chrome.alarms would
  const before = countFiles(downloadDir);
  await installDownloadSpy();
  await sw.evaluate(() => chrome.alarms.create("scheduledBackup", { when: Date.now() + 500 }));
  await sleep(6000);
  const after = countFiles(downloadDir);
  let dl = await downloadCalls();
  ok_(after > before, `scheduled run wrote file(s) to disk (${before} -> ${after})`);
  console.log("         requested: " + (dl.join(", ") || "(none)"));
  ok_(dl.length > 0, `scheduled run triggered ${dl.length} download(s)`);
  ok_(
    dl.some(f => f.endsWith(".json")),
    "backup output is .json"
  );
  ok_(
    dl.some(f => f.includes("TSM-E2E")),
    "backup written into the configured folder (TSM-E2E)"
  );
  ok_(
    dl.some(f => f.includes("e2e-session")),
    "backup filename carries the session name"
  );
  ok_(!dl.some(f => f.includes("temp")), "temp sessions are excluded from backups");

  // alarm was re-armed after firing
  await sleep(500);
  const rearmed = (await getAlarms()).find(a => a.name === "scheduledBackup");
  ok_(rearmed, "alarm re-armed itself after firing");
  if (rearmed) {
    const d = new Date(rearmed.scheduledTime);
    eq(d.getHours(), 6, "re-armed back to 06:00");
    console.log(`         next run: ${d.toString()}`);
  }
  s = await getSettings();
  ok_(typeof s.lastScheduledBackupTime === "number", "lastScheduledBackupTime recorded");

  // --- 7. incremental behaviour -------------------------------------------
  console.log("\nincremental: a second run with no changes exports nothing");
  await installDownloadSpy();
  await sw.evaluate(() => chrome.alarms.create("scheduledBackup", { when: Date.now() + 500 }));
  await sleep(6000);
  dl = await downloadCalls();
  eq(dl.length, 0, `unchanged sessions are skipped (0 downloads)`);

  console.log("\nincremental: after editing a session it IS re-exported");
  await page.evaluate(async () => {
    const all = await chrome.runtime.sendMessage({
      message: "getSessions",
      needKeys: ["id", "name"]
    });
    const target = (Array.isArray(all) ? all : [all])[0];
    await chrome.runtime.sendMessage({ message: "rename", id: target.id, name: "e2e-renamed" });
  });
  await sleep(1500);
  await installDownloadSpy();
  await sw.evaluate(() => chrome.alarms.create("scheduledBackup", { when: Date.now() + 500 }));
  await sleep(6000);
  dl = await downloadCalls();
  ok_(dl.length > 0, `changed session was re-exported (${dl.length} download)`);
  ok_(
    dl.some(f => f.includes("e2e-renamed")),
    "re-export picked up the new session name"
  );
  console.log("         requested: " + (dl.join(", ") || "(none)"));

  await page
    .screenshot({ path: path.join(REPO, "docs/e2e-scheduled-backup.png"), fullPage: false })
    .catch(() => {});

  await context.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`download dir: ${downloadDir}`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error("E2E ERROR:", e);
  process.exit(1);
});

function listFiles(dir) {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith(".crdownload")) out.push(path.relative(dir, p));
    }
  };
  try {
    walk(dir);
  } catch {}
  return out;
}
function countFiles(dir) {
  return listFiles(dir).length;
}
