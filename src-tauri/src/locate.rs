use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Apps opened from Finder or the Start menu don't inherit the terminal's PATH,
/// so also search where installers usually put CLIs.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    if let Some(home) = home() {
        dirs.push(home.join(".local/bin"));
        if cfg!(windows) {
            if let Some(appdata) = std::env::var_os("APPDATA") {
                dirs.push(PathBuf::from(appdata).join("npm"));
            }
        } else {
            dirs.extend([".npm-global/bin", ".volta/bin", ".bun/bin"].map(|dir| home.join(dir)));
        }
    }
    if !cfg!(windows) {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    dirs
}

/// PATH for helper processes, so npm-installed CLIs can find `node`.
pub(crate) fn child_path() -> Option<OsString> {
    std::env::join_paths(search_dirs()).ok()
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// Finds a CLI from an override variable, the search dirs, or the newest
/// VS Code extension whose folder starts with `extension_prefix`.
pub(crate) fn find(
    variable: &str,
    name: &str,
    extension_prefix: &str,
    in_extension: impl Fn(&Path, &str) -> Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(variable) {
        return Some(path.into());
    }
    let mut names = vec![executable_name(name)];
    if cfg!(windows) {
        names.push(format!("{name}.cmd"));
    }
    if let Some(path) = search_dirs()
        .iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
    {
        return Some(path);
    }
    let binary = executable_name(name);
    let mut candidates: Vec<_> = std::fs::read_dir(home()?.join(".vscode/extensions"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(extension_prefix)
        })
        .filter_map(|entry| {
            let path = in_extension(&entry.path(), &binary)?;
            Some((path.metadata().ok()?.modified().ok()?, path))
        })
        .collect();
    candidates.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    candidates.into_iter().next().map(|(_, path)| path)
}

/// Extensions may bundle binaries for several platforms, e.g. `bin/windows-x86_64`.
pub(crate) fn platform_dir(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let os: &[&str] = match std::env::consts::OS {
        "windows" => &["windows", "win32"],
        "macos" => &["macos", "darwin"],
        _ => &["linux"],
    };
    let arch: &[&str] = match std::env::consts::ARCH {
        "aarch64" => &["aarch64", "arm64"],
        _ => &["x86_64", "x64"],
    };
    os.iter().any(|token| name.contains(token)) && arch.iter().any(|token| name.contains(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_dirs_match_only_this_machine() {
        let own = format!(
            "{}-{}",
            if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" },
            std::env::consts::ARCH
        );
        assert!(platform_dir(&own));
        assert!(!platform_dir("plan9-sparc"));
        if cfg!(windows) {
            assert!(!platform_dir("linux-x86_64"));
        }
    }
}
