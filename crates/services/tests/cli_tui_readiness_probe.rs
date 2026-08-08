//! Manual probe: how long does a coding CLI's TUI take to accept input?
//!
//! SoloDawn dispatches a terminal's first instruction on a *fixed* schedule —
//! 2s after PTY spawn, then submit Enters at +120/+360/+900ms
//! (`terminal::submit_policy`). If the CLI's TUI is not yet reading its PTY at
//! those instants, the instruction and every Enter are swallowed: the terminal
//! looks alive, the workflow advances, and nothing is ever produced.
//!
//! These probes measure the real number instead of guessing at it. They are
//! `#[ignore]`d because they need the CLI actually installed and take tens of
//! seconds; run one explicitly:
//!
//! ```text
//! cargo test -p services --test cli_tui_readiness_probe -- --ignored --nocapture probe_codex
//! ```
//!
//! Output is a timeline of `+<ms> <bytes>` chunks plus the first instant the
//! CLI rendered anything, so the schedule can be compared against reality.

use std::time::{Duration, Instant};

use services::services::terminal::process::{ProcessManager, SpawnCommand};

/// Chunks of PTY output tagged with the delay since spawn.
struct Timeline {
    first_output_ms: Option<u128>,
    total_bytes: usize,
    text: String,
}

async fn record_pty(command: &str, args: &[&str], observe: Duration) -> Timeline {
    let manager = ProcessManager::new();
    let workdir = tempfile::tempdir().expect("tempdir");
    let spawn = SpawnCommand::new(command, workdir.path()).with_args(args.iter().copied());
    let terminal_id = format!("probe-{command}");

    let started = Instant::now();
    manager
        .spawn_pty_with_config(&terminal_id, &spawn, 120, 30)
        .await
        .unwrap_or_else(|e| panic!("failed to spawn {command}: {e}"));

    let mut subscription = manager
        .subscribe_output(&terminal_id, None)
        .await
        .expect("subscribe to PTY output");

    let mut timeline = Timeline {
        first_output_ms: None,
        total_bytes: 0,
        text: String::new(),
    };

    while started.elapsed() < observe {
        let remaining = observe.saturating_sub(started.elapsed());
        match tokio::time::timeout(remaining, subscription.recv()).await {
            Ok(Ok(chunk)) => {
                let at_ms = started.elapsed().as_millis();
                timeline.first_output_ms.get_or_insert(at_ms);
                timeline.total_bytes += chunk.text.len();
                timeline.text.push_str(&chunk.text);
                println!("  +{at_ms:>6}ms  {:>6} bytes", chunk.text.len());
            }
            Ok(Err(_)) => break,
            Err(_) => break,
        }
    }

    let _ = tokio::time::timeout(Duration::from_secs(10), manager.kill_terminal(&terminal_id)).await;
    timeline
}

async fn probe(command: &str, args: &[&str]) {
    // The production schedule this probe exists to check, in ms after spawn.
    const INSTRUCTION_AT_MS: u128 = 2000;
    const CODEX_LAST_ENTER_AT_MS: u128 = 2000 + 120 + 360 + 900;

    println!("\n=== {command} {args:?} ===");
    let timeline = record_pty(command, args, Duration::from_secs(30)).await;

    println!("--- summary ---");
    println!("total bytes      : {}", timeline.total_bytes);
    match timeline.first_output_ms {
        Some(ms) => {
            println!("first output at  : +{ms}ms");
            println!("instruction sent : +{INSTRUCTION_AT_MS}ms");
            println!("last codex Enter : +{CODEX_LAST_ENTER_AT_MS}ms");
            if ms > INSTRUCTION_AT_MS {
                println!(
                    "VERDICT: the CLI had not drawn anything when the instruction was sent \
                     ({ms}ms > {INSTRUCTION_AT_MS}ms) — the fixed schedule races the TUI."
                );
            } else {
                println!("VERDICT: TUI drew before the instruction was sent.");
            }
        }
        None => println!("first output at  : never within the observation window"),
    }
    let tail: String = timeline.text.chars().rev().take(400).collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    println!("--- last 400 chars of PTY output ---\n{tail}\n");
}

