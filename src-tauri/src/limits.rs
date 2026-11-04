//! A build with fewer features (docs/LIMITS.md), set when it is built by
//! environment variables. The frontend reads the same ones (src/lib/limits.ts,
//! vite.config.ts `envPrefix`). Unset, the build has everything.
//!
//! - `STOCKROOM_KINDS`: the kinds it handles, e.g. `image` or `image,video`.
//!   Files of other kinds are skipped like an unsupported type.
//! - `STOCKROOM_NO_CONNECT`: no browser extension and no Claude connection;
//!   their ports are never opened.
//! - `STOCKROOM_NO_UPDATE`: no in-app updates (the updater isn't loaded).
//!
//! Not a limit, but set the same way: `STOCKROOM_TAG_PREFIX`, what this
//! build's release tags start with before `v<version>` (e.g. `corp-`).

use crate::db::Kind;
use crate::{files, formats, texts, videos};

const KINDS: Option<&str> = option_env!("STOCKROOM_KINDS");

/// Set and not empty or "0".
const fn on(v: Option<&str>) -> bool {
    match v {
        Some(s) => !s.is_empty() && !matches!(s.as_bytes(), b"0"),
        None => false,
    }
}

/// No browser extension and no Claude connection.
pub const NO_CONNECT: bool = on(option_env!("STOCKROOM_NO_CONNECT"));

/// No in-app updates.
pub const NO_UPDATE: bool = on(option_env!("STOCKROOM_NO_UPDATE"));

/// What this build's release tags start with before `v<version>`
/// (`STOCKROOM_TAG_PREFIX`, e.g. `corp-` for `corp-v1.2.3`). Empty = `v1.2.3`.
pub const TAG_PREFIX: &str = match option_env!("STOCKROOM_TAG_PREFIX") {
    Some(p) => p,
    None => "",
};

/// Why something this build leaves out was refused.
pub const LEFT_OUT: &str = "このビルドでは使えません";

/// Whether a kind list (`STOCKROOM_KINDS`) has `kind`; none or empty = every kind.
fn listed(list: Option<&str>, kind: Kind) -> bool {
    match list.map(str::trim).filter(|l| !l.is_empty()) {
        None => true,
        Some(l) => l.split(',').any(|k| k.trim() == kind.as_str()),
    }
}

/// The build handles `kind`.
pub fn has(kind: Kind) -> bool {
    listed(KINDS, kind)
}

/// The kind of files of this type (one of `formats::SUPPORTED_EXTS`).
fn kind_of_ext(ext: &str) -> Option<Kind> {
    if formats::is_image(ext) {
        Some(Kind::Image)
    } else if files::is_file(ext) {
        Some(Kind::File)
    } else if texts::is_text(ext) {
        Some(Kind::Text)
    } else if videos::is_video(ext) {
        Some(Kind::Video)
    } else {
        None
    }
}

/// Files of this type can be added.
pub fn accepts(ext: &str) -> bool {
    KINDS.is_none() || kind_of_ext(ext).is_some_and(has)
}

/// Errors with `LEFT_OUT` unless the build handles `kind`.
pub fn require_kind(kind: Kind) -> Result<(), String> {
    if has(kind) {
        Ok(())
    } else {
        Err(LEFT_OUT.into())
    }
}

/// Errors with `LEFT_OUT` in a build without the extension and Claude.
pub fn require_connect() -> Result<(), String> {
    if NO_CONNECT {
        Err(LEFT_OUT.into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_list_names_the_kinds() {
        assert!(listed(None, Kind::Bookmark));
        assert!(listed(Some(""), Kind::Bookmark));
        assert!(listed(Some("image, video"), Kind::Video));
        assert!(listed(Some("image"), Kind::Image));
        assert!(!listed(Some("image"), Kind::Bookmark));
        assert!(!listed(Some("font"), Kind::Image), "an unknown kind (fonts have their own app)");
        assert!(!listed(Some("image,video"), Kind::Text));
    }

    #[test]
    fn every_supported_type_has_a_kind() {
        for e in formats::SUPPORTED_EXTS {
            assert!(kind_of_ext(e).is_some(), "{e}");
        }
        assert_eq!(kind_of_ext("heic"), Some(Kind::Image));
        assert_eq!(kind_of_ext("woff2"), None, "fonts have their own app (docs/FONT_APP.md)");
        assert_eq!(kind_of_ext("mov"), Some(Kind::Video));
    }

    #[test]
    fn flags_are_on_when_set_to_something() {
        assert!(!on(None));
        assert!(!on(Some("")));
        assert!(!on(Some("0")));
        assert!(on(Some("1")));
    }
}
