// Tests the REAL src/background/scheduledBackup.js by transpiling it to CJS
// and injecting mocks for webextension-polyfill / settings / backup.
const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");
const Module = require("module");

const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "src/background/scheduledBackup.js");

// ---- mocks -------------------------------------------------------------
let settings = {};
let alarms = {};
let backupCalls = 0;

const mocks = {
  "webextension-polyfill": {
    __esModule: true,
    default: {
      alarms: {
        create: (name, opts) => {
          alarms[name] = opts;
        },
        clear: async name => {
          delete alarms[name];
        }
      }
    }
  },
  loglevel: {
    __esModule: true,
    default: { info: () => {}, log: () => {}, error: () => {}, warn: () => {} }
  },
  "src/settings/settings": {
    getSettings: id => settings[id],
    setSettings: async (id, v) => {
      settings[id] = v;
    }
  },
  "./backup.js": {
    backupSessions: async () => {
      backupCalls++;
    }
  }
};

function load() {
  const code = babel.transformFileSync(SRC, {
    presets: [["@babel/preset-env", { targets: { node: "current" } }]],
    plugins: ["@babel/plugin-proposal-optional-chaining"],
    cwd: REPO
  }).code;

  const m = new Module(SRC, null);
  m.filename = SRC;
  m.require = req => {
    if (mocks[req]) return mocks[req];
    throw new Error("unmocked require: " + req);
  };
  m._compile(code, SRC);
  return m.exports;
}

// ---- test harness ------------------------------------------------------
let pass = 0,
  fail = 0;
