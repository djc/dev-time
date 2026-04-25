const vscode = require("vscode");
const { execSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const RUNS_KEY = "devTime.runs";
const CURRENT_RUN_KEY = "devTime.currentRun";
const LAST_SYNCED_KEY = "devTime.lastSyncedId";
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

class State {
  constructor(extensionContext) {
    this.store = extensionContext.globalState;
    this.currentRun = null;
    this.heartbeatInterval = undefined;
    this.syncInterval = undefined;
    this.context = this._getGitOriginUrl();
  }

  _getGitOriginUrl() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      return "unknown";
    }
    try {
      return execSync("git remote get-url origin", {
        cwd: folder,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      return "unknown";
    }
  }

  recoverCrashedRun() {
    const crashedRun = this.store.get(CURRENT_RUN_KEY);
    if (!crashedRun) {
      return;
    }

    const runs = this.store.get(RUNS_KEY, []);
    runs.push(crashedRun);
    this.store.update(RUNS_KEY, runs);
    this.store.update(CURRENT_RUN_KEY, undefined);
  }

  startRun() {
    if (this.currentRun) {
      return;
    }

    const now = new Date().toISOString();
    this.currentRun = {
      id: randomUUID(),
      start_time: now,
      end_time: now,
      context: this.context,
    };

    this.store.update(CURRENT_RUN_KEY, this.currentRun);
  }

  endRun() {
    if (!this.currentRun) {
      return;
    }

    this.currentRun.end_time = new Date().toISOString();
    const runs = this.store.get(RUNS_KEY, []);
    runs.push(this.currentRun);
    this.store.update(RUNS_KEY, runs);
    this.store.update(CURRENT_RUN_KEY, undefined);
    this.currentRun = null;
  }

  _getUnsyncedRuns() {
    const runs = this.store.get(RUNS_KEY, []);
    const lastSyncedId = this.store.get(LAST_SYNCED_KEY);
    if (!lastSyncedId) {
      return runs;
    }

    const idx = runs.findIndex((r) => r.id === lastSyncedId);
    if (idx === -1) {
      return runs;
    }

    return runs.slice(idx + 1);
  }

  async syncRuns() {
    console.log("dev-time: syncing runs...");
    const config = vscode.workspace.getConfiguration("devTime");
    const remoteUrl = config.get("remoteUrl");
    if (!remoteUrl) {
      console.log("dev-time: remoteUrl not configured, skipping sync");
      return;
    }

    const unsynced = this._getUnsyncedRuns();
    if (unsynced.length === 0) {
      console.log("dev-time: no unsynced runs, skipping sync");
      return;
    }

    try {
      const payload = {
        host: config.get("hostname") || "",
        source: "code",
        runs: unsynced.map(({ context, start_time, end_time }) => ({
          context,
          start_time,
          end_time,
        })),
      };

      const response = await fetch(remoteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`dev-time: sync response ${response.status}`);

      if (response.ok) {
        const lastId = unsynced[unsynced.length - 1].id;
        await this.store.update(LAST_SYNCED_KEY, lastId);
      }
    } catch (err) {
      console.warn("dev-time: sync failed", err);
    }
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.currentRun) {
        this.currentRun.end_time = new Date().toISOString();
        this.store.update(CURRENT_RUN_KEY, this.currentRun);
      }
    }, 1000);
  }

  startSyncTimer() {
    this.syncInterval = setInterval(() => this.syncRuns(), SYNC_INTERVAL_MS);
  }

  dispose() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
  }
}

let tracker;

function activate(context) {
  tracker = new State(context);
  tracker.recoverCrashedRun();

  const output = vscode.window.createOutputChannel("Dev Time");
  context.subscriptions.push(output);

  if (vscode.window.state.focused) {
    tracker.startRun();
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        tracker.startRun();
      } else {
        tracker.endRun();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devTime.sync", () => tracker.syncRuns()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devTime.showRuns", () => {
      const runs = tracker.store.get(RUNS_KEY, []);
      const lastSyncedId = tracker.store.get(LAST_SYNCED_KEY);
      const currentRun = tracker.currentRun;

      let syncedUpToIndex = -1;
      if (lastSyncedId) {
        syncedUpToIndex = runs.findIndex((r) => r.id === lastSyncedId);
      }

      output.clear();
      output.appendLine(`Dev Time Runs  (${new Date().toISOString()})`);
      output.appendLine("=".repeat(60));

      if (currentRun) {
        output.appendLine("");
        output.appendLine("[active]");
        output.appendLine(`  id:      ${currentRun.id}`);
        output.appendLine(`  start:   ${currentRun.start_time}`);
        output.appendLine(`  end:     ${currentRun.end_time}`);
        output.appendLine(`  context: ${currentRun.context}`);
      }

      for (let i = runs.length - 1; i >= 0; i--) {
        const run = runs[i];
        const status =
          syncedUpToIndex >= 0 && i <= syncedUpToIndex ? "synced" : "unsynced";
        output.appendLine("");
        output.appendLine(`[${status}]`);
        output.appendLine(`  id:      ${run.id}`);
        output.appendLine(`  start:   ${run.start_time}`);
        output.appendLine(`  end:     ${run.end_time}`);
        output.appendLine(`  context: ${run.context}`);
      }

      if (!currentRun && runs.length === 0) {
        output.appendLine("");
        output.appendLine("No runs recorded.");
      }

      output.show(true);
    }),
  );

  tracker.startHeartbeat();
  tracker.startSyncTimer();
}

async function deactivate() {
  if (!tracker) {
    return;
  }
  tracker.dispose();
  tracker.endRun();
  await tracker.syncRuns();
}

module.exports = { activate, deactivate };
