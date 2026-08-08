// Captures README screenshots of the scheduled-backup UI from the real extension.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO = path.resolve(__dirname, "..");
const EXT = path.join(REPO, "dev/chrome");
const OUT = path.join(REPO, "docs/screenshots");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsm-shot-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsm-shotdl-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const cdp = await context.newCDPSession(await context.newPage());
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  });

  const set = async obj =>
    sw.evaluate(async o => {
      const s = (await chrome.storage.local.get("Settings")).Settings || {};
      Object.assign(s, o);
      await chrome.storage.local.set({ Settings: s });
    }, obj);

  await sleep(2500);

  const page = await context.newPage();
  const openSettings = async () => {
    await page.goto(`chrome-extension://${extId}/options/index.html#settings`);
    await page.waitForLoadState("domcontentloaded");
    await sleep(1800);
  };

  // The Backup category <li>, located by the heading text.
  const backupCard = () =>
    page.locator("li.categoryContainer").filter({ hasText: "Back up on a schedule" }).first();

  const shoot = async (name, locator) => {
    const target = locator || page;
    await target.screenshot({ path: path.join(OUT, name) });
    console.log("wrote", name);
  };

  // ---- 1. daily @ 06:00, the default -------------------------------------
  await set({
    theme: "light",
    ifBackup: true,
    ifScheduledBackup: true,
    scheduledBackupFrequency: "daily",
    scheduledBackupTime: "06:00"
  });
  await openSettings();
  await backupCard().scrollIntoViewIfNeeded();
  await sleep(500);
  await shoot("01-backup-settings-daily.png", backupCard());

  // ---- 2. weekly + day-of-week -------------------------------------------
  await page.selectOption("#scheduledBackupFrequency", "weekly");
  await page.selectOption("#scheduledBackupDayOfWeek", "1");
  await page.locator("#scheduledBackupTime").fill("03:30");
  await page.locator("#scheduledBackupTime").dispatchEvent("change");
  await sleep(1200);
  await shoot("02-backup-settings-weekly.png", backupCard());

  // ---- 3. dark theme, hourly ---------------------------------------------
  await set({ theme: "dark" });
  await openSettings();
  await backupCard().scrollIntoViewIfNeeded();
  await page.selectOption("#scheduledBackupFrequency", "hourly");
  await page.locator("#scheduledBackupTime").fill("00:15");
  await page.locator("#scheduledBackupTime").dispatchEvent("change");
  await sleep(1200);
  await shoot("03-backup-settings-dark.png", backupCard());

  // ---- 4. full options page for context ----------------------------------
  await set({ theme: "light", scheduledBackupFrequency: "daily", scheduledBackupTime: "06:00" });
  await openSettings();
  await backupCard().scrollIntoViewIfNeeded();
  await sleep(800);
  await shoot("04-options-page.png");

  // ---- 5. the actual result: exported files ------------------------------
  // Save a couple of sessions, run the schedule, then render the resulting tree.
  await set({ backupFolder: "TabSessionManager - Backup", lastBackupTime: 0 });
  const p2 = await context.newPage();
  await p2.goto("data:text/html,<title>Research</title><h1>research</h1>");
  const p3 = await context.newPage();
  await p3.goto("data:text/html,<title>Docs</title><h1>docs</h1>");
  await sleep(800);
  for (const n of ["Research reading", "Work morning"]) {
    await page.evaluate(
      name =>
        chrome.runtime.sendMessage({
          message: "saveCurrentSession",
          name,
          property: "saveAllWindows"
        }),
      n
    );
    await sleep(1800);
  }

  const requested = [];
  await sw.evaluate(() => {
    globalThis.__dl = [];
    const orig = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = o => {
      globalThis.__dl.push(o.filename);
      return orig(o);
    };
  });
  await sw.evaluate(() => chrome.alarms.create("scheduledBackup", { when: Date.now() + 300 }));
  await sleep(7000);
  requested.push(...(await sw.evaluate(() => globalThis.__dl || [])));
  console.log("exported:", requested);

  // Render the resulting backup tree as a small terminal-styled card.
  const tree = requested.length ? requested : ["(no files exported)"];
  const rendered = await context.newPage();
  await rendered.setViewportSize({ width: 900, height: 600 });
  await rendered.setContent(`
    <div id="card">
    <style>
      body{margin:0;background:#0d1117}#card{color:#c9d1d9;font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;padding:26px 30px;display:inline-block;min-width:860px}
      .t{color:#58a6ff;font-weight:600;margin-bottom:14px;font-size:13px;letter-spacing:.04em;text-transform:uppercase}
      .d{color:#7ee787}
      .f{color:#c9d1d9}
      .m{color:#8b949e}
      .row{white-space:pre}
    </style>
    <div class="t">~/Downloads &mdash; written automatically at 06:00</div>
    ${(() => {
      // group "Folder/Sub/file.json" into a tree
      const byDir = {};
      for (const f of tree) {
        const parts = f.split("/");
        const file = parts.pop();
        byDir[parts.join("/")] = byDir[parts.join("/")] || [];
        byDir[parts.join("/")].push(file);
      }
      let html = "";
      for (const [dir, files] of Object.entries(byDir)) {
        html += `<div class="row"><span class="d">${dir}/</span></div>`;
        files.forEach((f, i) => {
          const last = i === files.length - 1;
          html += `<div class="row"><span class="m">${last ? "└── " : "├── "}</span><span class="f">${f}</span></div>`;
        });
      }
      return html;
    })()}
    <div class="row" style="margin-top:16px"><span class="m">only sessions changed since the last run are written</span></div>
    </div>
  `);
  await sleep(400);
  await rendered.locator("#card").screenshot({ path: path.join(OUT, "05-backup-output.png") });
  console.log("wrote 05-backup-output.png");

  await context.close();
  process.exit(0);
})().catch(e => {
  console.error("ERR", e);
  process.exit(1);
});
