import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings, setSettings } from "src/settings/settings";
import { backupSessions } from "./backup.js";

const logDir = "background/scheduledBackup";

export const SCHEDULED_BACKUP_ALARM = "scheduledBackup";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

//スケジュールの間隔(ミリ秒)。catch-upの判定にも利用する
const intervalOf = frequency => {
  switch (frequency) {
    case "hourly":
      return HOUR;
    case "weekly":
      return 7 * DAY;
    case "daily":
    default:
      return DAY;
  }
};

//"06:00"形式の設定値を時と分に分解する。不正な値の場合は6時0分にフォールバックする
const parseTimeOfDay = value => {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!matched) return { hours: 6, minutes: 0 };

  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (hours > 23 || minutes > 59) return { hours: 6, minutes: 0 };
  return { hours, minutes };
};

// 次回の実行時刻をローカルタイムゾーンで計算する
// Dateのローカル時刻で組み立てるため、JSTなどのオフセットやDSTは自動的に反映される
export const getNextScheduledTime = (from = Date.now()) => {
  const frequency = getSettings("scheduledBackupFrequency") || "daily";
  const { hours, minutes } = parseTimeOfDay(getSettings("scheduledBackupTime"));
  const base = new Date(from);

  if (frequency === "hourly") {
    const next = new Date(base);
    next.setMinutes(minutes, 0, 0);
    if (next.getTime() <= from) next.setTime(next.getTime() + HOUR);
    return next.getTime();
  }

  const next = new Date(base);
  next.setHours(hours, minutes, 0, 0);

  if (frequency === "weekly") {
    const targetDay = Number(getSettings("scheduledBackupDayOfWeek") ?? 0);
    // 目標曜日まで進める。同じ曜日でも時刻を過ぎていれば翌週にする
    let dayDiff = (targetDay - next.getDay() + 7) % 7;
    if (dayDiff === 0 && next.getTime() <= from) dayDiff = 7;
    next.setDate(next.getDate() + dayDiff);
    return next.getTime();
  }

  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
};

// 一回限りのアラームを張り直す方式にしている
// periodInMinutesによる固定間隔だとDSTや月末で指定時刻からずれていくため
export const setScheduledBackup = async (changes, areaName) => {
  if (!isChangedScheduledBackupSettings(changes, areaName)) return;

  await browser.alarms.clear(SCHEDULED_BACKUP_ALARM);
  if (!getSettings("ifBackup") || !getSettings("ifScheduledBackup")) return;

  const when = getNextScheduledTime();
  log.info(logDir, "setScheduledBackup()", new Date(when).toString());
  browser.alarms.create(SCHEDULED_BACKUP_ALARM, { when });
};

const isChangedScheduledBackupSettings = (changes, areaName) => {
  if (changes == undefined) return true; //最初の一回
  if (changes.Settings == undefined) return false;

  const oldValue = changes.Settings.oldValue;
  const newValue = changes.Settings.newValue;
  return (
    oldValue?.ifBackup != newValue.ifBackup ||
    oldValue?.ifScheduledBackup != newValue.ifScheduledBackup ||
    oldValue?.scheduledBackupFrequency != newValue.scheduledBackupFrequency ||
    oldValue?.scheduledBackupTime != newValue.scheduledBackupTime ||
    oldValue?.scheduledBackupDayOfWeek != newValue.scheduledBackupDayOfWeek
  );
};

export const handleScheduledBackup = async () => {
  log.info(logDir, "handleScheduledBackup()");
  try {
    await backupSessions();
    await setSettings("lastScheduledBackupTime", Date.now());
  } catch (e) {
    log.error(logDir, "handleScheduledBackup()", e);
  } finally {
    // バックアップが失敗しても次回のアラームは張り直す
    await scheduleNextBackup();
  }
};

const scheduleNextBackup = async () => {
  await browser.alarms.clear(SCHEDULED_BACKUP_ALARM);
  if (!getSettings("ifBackup") || !getSettings("ifScheduledBackup")) return;

  const when = getNextScheduledTime();
  log.info(logDir, "scheduleNextBackup()", new Date(when).toString());
  browser.alarms.create(SCHEDULED_BACKUP_ALARM, { when });
};

// ブラウザが終了していた間に予定時刻を跨いだ場合、起動時に取り逃したバックアップを実行する
// これがないと「毎日6時」の設定でも6時にブラウザを開いていないユーザーは永遠にバックアップされない
export const runMissedScheduledBackup = async () => {
  if (!getSettings("ifBackup") || !getSettings("ifScheduledBackup")) return;
  if (!getSettings("shouldRunMissedBackup")) return;

  const lastRun = getSettings("lastScheduledBackupTime") || 0;
  const interval = intervalOf(getSettings("scheduledBackupFrequency"));

  // 初回(未実行)は基準がないので、取り逃しとはみなさず次回の予定を待つ
  if (!lastRun) {
    await setSettings("lastScheduledBackupTime", Date.now());
    return;
  }

  if (Date.now() - lastRun < interval) return;

  log.info(logDir, "runMissedScheduledBackup()", "last run", new Date(lastRun).toString());
  await backupSessions();
  await setSettings("lastScheduledBackupTime", Date.now());
};
