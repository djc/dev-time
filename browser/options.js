const form = document.getElementById("options");
const hostInput = document.getElementById("host");
const syncUrlInput = document.getElementById("syncUrl");
const status = document.getElementById("status");

browser.storage.local.get(["host", "syncUrl"]).then((result) => {
  if (result.host) {
    hostInput.value = result.host;
  }
  if (result.syncUrl) {
    syncUrlInput.value = result.syncUrl;
  }
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  browser.storage.local
    .set({
      host: hostInput.value.trim(),
      syncUrl: syncUrlInput.value.trim(),
    })
    .then(() => {
      status.textContent = "Saved.";
      setTimeout(() => {
        status.textContent = "";
      }, 1500);
    });
});

// --- Unsynced runs table ---

const unsyncedCount = document.getElementById("unsyncedCount");
const unsyncedBody = document.querySelector("#unsyncedTable tbody");

function loadUnsyncedRuns() {
  browser.storage.local.get("lastSyncId").then(({ lastSyncId = 0 }) => {
    const req = indexedDB.open("work-tracker", 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("runs", "readonly");
      const store = tx.objectStore("runs");
      const range = IDBKeyRange.lowerBound(lastSyncId, true);
      const cursor = store.openCursor(range);
      const runs = [];
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          runs.push(c.value);
          c.continue();
        } else {
          unsyncedCount.textContent = runs.length;
          unsyncedBody.innerHTML = "";
          for (const run of runs) {
            const tr = document.createElement("tr");
            tr.innerHTML =
              `<td>${run.id}</td>` +
              `<td>${run.context}</td>` +
              `<td>${run.start_time}</td>` +
              `<td>${run.end_time}</td>`;
            unsyncedBody.appendChild(tr);
          }
        }
      };
    };
  });
}

loadUnsyncedRuns();

if (location.hash === "#unsynced") {
  document.getElementById("unsyncedDetails").open = true;
  document.getElementById("unsyncedDetails").scrollIntoView();
}

// --- Sync now button ---

const syncNow = document.getElementById("syncNow");
const syncStatus = document.getElementById("syncStatus");

syncNow.addEventListener("click", () => {
  syncNow.disabled = true;
  syncStatus.textContent = "Syncing...";
  browser.runtime.sendMessage({ action: "sync" }).then(() => {
    syncStatus.textContent = "Done.";
    loadUnsyncedRuns();
    syncNow.disabled = false;
    setTimeout(() => {
      syncStatus.textContent = "";
    }, 1500);
  });
});
