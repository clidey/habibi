//! The WhatsApp component on Windows and Linux: a `.tar.gz` release asset
//! verified against a SHA-256 compiled into this build, then installed
//! atomically.
//!
//! There is no OS-level signature to check on these platforms, so the trust
//! anchor is the digest the release workflow computes from the component it
//! just built and passes to this build as `HABIBI_WHATSAPP_COMPONENT_SHA256`
//! (`.github/workflows/release.yml`). A digest published next to the archive
//! would be worth nothing: whoever can replace the archive can replace it too.
//! A build without a pinned digest (local and development builds) never
//! downloads the component.
//!
//! The module is compiled on every OS so its checks are tested everywhere;
//! only Windows and Linux use it at runtime.
#![cfg_attr(target_os = "macos", allow(dead_code))]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};

use super::download::{MAX_ARCHIVE_BYTES, place, valid_archive_listing};
use super::{Layout, component_name, component_parts};

/// Written into an installed component with the digest of the archive it
/// came from, so a later launch can tell it was installed by this check.
pub const MARKER: &str = ".habibi-archive-sha256";

/// The component digest pinned into this build, if any.
pub fn pinned_digest() -> Option<String> {
    option_env!("HABIBI_WHATSAPP_COMPONENT_SHA256").and_then(normalize_digest)
}

/// A lowercase 64-digit hex SHA-256, or `None` for anything else.
pub fn normalize_digest(value: &str) -> Option<String> {
    let value = value.trim();
    (value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())).then(|| value.to_ascii_lowercase())
}

/// Lowercase hex SHA-256 of a file's contents.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The system `tar`, by absolute path so a writable `PATH` entry cannot
/// stand in for it. Windows 10 1803+ ships bsdtar as `System32\tar.exe`.
pub fn tar_program() -> PathBuf {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        return root.join("System32").join("tar.exe");
    }
    ["/usr/bin/tar", "/bin/tar"].into_iter().map(PathBuf::from).find(|path| path.is_file()).unwrap_or_else(|| "/usr/bin/tar".into())
}

fn tar(arguments: &[&std::ffi::OsStr]) -> Option<String> {
    let mut command = Command::new(tar_program());
    command.args(arguments).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `Ok` when `component` was installed from the archive with `expected`
/// digest and still has everything OpenWA needs to start.
pub fn verify_installed(component: &Path, expected: Option<&str>) -> Result<(), String> {
    let recorded = std::fs::read_to_string(component.join(MARKER)).ok();
    let matches = matches!((recorded.as_deref().and_then(normalize_digest), expected), (Some(recorded), Some(expected)) if recorded == expected);
    if !matches || !component_parts(component).complete() {
        return Err("The installed WhatsApp component does not match this Habibi build.".into());
    }
    Ok(())
}

/// Check the digest, validate, unpack and atomically install a downloaded
/// archive. Nothing is unpacked unless the digest matches.
pub fn install_archive(archive: &Path, layout: &Layout) -> Result<PathBuf, String> {
    let Some(expected) = layout.component_sha256.as_deref().and_then(normalize_digest) else {
        return Err(NOT_AVAILABLE.into());
    };
    let size = std::fs::metadata(archive).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err("The WhatsApp download had an unexpected size.".into());
    }
    match sha256_file(archive) {
        Ok(actual) if actual == expected => {}
        _ => return Err("The WhatsApp download could not be verified. Try again.".into()),
    }
    let listing = tar(&["-t".as_ref(), "-z".as_ref(), "-f".as_ref(), archive.as_os_str()])
        .ok_or_else(|| "The WhatsApp download was not a valid archive.".to_string())?;
    // bsdtar on Windows may end lines with CRLF.
    let listing = listing.replace("\r\n", "\n");
    if !valid_archive_listing(&listing) {
        return Err("The WhatsApp archive contained unexpected files.".into());
    }
    // Unpack next to the install location, not in the temp directory: /tmp
    // is often a separate filesystem on Linux, where the final rename fails.
    let extraction = layout.components_dir.join(format!(".extract-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        std::fs::create_dir_all(&extraction).map_err(|_| "Could not create a temporary install directory.".to_string())?;
        tar(&["-x".as_ref(), "-z".as_ref(), "-f".as_ref(), archive.as_os_str(), "-C".as_ref(), extraction.as_os_str()])
            .ok_or_else(|| "Could not unpack the WhatsApp component.".to_string())?;
        let extracted = extraction.join(component_name());
        if !extracted.is_dir() || !component_parts(&extracted).complete() {
            return Err("The WhatsApp component was missing from its archive.".to_string());
        }
        crate::util::write_private(&extracted.join(MARKER), expected.as_bytes())
            .map_err(|_| "Could not install the verified WhatsApp component.".to_string())?;
        let final_component =
            layout.installed_component().ok_or_else(|| "Could not resolve the component install location.".to_string())?;
        place(&extracted, &final_component)?;
        Ok(final_component)
    })();
    let _ = std::fs::remove_dir_all(&extraction);
    result
}