#[tokio::test]
#[ignore = "needs codex installed; measures real TUI cold start"]
async fn probe_codex() {
    probe("codex", &[]).await;
}

#[tokio::test]
#[ignore = "needs claude installed; measures real TUI cold start"]
async fn probe_claude() {
    probe("claude", &[]).await;
}

/// Replay production's exact first-dispatch sequence and show where the
/// instruction ends up.
///
/// `submit_schedule_ms` mirrors `submit_policy::initial_submit_keystroke_schedule_ms`
/// for the CLI under test.
async fn probe_dispatch(command: &str, submit_schedule_ms: &[u64]) {
    const MARKER: &str = "SOLODAWN-PROBE-MARKER";
    let instruction = format!("Create a file named {MARKER}.txt containing the word ok.\r");

    let manager = ProcessManager::new();
    let workdir = tempfile::tempdir().expect("tempdir");
    let spawn = SpawnCommand::new(command, workdir.path());
    let terminal_id = format!("dispatch-{command}");

    let started = Instant::now();
    manager
        .spawn_pty_with_config(&terminal_id, &spawn, 120, 30)
        .await
        .unwrap_or_else(|e| panic!("failed to spawn {command}: {e}"));

    let mut subscription = manager
        .subscribe_output(&terminal_id, None)
        .await
        .expect("subscribe to PTY output");

    let handle = manager
        .get_handle(&terminal_id)
        .await
        .expect("handle for writing");
    let writer = handle.writer.expect("pty writer");

    // Production: 2s settle, then the instruction, then the submit schedule.
    tokio::time::sleep(Duration::from_secs(2)).await;
    write_pty(&writer, &instruction).await;
    println!("  sent instruction at +{}ms", started.elapsed().as_millis());
    for &delay in submit_schedule_ms {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        write_pty(&writer, "\r").await;
        println!("  sent Enter       at +{}ms", started.elapsed().as_millis());
    }

    let mut screen = String::new();
    while started.elapsed() < Duration::from_secs(25) {
        let remaining = Duration::from_secs(25).saturating_sub(started.elapsed());
        match tokio::time::timeout(remaining, subscription.recv()).await {
            Ok(Ok(chunk)) => screen.push_str(&chunk.text),
            _ => break,
        }
    }

    let _ = tokio::time::timeout(Duration::from_secs(10), manager.kill_terminal(&terminal_id)).await;

    let visible = strip_ansi(&screen);
    println!("\n--- did the instruction survive? ---");
    println!(
        "marker echoed anywhere on screen : {}",
        visible.contains(MARKER)
    );
    println!(
        "trust modal was on screen        : {}",
        visible.contains("trust this folder") || visible.contains("Trusting the directory")
    );
    println!(
        "file actually created            : {}",
        workdir.path().join(format!("{MARKER}.txt")).exists()
    );
    let tail: String = visible.chars().rev().take(600).collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    println!("--- last 600 visible chars ---\n{tail}\n");
}

async fn write_pty(
    writer: &std::sync::Arc<std::sync::Mutex<services::services::terminal::process::PtyWriter>>,
    text: &str,
) {
    let mut guard = writer.lock().expect("pty writer lock");
    guard.write_all(text.as_bytes()).expect("write to pty");
    guard.flush().expect("flush pty");
}

