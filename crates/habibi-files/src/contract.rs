//! `src/contracts/file-tools.ts`: the JSON the UI receives.

use std::path::PathBuf;

use serde::Serialize;

pub const FILE_TASKS: &[&str] = &["rename", "organize", "storage", "duplicates", "pdf", "compress", "extract", "find"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileGrant {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub directory: bool,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub grant_id: String,
    /// Always `/`-separated, on every OS, so model destinations match it.
    pub relative: String,
    pub path: PathBuf,
    pub size: u64,
    /// `mtimeMs`.
    pub modified: f64,
    pub device: u64,
    pub inode: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Move,
    Trash,
    Image,
    Pdf,
    Csv,
}

impl ChangeKind {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "move" => Self::Move,
            "trash" => Self::Trash,
            "image" => Self::Image,
            "pdf" => Self::Pdf,
            "csv" => Self::Csv,
            _ => return None,
        })
    }

    /// Conversions produce a new file through the preview path.
    pub fn is_conversion(self) -> bool {
        matches!(self, Self::Image | Self::Pdf | Self::Csv)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PagePick {
    pub source: String,
    pub page: i64,
    pub rotate: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub kind: ChangeKind,
    pub sources: Vec<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<Vec<PagePick>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csv: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub file_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlanStatus {
    Preview,
    Applied,
    Undone,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub changes: Vec<FileChange>,
    pub findings: Vec<Finding>,
    pub summary: String,
    pub id: String,
    pub task: String,
    pub entries: Vec<FileEntry>,
    pub cleanup: bool,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: PlanStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<Vec<PathBuf>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl FilePlan {
    pub fn entry(&self, id: &str) -> Option<&FileEntry> {
        self.entries.iter().find(|entry| entry.id == id)
    }
}

/// A generated output waiting in the private preview folder.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub index: usize,
    pub path: PathBuf,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub target_met: bool,
}
