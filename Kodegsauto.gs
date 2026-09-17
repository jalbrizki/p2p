const ONLINE_PROPERTY = "WEBRTC_ONLINE_USERS";
const SIGNAL_PROPERTY = "WEBRTC_SIGNALING";

const ACTIVE_AFTER = 10000;   // 10 detik
const OFFLINE_AFTER = 30000;  // 30 detik
const SIGNAL_EXPIRE = 5 * 60 * 1000; // 5 menit


function doGet(e) {
  const action = e && e.parameter ? e.parameter.action : "";

  try {
    if (action === "online") {
      return jsonResponse({
        ok: true,
        users: getOnlineUsers()
      });
    }

    if (action === "signals") {
      const id = cleanID(e.parameter.id);
      return jsonResponse({
        ok: true,
        signals: getSignalsFor(id)
      });
    }

    return jsonResponse({
      ok: true,
      message: "WebRTC Signaling Server aktif"
    });

  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err.message
    });
  }
}


function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || "{}");
    const action = data.action || "";

    switch (action) {

      case "heartbeat":
        return jsonResponse(heartbeat(cleanID(data.id)));

      case "offline":
        return jsonResponse(setOffline(cleanID(data.id)));

      case "request":
        return jsonResponse(
          createRequest(
            cleanID(data.from),
            cleanID(data.to)
          )
        );

      case "accept":
        return jsonResponse(
          updateSignal(
            data.requestId,
            cleanID(data.to),
            "accepted"
          )
        );

      case "reject":
        return jsonResponse(
          updateSignal(
            data.requestId,
            cleanID(data.to),
            "rejected"
          )
        );

      case "sendOffer":
        return jsonResponse(
          sendOffer(
            data.requestId,
            cleanID(data.from),
            data.offer
          )
        );

      case "sendAnswer":
        return jsonResponse(
          sendAnswer(
            data.requestId,
            cleanID(data.from),
            data.answer
          )
        );

      case "connected":
        return jsonResponse(
          updateSignal(
            data.requestId,
            cleanID(data.from),
            "connected"
          )
        );

      case "deleteSignal":
        return jsonResponse(
          deleteSignal(
            data.requestId,
            cleanID(data.from)
          )
        );

      default:
        return jsonResponse({
          ok: false,
          error: "Action tidak dikenal"
        });
    }

  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err.message
    });
  }
}


/* =========================
   PRESENCE
========================= */

function heartbeat(id) {

  if (!validID(id)) {
    return {
      ok: false,
      error: "ID tidak valid"
    };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const users = loadUsers();
    const now = Date.now();

    if (!users[id]) {
      users[id] = {
        id: id,
        firstSeen: now,
        lastSeen: now
      };
    } else {
      users[id].lastSeen = now;
    }

    saveUsers(users);

    return {
      ok: true
    };

  } finally {
    lock.releaseLock();
  }
}


function setOffline(id) {

  if (!validID(id)) {
    return {
      ok: false
    };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const users = loadUsers();

    delete users[id];

    saveUsers(users);

    return {
      ok: true
    };

  } finally {
    lock.releaseLock();
  }
}


function getOnlineUsers() {

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const users = loadUsers();
    const now = Date.now();
    const result = {};

    Object.keys(users).forEach(id => {

      const u = users[id];

      if (now - u.lastSeen > OFFLINE_AFTER) {
        delete users[id];
        return;
      }

      if (now - u.firstSeen >= ACTIVE_AFTER) {
        result[id] = {
          id: id,
          firstSeen: u.firstSeen,
          lastSeen: u.lastSeen
        };
      }
    });

    saveUsers(users);

    return Object.values(result);

  } finally {
    lock.releaseLock();
  }
}


function loadUsers() {

  const raw = PropertiesService
    .getScriptProperties()
    .getProperty(ONLINE_PROPERTY);

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}


function saveUsers(users) {

  PropertiesService
    .getScriptProperties()
    .setProperty(
      ONLINE_PROPERTY,
      JSON.stringify(users)
    );
}


/* =========================
   SIGNALING
========================= */