/// Minimal CSI/OSC stripper — enough to read what a human would see.
fn strip_ansi(raw: &str) -> String {
    let esc = char::from(0x1b);
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != esc {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') | Some('>') | Some('?') => {
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() || next == 'm' {
                        break;
                    }
                }
            }
            Some(']') => {
                for next in chars.by_ref() {
                    if next == char::from(0x07) || next == '\\' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[tokio::test]
#[ignore = "needs codex installed; replays production's first dispatch"]
async fn probe_codex_dispatch() {
    probe_dispatch("codex", &[120, 360, 900]).await;
}

#[tokio::test]
#[ignore = "needs claude installed; replays production's first dispatch"]
async fn probe_claude_dispatch() {
    probe_dispatch("claude", &[420]).await;
}

/// Same dispatch, but the cold-start trust modal is answered first — the
/// behaviour `prompt_watcher::is_trust_folder_prompt` now produces.
///
/// Prints whether the instruction reached the composer. Compare against the
/// matching `probe_*_dispatch` run, where it does not.
async fn probe_dispatch_with_trust_answered(command: &str, submit_schedule_ms: &[u64]) {
    const MARKER: &str = "SOLODAWN-PROBE-MARKER";
    let instruction = format!("Create a file named {MARKER}.txt containing the word ok.\r");

    let manager = ProcessManager::new();
    let workdir = tempfile::tempdir().expect("tempdir");
    let spawn = SpawnCommand::new(command, workdir.path());
    let terminal_id = format!("trust-{command}");

    let started = Instant::now();
    manager
        .spawn_pty_with_config(&terminal_id, &spawn, 120, 30)
        .await
        .unwrap_or_else(|e| panic!("failed to spawn {command}: {e}"));

    let mut subscription = manager
        .subscribe_output(&terminal_id, None)
        .await
        .expect("subscribe to PTY output");
    let writer = manager
        .get_handle(&terminal_id)
        .await
        .expect("handle")
        .writer
        .expect("pty writer");

    // Watch output until the trust modal appears, then answer it — exactly what
    // the prompt watcher now does on its own.
    let mut seen = String::new();
    let mut answered_at = None;
    while started.elapsed() < Duration::from_secs(15) {
        let remaining = Duration::from_secs(15).saturating_sub(started.elapsed());
        match tokio::time::timeout(remaining, subscription.recv()).await {
            Ok(Ok(chunk)) => {
                seen.push_str(&chunk.text);
                let visible = strip_ansi(&seen).to_ascii_lowercase();
                let is_modal = (visible.contains("trust this folder")
                    || visible.contains("trust the files in this folder")
                    || visible.contains("trusting the directory"))
                    && visible.contains("1. yes");
                if is_modal {
                    write_pty(&writer, "1\r").await;
                    answered_at = Some(started.elapsed().as_millis());
                    println!("  answered trust modal at +{}ms", answered_at.unwrap());
                    break;
                }
            }
            _ => break,
        }
    }

    // Give the composer a moment to render, then run the production sequence.
    tokio::time::sleep(Duration::from_secs(3)).await;
    write_pty(&writer, &instruction).await;
    println!("  sent instruction at +{}ms", started.elapsed().as_millis());
    for &delay in submit_schedule_ms {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        write_pty(&writer, "\r").await;
    }

    let mut screen = String::new();
    while started.elapsed() < Duration::from_secs(35) {
        let remaining = Duration::from_secs(35).saturating_sub(started.elapsed());
        match tokio::time::timeout(remaining, subscription.recv()).await {
            Ok(Ok(chunk)) => screen.push_str(&chunk.text),
            _ => break,
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(10), manager.kill_terminal(&terminal_id)).await;

    let visible = strip_ansi(&screen);
    println!("\n--- with trust modal answered ---");
    println!("trust modal answered at : {answered_at:?}");
    println!("marker reached composer : {}", visible.contains(MARKER));
    let tail: String = visible.chars().rev().take(600).collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    println!("--- last 600 visible chars ---\n{tail}\n");
}

#[tokio::test]
#[ignore = "needs codex installed; verifies the trust-modal fix"]
async fn probe_codex_dispatch_with_trust_answered() {
    probe_dispatch_with_trust_answered("codex", &[120, 360, 900]).await;
}

#[tokio::test]
#[ignore = "needs claude installed; verifies the trust-modal fix"]
async fn probe_claude_dispatch_with_trust_answered() {
    probe_dispatch_with_trust_answered("claude", &[420]).await;
}
