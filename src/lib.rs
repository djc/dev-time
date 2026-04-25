use anyhow::Context;
use jiff::Timestamp;
use rusqlite::Connection;
use serde::Deserialize;

pub struct Store {
    db: Connection,
}

impl Store {
    pub fn open() -> anyhow::Result<Self> {
        let db = Connection::open("dev-time.db").context("failed to open database")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host TEXT NOT NULL,
                source TEXT NOT NULL,
                context TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL
            );",
        )
        .context("failed to initialize database")?;

        Ok(Self { db })
    }

    pub fn save(&mut self, req: SyncRequest) -> anyhow::Result<()> {
        let tx = self
            .db
            .transaction()
            .context("failed to start save transaction")?;

        for run in &req.runs {
            tx.execute(
                "INSERT INTO runs (host, source, context, start_time, end_time) VALUES (?1, ?2, ?3, ?4, ?5)",
                (&req.host, &req.source, &run.context, &run.start_time, &run.end_time),
            )
            .context("failed to insert run data")?;
        }

        tx.commit().context("failed to commit save transaction")?;
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct SyncRequest {
    pub host: String,
    pub source: String,
    pub runs: Vec<SourceRun>,
}

#[derive(Deserialize)]
pub struct SourceRun {
    context: String,
    start_time: Timestamp,
    end_time: Timestamp,
}
