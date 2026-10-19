//! Commit messages and PR descriptions written by Claude Code (`claude -p`).
//!
//! Uses the user's own Claude subscription (OAuth), with:
//! * `--setting-sources project,local`: the user's global CLAUDE.md / settings
//!   (personas, hooks…) never leak into a commit message,
//! * `--system-prompt`: our instructions replace the default agent prompt,
//! * `--tools ""`: the model only reads what we pipe in; it cannot run anything,
//! * `--no-session-persistence`: no transcripts for these one-off calls,
//! * Haiku: fast and light on the quota.
//!
//! Only ever triggered by an explicit click.

use super::{blocking, checked_root, git};
use crate::agents::{tool_command, tools};
use crate::proc;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

const MODEL: &str = "haiku";
const MAX_DIFF_CHARS: usize = 48_000;
/// Lockfiles and generated noise eat the context without saying anything.
const NOISE: [&str; 6] = [
    ":(exclude,glob)**/*.lock",
    ":(exclude,glob)**/pnpm-lock.yaml",
    ":(exclude,glob)**/package-lock.json",
    ":(exclude,glob)**/yarn.lock",
    ":(exclude,glob)**/*.min.js",
    ":(exclude,glob)**/*.snap",
];

const COMMIT_SYSTEM: &str = "Eres un generador de mensajes de commit. Devuelve SOLO el mensaje: sin comillas, sin \
bloques de código, sin explicaciones ni saludos. Formato: una línea de resumen en imperativo de máximo 72 caracteres; \
si el cambio lo amerita, una línea en blanco y viñetas breves con el porqué (no repitas el diff). Usa el idioma, el \
tono y las convenciones (prefijos tipo feat:/fix:, mayúsculas, ámbitos) de los commits recientes del repositorio; si no \
hay commits, escribe en español.";

const PR_SYSTEM: &str = "Eres un generador de descripciones de pull requests. Devuelve SOLO esto: en la primera línea \
el título (máximo 70 caracteres, sin prefijos como «Título:»), una línea en blanco y el cuerpo en Markdown con las \
secciones «## Resumen» (2 a 5 viñetas con el qué y el porqué), «## Cambios principales» y «## Cómo probar». Sin \
bloques de código alrededor de todo, sin texto antes ni después. Usa el idioma de los commits.";

fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        Some((cut, _)) => (text[..cut].to_owned(), true),
        None => (text.to_owned(), false),
    }
}

/// Removes wrappers models sometimes add despite instructions.
fn clean(output: &str) -> String {
    let mut text = output.trim();
    if let Some(inner) = text.strip_prefix("```") {
        text = inner.split_once('\n').map_or("", |(_, rest)| rest);
        text = text.trim_end().trim_end_matches("```").trim();
    }
    text.trim_matches(|c| c == '"' || c == '“' || c == '”')
        .trim()
        .to_owned()
}

fn ask_claude(cwd: &Path, system: &str, task: &str, context: String) -> Result<String, String> {
    let claude = tools()
        .claude
        .ok_or("Claude Code no está instalado (o no está en el PATH de tu shell).")?;
    let mut cmd = tool_command(&claude);
    cmd.current_dir(cwd).args([
        "-p",
        task,
        "--model",
        MODEL,
        "--tools",
        "",
        "--no-session-persistence",
        "--setting-sources",
        "project,local",
        "--system-prompt",
        system,
    ]);
    let out = proc::run(
        cmd,
        Some(context.into_bytes()),
        Duration::from_secs(120),
        256 * 1024,
    )
    .map_err(|e| format!("Claude {e}."))?;
    if !out.success() {
        let err = out.stderr_str();
        return Err(if err.is_empty() {
            "Claude no respondió.".into()
        } else {
            err
        });
    }
    let text = clean(&out.stdout_str());
    if text.is_empty() {
        Err("Claude devolvió una respuesta vacía.".into())
    } else {
        Ok(text)
    }
}

fn diff_for_prompt(root: &Path, range: &[&str]) -> Result<(String, String), String> {
    let stat = git(
        root,
        &[&["diff", "--stat=120", "--no-color"][..], range].concat(),
    )?;
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-U2"];
    args.extend_from_slice(range);
    args.push("--");
    args.push(".");
    args.extend_from_slice(&NOISE);
    let raw = git(root, &args)?;
    let (diff, cut) = truncate_chars(&raw, MAX_DIFF_CHARS);
    let note = if cut {
        "\n[diff truncado: se omitió el resto]"
    } else {
        ""
    };
    Ok((stat, format!("{diff}{note}")))
}