function createRequest(from, to) {

  if (!validID(from) || !validID(to)) {
    return {
      ok: false,
      error: "ID tidak valid"
    };
  }

  if (from === to) {
    return {
      ok: false,
      error: "Tidak dapat menghubungi diri sendiri"
    };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const signals = loadSignals();
    cleanupSignals(signals);

    // Cegah request ganda
    const existing = Object.values(signals).find(s =>
      s.from === from &&
      s.to === to &&
      ["request", "accepted", "offer", "answer"].includes(s.status)
    );

    if (existing) {
      saveSignals(signals);

      return {
        ok: true,
        requestId: existing.requestId,
        existing: true
      };
    }

    const requestId =
      Utilities.getUuid().replace(/-/g, "").substring(0, 12).toUpperCase();

    signals[requestId] = {
      requestId: requestId,
      from: from,
      to: to,
      status: "request",
      offer: null,
      answer: null,
      created: Date.now(),
      updated: Date.now()
    };

    saveSignals(signals);

    return {
      ok: true,
      requestId: requestId
    };

  } finally {
    lock.releaseLock();
  }
}


function getSignalsFor(id) {

  if (!validID(id)) return [];

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const signals = loadSignals();

    cleanupSignals(signals);

    const result = Object.values(signals).filter(s =>
      s.to === id || s.from === id
    );

    saveSignals(signals);

    return result;

  } finally {
    lock.releaseLock();
  }
}


function updateSignal(requestId, userId, status) {

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const signals = loadSignals();
    cleanupSignals(signals);

    const s = signals[requestId];

    if (!s) {
      return {
        ok: false,
        error: "Request tidak ditemukan"
      };
    }

    if (s.to !== userId && s.from !== userId) {
      return {
        ok: false,
        error: "Tidak memiliki akses"
      };
    }

    s.status = status;
    s.updated = Date.now();

    saveSignals(signals);

    return {
      ok: true
    };

  } finally {
    lock.releaseLock();
  }
}


function sendOffer(requestId, from, offer) {

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const signals = loadSignals();
    cleanupSignals(signals);

    const s = signals[requestId];

    if (!s) {
      return {
        ok: false,
        error: "Request tidak ditemukan"
      };
    }

    if (s.from !== from) {
      return {
        ok: false,
        error: "Bukan pemilik request"
      };
    }

    s.offer = offer;
    s.status = "offer";
    s.updated = Date.now();

    saveSignals(signals);

    return {
      ok: true
    };

  } finally {
    lock.releaseLock();
  }
}


function sendAnswer(requestId, from, answer) {

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const signals = loadSignals();
    cleanupSignals(signals);

    const s = signals[requestId];

    if (!s) {
      return {
        ok: false,
        error: "Request tidak ditemukan"
      };
    }

    if (s.to !== from) {
      return {
        ok: false,
        error: "Bukan penerima request"
      };
    }

    s.answer = answer;
    s.status = "answer";
    s.updated = Date.now();

    saveSignals(signals);

    return {
      ok: true
    };

  } finally {
    lock.releaseLock();
  }
}


function deleteSignal(requestId, userId) {

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {

    const signals = loadSignals();
    const s = signals[requestId];

    if (s &&
        (s.from === userId || s.to === userId)) {

      delete signals[requestId];

      saveSignals(signals);
    }

    return {
      ok: true
    };

  } finally {
    lock.releaseLock();
  }
}


function loadSignals() {

  const raw = PropertiesService
    .getScriptProperties()
    .getProperty(SIGNAL_PROPERTY);

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}


function saveSignals(signals) {

  PropertiesService
    .getScriptProperties()
    .setProperty(
      SIGNAL_PROPERTY,
      JSON.stringify(signals)
    );
}


function cleanupSignals(signals) {

  const now = Date.now();

  Object.keys(signals).forEach(id => {

    if (
      now - signals[id].updated > SIGNAL_EXPIRE
    ) {
      delete signals[id];
    }

  });
}


/* =========================
   VALIDATION
========================= */

function cleanID(id) {

  return String(id || "")
    .trim()
    .toUpperCase()
    .substring(0, 20);
}


function validID(id) {

  return /^[A-Z0-9]{3,20}$/.test(id);
}


/* =========================
   RESPONSE
========================= */

function jsonResponse(data) {

  return ContentService
    .createTextOutput(
      JSON.stringify(data)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}