const eq = (actual, expected, label) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${label}`);
  if (!ok) console.log(`         expected: ${expected}\n         actual:   ${actual}`);
};

const fmt = ts => new Date(ts).toString().replace(/ \(.*\)$/, "");
const at = s => new Date(s).getTime();

const mod = load();

console.log(
  `\nTZ = ${process.env.TZ || "(system)"}  — local offset now: UTC${-new Date().getTimezoneOffset() / 60}\n`
);

// === daily ==============================================================
console.log("daily @ 06:00");
settings = { scheduledBackupFrequency: "daily", scheduledBackupTime: "06:00" };

eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T03:00:00"))),
  fmt(at("2026-08-08T06:00:00")),
  "before 6am today -> today 6am"
);
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T09:00:00"))),
  fmt(at("2026-08-09T06:00:00")),
  "after 6am -> tomorrow 6am"
);
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T06:00:00"))),
  fmt(at("2026-08-09T06:00:00")),
  "exactly 6am -> tomorrow (no immediate refire loop)"
);
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-31T23:30:00"))),
  fmt(at("2026-09-01T06:00:00")),
  "month rollover"
);
eq(
  fmt(mod.getNextScheduledTime(at("2026-12-31T23:30:00"))),
  fmt(at("2027-01-01T06:00:00")),
  "year rollover"
);

// === hourly =============================================================
console.log("\nhourly (minutes from time setting)");
settings = { scheduledBackupFrequency: "hourly", scheduledBackupTime: "06:30" };
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T09:10:00"))),
  fmt(at("2026-08-08T09:30:00")),
  ":10 -> :30 same hour"
);
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T09:45:00"))),
  fmt(at("2026-08-08T10:30:00")),
  ":45 -> next hour :30"
);
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T23:45:00"))),
  fmt(at("2026-08-09T00:30:00")),
  "hour rollover past midnight"
);

// === weekly =============================================================
console.log("\nweekly");
// 2026-08-08 is a Saturday
settings = {
  scheduledBackupFrequency: "weekly",
  scheduledBackupTime: "06:00",
  scheduledBackupDayOfWeek: "0"
};
eq(new Date(at("2026-08-08T00:00:00")).getDay(), 6, "sanity: 2026-08-08 is Saturday");
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T09:00:00"))),
  fmt(at("2026-08-09T06:00:00")),
  "Sat -> next Sunday"
);
settings.scheduledBackupDayOfWeek = "6"; // Saturday = today
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T03:00:00"))),
  fmt(at("2026-08-08T06:00:00")),
  "target day is today, before time -> today"
);
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T09:00:00"))),
  fmt(at("2026-08-15T06:00:00")),
  "target day is today, after time -> +7 days"
);

// === malformed input ====================================================
console.log("\nmalformed time input falls back to 06:00");
settings = { scheduledBackupFrequency: "daily", scheduledBackupTime: "" };
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T03:00:00"))),
  fmt(at("2026-08-08T06:00:00")),
  "empty string"
);
settings.scheduledBackupTime = "99:99";
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T03:00:00"))),
  fmt(at("2026-08-08T06:00:00")),
  "out of range"
);
settings.scheduledBackupTime = undefined;
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T03:00:00"))),
  fmt(at("2026-08-08T06:00:00")),
  "undefined"
);
settings.scheduledBackupTime = "7:05";
eq(
  fmt(mod.getNextScheduledTime(at("2026-08-08T03:00:00"))),
  fmt(at("2026-08-08T07:05:00")),
  "single-digit hour"
);

// === DST =================================================================
// Only meaningful in a DST-observing zone; skipped elsewhere.
{
  const janOffset = new Date("2026-01-15T12:00:00").getTimezoneOffset();
  const julOffset = new Date("2026-07-15T12:00:00").getTimezoneOffset();
  if (janOffset !== julOffset) {
    console.log("\nDST boundaries (daily @ 06:00 must stay 06:00 wall-clock)");
    settings = { scheduledBackupFrequency: "daily", scheduledBackupTime: "06:00" };
    // US 2026: spring forward Mar 8, fall back Nov 1
    for (const [from, expect, label] of [
      ["2026-03-07T09:00:00", "2026-03-08T06:00:00", "across spring-forward"],
      ["2026-10-31T09:00:00", "2026-11-01T06:00:00", "across fall-back"]
    ]) {
      const got = mod.getNextScheduledTime(at(from));
      const d = new Date(got);
      eq(
        `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`,
        "6:00",
        `${label} -> wall clock still 06:00`
      );
      eq(fmt(got), fmt(at(expect)), `${label} -> correct date`);
      const deltaHours = (got - at(from)) / 3600000;
      console.log(
        `         (absolute elapsed: ${deltaHours}h — a fixed 1440min period would drift here)`
      );
    }
  } else {
    console.log("\nDST boundaries: skipped (no DST in this zone)");
  }
}

// === alarm wiring =======================================================
console.log("\nalarm wiring");
(async () => {
  settings = {
    ifBackup: true,
    ifScheduledBackup: true,
    scheduledBackupFrequency: "daily",
    scheduledBackupTime: "06:00"
  };
  alarms = {};
  await mod.setScheduledBackup();
  eq(!!alarms.scheduledBackup, true, "alarm created when enabled");
  eq(typeof alarms.scheduledBackup?.when, "number", "alarm uses absolute `when`");
  eq(
    alarms.scheduledBackup?.periodInMinutes,
    undefined,
    "one-shot (no periodInMinutes -> DST safe)"
  );

  settings.ifScheduledBackup = false;
  alarms = {};
  await mod.setScheduledBackup();
  eq(alarms.scheduledBackup, undefined, "no alarm when ifScheduledBackup off");

  settings.ifScheduledBackup = true;
  settings.ifBackup = false;
  alarms = {};
  await mod.setScheduledBackup();
  eq(alarms.scheduledBackup, undefined, "no alarm when master ifBackup off");

  // re-arm after firing
  settings.ifBackup = true;
  alarms = {};
  backupCalls = 0;
  await mod.handleScheduledBackup();
  eq(backupCalls, 1, "handleScheduledBackup runs a backup");
  eq(!!alarms.scheduledBackup, true, "re-arms next alarm after firing");
  eq(typeof settings.lastScheduledBackupTime, "number", "records lastScheduledBackupTime");

  // change detection
  console.log("\nsettings-change detection");
  alarms = {};
  await mod.setScheduledBackup({ Settings: { oldValue: { x: 1 }, newValue: { x: 2 } } }, "local");
  eq(alarms.scheduledBackup, undefined, "unrelated setting change -> no re-arm");
  await mod.setScheduledBackup(
    {
      Settings: {
        oldValue: { scheduledBackupTime: "06:00" },
        newValue: { scheduledBackupTime: "07:00", ifBackup: true, ifScheduledBackup: true }
      }
    },
    "local"
  );
  eq(!!alarms.scheduledBackup, true, "time change -> re-arm");

  // === missed-backup catch-up ==========================================
  console.log("\nmissed-backup catch-up");
  settings = {
    ifBackup: true,
    ifScheduledBackup: true,
    shouldRunMissedBackup: true,
    scheduledBackupFrequency: "daily",
    scheduledBackupTime: "06:00",
    lastScheduledBackupTime: Date.now() - 2 * 24 * 60 * 60 * 1000
  };
  backupCalls = 0;
  await mod.runMissedScheduledBackup();
  eq(backupCalls, 1, "2 days since last run -> catch up");

  settings.lastScheduledBackupTime = Date.now() - 60 * 1000;
  backupCalls = 0;
  await mod.runMissedScheduledBackup();
  eq(backupCalls, 0, "1 min since last run -> no catch up");

  settings.lastScheduledBackupTime = 0;
  backupCalls = 0;
  await mod.runMissedScheduledBackup();
  eq(backupCalls, 0, "first ever run -> no spurious backup");
  eq(typeof settings.lastScheduledBackupTime, "number", "  ...but seeds the timestamp");

  settings.lastScheduledBackupTime = Date.now() - 10 * 24 * 60 * 60 * 1000;
  settings.shouldRunMissedBackup = false;
  backupCalls = 0;
  await mod.runMissedScheduledBackup();
  eq(backupCalls, 0, "catch-up disabled -> no backup");

  settings.shouldRunMissedBackup = true;
  settings.ifBackup = false;
  backupCalls = 0;
  await mod.runMissedScheduledBackup();
  eq(backupCalls, 0, "master off -> no catch-up backup");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