pub const NOT_AVAILABLE: &str = "WhatsApp support is not available for this Habibi build.";

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(root: &Path, digest: Option<String>) -> Layout {
        Layout {
            state_root: root.join("state"),
            bundled_root: root.join("app").join("openwa"),
            components_dir: root.join("state").join("components").join("whatsapp"),
            node: None,
            supervisor: None,
            version: "1.2.3".into(),
            component_sha256: digest,
        }
    }

    /// A complete component directory named `name` under `parent`.
    fn write_component(parent: &Path, name: &str) -> PathBuf {
        let component = parent.join(name);
        let parts = component_parts(&component);
        std::fs::create_dir_all(parts.openwa.join("dist")).unwrap();
        std::fs::write(parts.openwa.join("dist").join("main.js"), "").unwrap();
        std::fs::create_dir_all(parts.node.parent().unwrap()).unwrap();
        std::fs::write(&parts.node, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&parts.node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::create_dir_all(parts.supervisor.parent().unwrap()).unwrap();
        std::fs::write(&parts.supervisor, "").unwrap();
        component
    }

    /// `tar -czf <dest> -C <source> <entries…>` with the same tar the runtime uses.
    fn pack(source: &Path, entries: &[&str], dest: &Path) {
        let mut arguments: Vec<&std::ffi::OsStr> =
            vec!["-c".as_ref(), "-z".as_ref(), "-f".as_ref(), dest.as_os_str(), "-C".as_ref(), source.as_os_str()];
        arguments.extend(entries.iter().map(std::ffi::OsStr::new));
        assert!(tar(&arguments).is_some(), "tar could not create the test archive");
    }

    fn good_archive(root: &Path) -> (PathBuf, String) {
        let source = root.join("source");
        write_component(&source, component_name());
        let archive = root.join("component.tar.gz");
        pack(&source, &[component_name()], &archive);
        let digest = sha256_file(&archive).unwrap();
        (archive, digest)
    }

    #[test]
    fn digests_must_be_well_formed() {
        let digest = "A".repeat(64);
        assert_eq!(normalize_digest(&format!(" {digest}\n")), Some("a".repeat(64)));
        assert_eq!(normalize_digest(&"a".repeat(63)), None);
        assert_eq!(normalize_digest(&"g".repeat(64)), None);
        assert_eq!(normalize_digest(""), None);
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("abc");
        std::fs::write(&file, "abc").unwrap();
        assert_eq!(sha256_file(&file).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn a_build_without_a_pinned_digest_installs_nothing() {
        let root = tempfile::tempdir().unwrap();
        let (archive, _) = good_archive(root.path());
        for digest in [None, Some("not-a-digest".to_string())] {
            let layout = layout(root.path(), digest);
            assert_eq!(install_archive(&archive, &layout).unwrap_err(), NOT_AVAILABLE);
            assert!(!layout.components_dir.exists());
        }
    }

    #[test]
    fn an_archive_with_the_wrong_digest_is_never_unpacked() {
        let root = tempfile::tempdir().unwrap();
        let (archive, digest) = good_archive(root.path());
        let other = format!("{}0", &digest[..63]);
        let other = if other == digest { format!("{}1", &digest[..63]) } else { other };
        let layout = layout(root.path(), Some(other));
        assert_eq!(install_archive(&archive, &layout).unwrap_err(), "The WhatsApp download could not be verified. Try again.");
        assert!(!layout.components_dir.exists(), "nothing is unpacked before the digest matches");
    }

    #[test]
    fn a_verified_archive_is_installed_with_its_marker() {
        let root = tempfile::tempdir().unwrap();
        let (archive, digest) = good_archive(root.path());
        let layout = layout(root.path(), Some(digest.to_uppercase()));
        let installed = install_archive(&archive, &layout).unwrap();
        assert_eq!(installed, layout.installed_component().unwrap());
        assert!(component_parts(&installed).complete());
        assert_eq!(std::fs::read_to_string(installed.join(MARKER)).unwrap(), digest);
        assert_eq!(verify_installed(&installed, Some(&digest)), Ok(()));
        // Only the installed version remains; no extraction or staging leftovers.
        let names: Vec<String> = std::fs::read_dir(&layout.components_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["1.2.3".to_string()]);
    }

    #[test]
    fn installed_components_must_carry_this_builds_digest_and_be_complete() {
        let root = tempfile::tempdir().unwrap();
        let digest = "a".repeat(64);
        let component = write_component(root.path(), component_name());
        assert!(verify_installed(&component, Some(&digest)).is_err(), "a hand-placed component has no marker");
        std::fs::write(component.join(MARKER), "b".repeat(64)).unwrap();
        assert!(verify_installed(&component, Some(&digest)).is_err(), "a component from another build");
        std::fs::write(component.join(MARKER), &digest).unwrap();
        assert!(verify_installed(&component, None).is_err(), "a build without a pinned digest trusts nothing");
        assert_eq!(verify_installed(&component, Some(&digest)), Ok(()));
        std::fs::remove_file(component_parts(&component).node).unwrap();
        assert!(verify_installed(&component, Some(&digest)).is_err(), "an incomplete component");
    }

    #[test]
    fn verified_archives_may_still_only_contain_a_complete_component() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        write_component(&source, component_name());
        std::fs::create_dir_all(source.join("stray")).unwrap();
        std::fs::write(source.join("stray").join("file"), "").unwrap();
        let archive = root.path().join("stray.tar.gz");
        pack(&source, &[component_name(), "stray"], &archive);
        let layout_with = |archive: &Path| layout(root.path(), Some(sha256_file(archive).unwrap()));
        assert_eq!(
            install_archive(&archive, &layout_with(&archive)).unwrap_err(),
            "The WhatsApp archive contained unexpected files."
        );

        let partial = root.path().join("partial");
        let component = write_component(&partial, component_name());
        std::fs::remove_file(component_parts(&component).supervisor).unwrap();
        let archive = root.path().join("partial.tar.gz");
        pack(&partial, &[component_name()], &archive);
        let layout = layout_with(&archive);
        assert_eq!(install_archive(&archive, &layout).unwrap_err(), "The WhatsApp component was missing from its archive.");
        assert!(!layout.installed_component().unwrap().exists());
        assert!(std::fs::read_dir(&layout.components_dir).unwrap().next().is_none(), "the extraction is removed");

        let garbage = root.path().join("garbage.tar.gz");
        std::fs::write(&garbage, "not an archive").unwrap();
        assert_eq!(
            install_archive(&garbage, &layout_with(&garbage)).unwrap_err(),
            "The WhatsApp download was not a valid archive."
        );
    }
}
