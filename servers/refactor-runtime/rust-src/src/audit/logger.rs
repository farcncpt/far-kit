use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use crate::core::types::AuditEntry;

pub struct AuditLogger {
    log_dir: PathBuf,
    session_id: String,
    entries: Vec<AuditEntry>,
}

impl AuditLogger {
    pub fn new(log_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(log_dir)
            .with_context(|| format!("Failed to create audit log directory: {}", log_dir.display()))?;

        let session_id = uuid::Uuid::new_v4().to_string();

        Ok(Self {
            log_dir: log_dir.to_path_buf(),
            session_id,
            entries: Vec::new(),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn log(&mut self, entry: AuditEntry) -> Result<()> {
        self.entries.push(entry);
        Ok(())
    }

    /// Flush all entries to a JSON file.
    pub fn flush(&self) -> Result<PathBuf> {
        let filename = format!("audit-{}.json", self.session_id);
        let path = self.log_dir.join(&filename);

        let json = serde_json::to_string_pretty(&self.entries)
            .context("Failed to serialize audit log")?;
        std::fs::write(&path, json)
            .with_context(|| format!("Failed to write audit log: {}", path.display()))?;

        Ok(path)
    }

    /// Flush entries to CSV format.
    pub fn flush_csv(&self) -> Result<PathBuf> {
        let filename = format!("audit-{}.csv", self.session_id);
        let path = self.log_dir.join(&filename);

        let mut wtr = csv::Writer::from_path(&path)
            .with_context(|| format!("Failed to create CSV writer: {}", path.display()))?;

        wtr.write_record(["timestamp", "operation", "file", "old_content", "new_content", "line", "rollbackable"])?;

        for entry in &self.entries {
            wtr.write_record([
                &entry.timestamp,
                &format!("{:?}", entry.operation),
                &entry.file.to_string_lossy().to_string(),
                &entry.old_content,
                &entry.new_content,
                &entry.line.to_string(),
                &entry.rollbackable.to_string(),
            ])?;
        }

        wtr.flush()?;
        Ok(path)
    }

    pub fn entries(&self) -> &[AuditEntry] {
        &self.entries
    }
}

/// Load an audit log from a JSON file.
pub fn load_audit_log(path: &Path) -> Result<Vec<AuditEntry>> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read audit log: {}", path.display()))?;
    let entries: Vec<AuditEntry> = serde_json::from_str(&content)
        .context("Failed to parse audit log")?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::AuditOperation;
    use tempfile::TempDir;

    #[test]
    fn test_audit_logger() {
        let dir = TempDir::new().unwrap();
        let mut logger = AuditLogger::new(dir.path()).unwrap();

        logger.log(AuditEntry {
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            operation: AuditOperation::Rewrite,
            file: PathBuf::from("/test.ts"),
            old_content: "../lib/utils".to_string(),
            new_content: "../../shared/utils".to_string(),
            line: 1,
            rollbackable: true,
        }).unwrap();

        let path = logger.flush().unwrap();
        assert!(path.exists());

        let loaded = load_audit_log(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].old_content, "../lib/utils");
    }

    #[test]
    fn test_audit_csv() {
        let dir = TempDir::new().unwrap();
        let mut logger = AuditLogger::new(dir.path()).unwrap();

        logger.log(AuditEntry {
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            operation: AuditOperation::Move,
            file: PathBuf::from("/old.ts"),
            old_content: "/old.ts".to_string(),
            new_content: "/new.ts".to_string(),
            line: 0,
            rollbackable: true,
        }).unwrap();

        let path = logger.flush_csv().unwrap();
        assert!(path.exists());
    }
}
