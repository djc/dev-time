use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::{env, process::ExitCode};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use jiff::Timestamp;
use rusqlite::Connection;
use serde::Deserialize;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

#[tokio::main]
async fn main() -> ExitCode {
    let builder = tracing_subscriber::registry().with(
        tracing_subscriber::EnvFilter::builder()
            .with_default_directive(LevelFilter::INFO.into())
            .from_env_lossy(),
    );

    match env::var("JOURNAL_STREAM") {
        Ok(_) => {
            builder
                .with(
                    tracing_subscriber::fmt::layer()
                        .without_time()
                        .with_target(false),
                )
                .init();
        }
        Err(_) => {
            builder
                .with(tracing_subscriber::fmt::layer().with_target(false))
                .init();
        }
    }

    let db = Connection::open("dev-time.db").expect("failed to open database");
    init_db(&db);

    let state = Arc::new(AppState { db: Mutex::new(db) });
    let app = Router::new()
        .route("/runs", post(ingest_runs))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 1420));
    let listener = TcpListener::bind(addr).await.unwrap();
    info!(%addr, "listening");
    axum::serve(listener, app).await.expect("server error");
    ExitCode::SUCCESS
}

async fn ingest_runs(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SyncRequest>,
) -> Result<StatusCode, StatusCode> {
    info!(host = %req.host, source = %req.source, runs = req.runs.len(), "ingesting runs");
    let mut db = state.db.lock().unwrap();
    let tx = db
        .transaction()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    for run in &req.runs {
        tx.execute(
            "INSERT INTO runs (host, source, context, start_time, end_time) VALUES (?1, ?2, ?3, ?4, ?5)",
            (&req.host, &req.source, &run.context, &run.start_time, &run.end_time),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    tx.commit().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

fn init_db(db: &Connection) {
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
    .expect("failed to initialize database");
}

struct AppState {
    db: Mutex<Connection>,
}

#[derive(Deserialize)]
struct SyncRequest {
    host: String,
    source: String,
    runs: Vec<Run>,
}

#[derive(Deserialize)]
struct Run {
    context: String,
    start_time: Timestamp,
    end_time: Timestamp,
}
