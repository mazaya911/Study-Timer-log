/**
 * Google Apps Script backend for Study Timer Log.
 * Sheet header row (row 1): Timestamp | Subject | Minutes | Note | Nickname
 * doPost -> validates and appends a row.   doGet -> returns all rows as JSON.
 */
var LIMITS = { subject: 30, nickname: 20, note: 100, minMinutes: 1, maxMinutes: 720 };

/** Trim, drop control characters, cut length, and strip leading = + - @ (blocks spreadsheet formulas). */
function clean_(value, maxLen) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    .replace(/^[=+\-@]+/, '').trim().slice(0, maxLen);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');
    var subject = clean_(body.subject, LIMITS.subject);
    var minutes = Number(body.minutes);
    if (!subject) return json_({ ok: false, error: 'Subject required' });
    if (!isFinite(minutes) || Math.floor(minutes) !== minutes ||
        minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes) {
      return json_({ ok: false, error: 'Minutes must be a whole number 1-720' });
    }
    var lock = LockService.getScriptLock();   // avoid two writes at the same moment
    lock.waitLock(10000);
    SpreadsheetApp.getActiveSpreadsheet().getSheets()[0].appendRow([
      new Date().toISOString(), subject, minutes,
      clean_(body.note, LIMITS.note), clean_(body.nickname, LIMITS.nickname)
    ]);
    lock.releaseLock();
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  var rows = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0].getDataRange().getValues();
  var sessions = [];
  for (var i = 1; i < rows.length; i++) {           // row 0 is the header
    var r = rows[i];
    if (!r[1] || !r[2]) continue;                   // skip blank rows
    var ts = r[0] instanceof Date ? r[0].toISOString() : String(r[0]);
    sessions.push({ timestamp: ts, subject: String(r[1]), minutes: Number(r[2]),
                    note: String(r[3] || ''), nickname: String(r[4] || '') });
  }
  return json_({ sessions: sessions });
}
