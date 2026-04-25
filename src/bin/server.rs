use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::{env, process::ExitCode};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use dev_time::{Store, SyncRequest};
use tokio::net::TcpListener;
use tracing::{error, info};
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

    let state = Arc::new(AppState {
        store: Mutex::new(Store::open().expect("failed to open store")),
    });

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
    let mut store = state.store.lock().unwrap();
    match store.save(req) {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(error) => {
            error!(?error, "failed to save runs");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

struct AppState {
    store: Mutex<Store>,
}
