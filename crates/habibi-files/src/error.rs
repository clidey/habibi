use std::fmt;

/// Shown for anything that is not a deliberate, user-safe file-tools message
/// (an `io::Error`, a parse failure, …). Raw errors never reach the UI.
pub const ACCESS_ERROR: &str = "The selected files could not be accessed. Check permissions and try again.";

/// What the Swift helper failure looked like to the Node service.
pub const PROCESS_ERROR: &str = "This PDF or image could not be processed. Check that it is readable and unlocked.";

/// `FileToolsError` from the Node service: `User` carries a fixed message
/// that is safe to show; `Access` is every other failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileError {
    User(String),
    Access,
}

impl FileError {
    pub fn user(message: impl Into<String>) -> Self {
        Self::User(message.into())
    }

    pub fn message(&self) -> &str {
        match self {
            Self::User(message) => message,
            Self::Access => ACCESS_ERROR,
        }
    }
}

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for FileError {}

impl From<std::io::Error> for FileError {
    fn from(_: std::io::Error) -> Self {
        Self::Access
    }
}

pub type FileResult<T> = Result<T, FileError>;

/// Shorthand for `Err(FileError::User(..))`.
pub(crate) fn fail<T>(message: &str) -> FileResult<T> {
    Err(FileError::user(message))
}
