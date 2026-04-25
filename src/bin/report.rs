use std::{collections::HashMap, env, str::FromStr, time::Duration};

use dev_time::Store;
use jiff::{SignedDuration, Zoned, civil::Date, tz::TimeZone};

fn main() -> anyhow::Result<()> {
    let today = Zoned::now().date();
    let start = match env::args().nth(1) {
        Some(arg) => Date::from_str(&arg)?,
        None => today,
    }
    .at(0, 0, 0, 0)
    .to_zoned(TimeZone::system())?
    .timestamp();

    let end = match env::args().nth(2) {
        Some(arg) => Date::from_str(&arg)?,
        None => today,
    }
    .at(23, 59, 59, 999)
    .to_zoned(TimeZone::system())?
    .timestamp();

    let store = Store::open()?;
    let runs = store.range(start, end)?;
    let mut dates = HashMap::<Date, HashMap<String, Duration>>::new();
    for run in runs {
        let project = match &*run.source {
            "browser" => {
                let Some((_, path)) = run.context.split_once("github.com/") else {
                    continue;
                };

                if path.starts_with("notifications")
                    || path.starts_with("settings")
                    || path.starts_with("sessions")
                {
                    continue;
                }

                let mut parts = path.split('/');
                let Some(org) = parts.next() else {
                    continue;
                };

                let Some(repo) = parts.next() else {
                    continue;
                };

                format!("{org}/{repo}")
            }
            "code" => {
                let Some((_, path)) = run.context.split_once("github.com:") else {
                    continue;
                };

                path.strip_suffix(".git").unwrap_or(path).to_owned()
            }
            _ => continue,
        };

        let new = Duration::try_from(run.end_time - run.start_time)?;
        let date = run.start_time.to_zoned(TimeZone::system()).date();
        let projects = dates.entry(date).or_default();
        let current = projects.entry(project).or_default();
        *current = current.checked_add(new).unwrap();
    }

    let mut dates = dates.into_iter().collect::<Vec<_>>();
    dates.sort_by_key(|(date, _)| *date);
    for (date, projects) in dates {
        println!("{date}");
        let mut projects = projects.into_iter().collect::<Vec<_>>();
        projects.sort_by(|(_, a), (_, b)| b.cmp(a));
        for (project, span) in projects {
            let span = SignedDuration::try_from(span)?;
            println!("  {project}: {span:#}");
        }
    }

    Ok(())
}
