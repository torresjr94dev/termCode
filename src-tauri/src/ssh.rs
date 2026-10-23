//! Servidores de tu `~/.ssh/config`, para conectarte en una pestaña con un
//! clic. Solo se leen los alias concretos (sin comodines) y lo necesario para
//! mostrarlos; la conexión la hace `ssh` con tu configuración, tus llaves y tu
//! agente. termCode nunca ve ni guarda contraseñas.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    /// El alias de `Host` (lo que se pasa a `ssh`).
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
}

/// Alias seguros para una línea de comandos: nada que `ssh` lea como opción.
fn is_safe_alias(alias: &str) -> bool {
    !alias.is_empty()
        && alias.len() <= 255
        && !alias.starts_with('-')
        && alias
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | ':'))
}

/// `Host` concretos del archivo, en orden, sin repetir. Los patrones (`*`,
/// `?`, `!`) configuran a otros hosts: no son servidores a los que ir.
pub fn parse_config(text: &str) -> Vec<SshHost> {
    let mut hosts: Vec<SshHost> = Vec::new();
    // Índices de los hosts del bloque `Host` en curso (un bloque puede nombrar varios).
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (
                k.to_ascii_lowercase(),
                v.trim().trim_start_matches('=').trim(),
            ),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace().map(|a| a.trim_matches('"')) {
                    if alias.contains(['*', '?', '!']) || !is_safe_alias(alias) {
                        continue;
                    }
                    let index = match hosts.iter().position(|h| h.alias == alias) {
                        Some(i) => i,
                        None => {
                            hosts.push(SshHost {
                                alias: alias.to_owned(),
                                ..SshHost::default()
                            });
                            hosts.len() - 1
                        }
                    };
                    current.push(index);
                }
            }
            // Un `Match` cierra el bloque de `Host` anterior.
            "match" => current.clear(),
            "hostname" | "user" | "port" => {
                let value = value.trim_matches('"');
                for &i in &current {
                    let host = &mut hosts[i];
                    // Como ssh: el primer valor que aparece es el que cuenta.
                    match key.as_str() {
                        "hostname" if host.host_name.is_none() => {
                            host.host_name = Some(value.to_owned())
                        }
                        "user" if host.user.is_none() => host.user = Some(value.to_owned()),
                        "port" if host.port.is_none() => host.port = value.parse().ok(),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    hosts
}

fn read_hosts(home: &Path) -> Vec<SshHost> {
    std::fs::read_to_string(home.join(".ssh").join("config"))
        .map(|text| parse_config(&text))
        .unwrap_or_default()
}

/// Los `Host` de `~/.ssh/config` (vacío si no hay archivo).
#[tauri::command]
pub async fn ssh_hosts() -> Vec<SshHost> {
    tauri::async_runtime::spawn_blocking(|| {
        dirs::home_dir()
            .map(|home| read_hosts(&home))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_concrete_hosts_with_their_details() {
        let config = "\
# servidores
Host prod web-1
  HostName 10.0.0.5
  User deploy
  Port 2222

Host *.interno !bastion
  User nadie

Host dev
  HostName=dev.ejemplo.mx
  User yo
  User otro

Match host prod
  User ignorado
";
        let hosts = parse_config(config);
        assert_eq!(
            hosts.iter().map(|h| h.alias.as_str()).collect::<Vec<_>>(),
            vec!["prod", "web-1", "dev"]
        );
        assert_eq!(hosts[0].host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(hosts[1].user.as_deref(), Some("deploy"));
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[2].host_name.as_deref(), Some("dev.ejemplo.mx"));
        assert_eq!(hosts[2].user.as_deref(), Some("yo"), "el primer User manda");
    }

    #[test]
    fn never_lists_something_ssh_would_read_as_an_option() {
        let hosts = parse_config("Host -oProxyCommand=evil ok\n");
        assert_eq!(
            hosts.iter().map(|h| h.alias.as_str()).collect::<Vec<_>>(),
            vec!["ok"]
        );
        assert!(!is_safe_alias("a b"));
        assert!(!is_safe_alias("a;b"));
        assert!(is_safe_alias("deploy@web-1.ejemplo.mx"));
    }
}