#[tauri::command]
pub async fn ai_commit_message(root: String) -> Result<String, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let (stat, diff) = diff_for_prompt(&root, &["--cached"])?;
        if stat.trim().is_empty() {
            return Err("No hay cambios preparados: prepara (stage) algo primero.".into());
        }
        let recent = git(&root, &["log", "-10", "--format=%s"]).unwrap_or_default();
        let context = format!(
            "Commits recientes del repositorio (imita su idioma y estilo):\n{recent}\n\nResumen de archivos:\n{stat}\n\nDiff preparado:\n{diff}"
        );
        ask_claude(&root, COMMIT_SYSTEM, "Escribe el mensaje de commit para estos cambios.", context)
            .map(|m| normalize_commit(&m))
    })
    .await
}

/// Git needs a blank line between the subject and the body.
fn normalize_commit(message: &str) -> String {
    let mut lines = message.lines();
    let subject = lines.next().unwrap_or_default().trim();
    let body: Vec<&str> = lines.skip_while(|l| l.trim().is_empty()).collect();
    if body.is_empty() {
        subject.to_owned()
    } else {
        format!("{subject}\n\n{}", body.join("\n").trim_end())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PrDraft {
    pub title: String,
    pub body: String,
}

fn split_draft(text: &str) -> PrDraft {
    let (title, body) = text.split_once('\n').unwrap_or((text, ""));
    let title = title
        .trim()
        .trim_start_matches('#')
        .trim()
        .trim_start_matches("Título:")
        .trim();
    PrDraft {
        title: title.to_owned(),
        body: body.trim().to_owned(),
    }
}

/// Title + body for the current branch against `base`.
#[tauri::command]
pub async fn ai_pr_description(root: String, base: String) -> Result<PrDraft, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        if base.is_empty() || base.starts_with('-') || base.contains(char::is_whitespace) {
            return Err("Rama base inválida.".into());
        }
        // Prefer the remote base (what the PR is compared against), then the local one.
        let remote_base = format!("origin/{base}");
        let base_ref = if git(&root, &["rev-parse", "--verify", "--quiet", &remote_base]).is_ok() {
            remote_base
        } else {
            base
        };
        let range = format!("{base_ref}...HEAD");
        let log_range = format!("{base_ref}..HEAD");
        let commits = git(
            &root,
            &["log", "--no-merges", "--format=- %s%n%b", &log_range],
        )?;
        if commits.trim().is_empty() {
            return Err(format!(
                "La rama no tiene commits nuevos respecto a {base_ref}."
            ));
        }
        let (commits, _) = truncate_chars(&commits, 12_000);
        let (stat, diff) = diff_for_prompt(&root, &[&range])?;
        let context = format!(
            "Commits de la rama:\n{commits}\n\nResumen de archivos:\n{stat}\n\nDiff:\n{diff}"
        );
        let text = ask_claude(
            &root,
            PR_SYSTEM,
            "Escribe el título y la descripción del pull request.",
            context,
        )?;
        Ok(split_draft(&text))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cargo test -p termcode live_commit_message -- --ignored --nocapture`
    #[test]
    #[ignore = "live: calls Claude Code (Haiku)"]
    fn live_commit_message() {
        let dir = std::env::temp_dir().join(format!("termcode-ai-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(
            dir.join("saludo.py"),
            "def saludo(nombre):\n    return f'Hola, {nombre}'\n",
        )
        .unwrap();
        git(&dir, &["add", "."]).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let msg = tauri::async_runtime::block_on(ai_commit_message(root)).expect("mensaje");
        println!("--- mensaje ---\n{msg}\n---------------");
        assert!(!msg.is_empty() && !msg.contains("[Análisis]"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cleans_model_wrappers() {
        assert_eq!(clean("```\nfeat: algo\n```"), "feat: algo");
        assert_eq!(
            clean("```text\nfix: x\n\n- porque y\n```\n"),
            "fix: x\n\n- porque y"
        );
        assert_eq!(clean("  \"Arregla el parser\"  "), "Arregla el parser");
    }

    #[test]
    fn separates_subject_from_body() {
        assert_eq!(
            normalize_commit("Añade x\n- porque y"),
            "Añade x\n\n- porque y"
        );
        assert_eq!(normalize_commit("Añade x\n\n\n- y\n"), "Añade x\n\n- y");
        assert_eq!(normalize_commit("Solo título"), "Solo título");
    }

    #[test]
    fn splits_pr_drafts() {
        let d = split_draft("# Título: Cuotas reales\n\n## Resumen\n- a");
        assert_eq!(d.title, "Cuotas reales");
        assert_eq!(d.body, "## Resumen\n- a");
    }

    #[test]
    fn truncates_on_char_boundaries() {
        let (t, cut) = truncate_chars("ñandú", 3);
        assert_eq!((t.as_str(), cut), ("ñan", true));
        assert_eq!(truncate_chars("abc", 10), ("abc".into(), false));
    }
}
