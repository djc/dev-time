// --- IndexedDB setup ---

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("work-tracker", 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("runs", {
        keyPath: "id",
        autoIncrement: true,
      });
      store.createIndex("context", "context", { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- State ---

function now() {
  return new Date().toISOString();
}

class State {
  constructor(db) {
    this.db = db;
    this.host = "";
    this.syncUrl = "";
    this.focused = true;
    this.currentRunId = null;
    this.currentUrl = null;
  }

  endCurrentRun() {
    if (this.currentRunId === null) {
      return;
    }

    const tx = this.db.transaction("runs", "readwrite");
    const store = tx.objectStore("runs");
    const req = store.get(this.currentRunId);
    req.onsuccess = () => {
      const run = req.result;
      run.end_time = now();
      store.put(run);
    };
    this.currentRunId = null;
    this.currentUrl = null;
  }

  startRun(url) {
    const ts = now();
    const tx = this.db.transaction("runs", "readwrite");
    const store = tx.objectStore("runs");
    const req = store.add({ context: url, start_time: ts, end_time: ts });
    req.onsuccess = () => {
      this.currentRunId = req.result;
      this.currentUrl = url;
    };
  }

  updateEndTime() {
    if (this.currentRunId === null) return;
    const tx = this.db.transaction("runs", "readwrite");
    const store = tx.objectStore("runs");
    const req = store.get(this.currentRunId);
    req.onsuccess = () => {
      const run = req.result;
      run.end_time = now();
      store.put(run);
    };
  }

  async tick() {
    if (!this.focused) {
      if (this.currentRunId !== null) {
        this.endCurrentRun();
      }
      return;
    }

    let tabs;
    try {
      tabs = await browser.tabs.query({ active: true, currentWindow: true });
    } catch {
      return;
    }

    if (tabs.length === 0 || !tabs[0].url) {
      if (this.currentRunId !== null) {
        this.endCurrentRun();
      }
      return;
    }

    const url = tabs[0].url;

    if (url !== this.currentUrl) {
      this.endCurrentRun();
      this.startRun(url);
    } else {
      this.updateEndTime();
    }
  }

  getRunsSince(lastSyncId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("runs", "readonly");
      const store = tx.objectStore("runs");
      const range = IDBKeyRange.lowerBound(lastSyncId, true);
      const req = store.openCursor(range);
      const runs = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if (cursor.value.id !== this.currentRunId) {
            runs.push(cursor.value);
          }
          cursor.continue();
        } else {
          resolve(runs);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async sync() {
    if (!this.syncUrl) return;

    const { lastSyncId = 0 } = await browser.storage.local.get("lastSyncId");
    const runs = await this.getRunsSince(lastSyncId);
    if (runs.length === 0) return;

    const resp = await fetch(this.syncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: this.host, source: "browser", runs }),
    });

    if (resp.ok) {
      const maxId = Math.max(...runs.map((r) => r.id));
      await browser.storage.local.set({ lastSyncId: maxId });
    }
  }

  async trySync() {
    try {
      await this.sync();
    } catch {
      // Network error or server down; will retry next hour.
    }
  }
}

// --- Start ---

const SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour

openDb().then((db) => {
  const state = new State(db);

  browser.windows.onFocusChanged.addListener((windowId) => {
    state.focused = windowId !== browser.windows.WINDOW_ID_NONE;
  });

  browser.storage.local.get(["syncUrl", "host"]).then((result) => {
    if (result.syncUrl) {
      state.syncUrl = result.syncUrl;
    }
    if (result.host) {
      state.host = result.host;
    }
  });

  browser.storage.onChanged.addListener((changes) => {
    if (changes.syncUrl) {
      state.syncUrl = changes.syncUrl.newValue || "";
    }
    if (changes.host) {
      state.host = changes.host.newValue || "";
    }
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === "sync") {
      return state.trySync().then(() => ({ ok: true }));
    }
  });

  setInterval(() => state.tick(), 1000);
  state.trySync();
  setInterval(() => state.trySync(), SYNC_INTERVAL);
});
