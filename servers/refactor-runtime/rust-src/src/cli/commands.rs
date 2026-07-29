use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "refactor-runtime", version, about = "Codebase refactoring runtime — scan, move, analyze, impact")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Scan a codebase and report structure
    Scan {
        /// Path to the project root
        path: PathBuf,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Move a file and rewrite all imports
    Move {
        /// Source file path
        old_path: PathBuf,

        /// Destination file path
        new_path: PathBuf,

        /// Preview only — don't write changes
        #[arg(long)]
        dry_run: bool,

        /// Bulk moves from JSON manifest
        #[arg(long)]
        manifest: Option<PathBuf>,

        /// Directory for audit log output
        #[arg(long)]
        audit_log: Option<PathBuf>,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Analyze dependency graph
    Analyze {
        /// Path to the project root
        path: PathBuf,

        /// Check for circular dependencies
        #[arg(long)]
        circular: bool,

        /// Find orphaned modules
        #[arg(long)]
        orphans: bool,

        /// Max traversal depth
        #[arg(long)]
        depth: Option<usize>,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Analyze impact of changes in a file
    Impact {
        /// File to analyze
        file: PathBuf,

        /// Compare against git commit
        #[arg(long)]
        since: Option<String>,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,

        /// Apply mechanical fixes automatically
        #[arg(long)]
        auto_fix: bool,

        /// Output task list for remaining changes
        #[arg(long)]
        generate_tasks: bool,
    },

    /// Rollback a previous operation using audit log
    Rollback {
        /// Path to the audit log file
        audit_log: PathBuf,

        /// Preview only — don't apply rollback
        #[arg(long)]
        dry_run: bool,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Delete a file and auto-clean all imports
    Delete {
        /// File to delete
        file: PathBuf,

        /// Preview only
        #[arg(long)]
        dry_run: bool,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Rename an exported symbol across the codebase
    Rename {
        /// File containing the export
        file: PathBuf,

        /// Current name
        old_name: String,

        /// New name
        new_name: String,

        /// Preview only
        #[arg(long)]
        dry_run: bool,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Find unreachable dead code
    DeadCode {
        /// Project root
        path: PathBuf,

        /// Entry point files
        #[arg(long)]
        entry_points: Vec<PathBuf>,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Detect UI issues in React/JSX components
    UiAudit {
        /// Project root
        path: PathBuf,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Find unused npm dependencies
    DepsAudit {
        /// Project root
        path: PathBuf,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Detect env variable drift
    EnvAudit {
        /// Project root
        path: PathBuf,

        /// Env files to check
        #[arg(long)]
        env_files: Vec<PathBuf>,

        /// Output format
        #[arg(long, default_value = "table")]
        output: OutputFormat,
    },

    /// Run as persistent JSON-line server (stdin/stdout protocol)
    Serve {
        /// Path to the project root
        path: PathBuf,
    },
}

#[derive(Debug, Clone, clap::ValueEnum)]
pub enum OutputFormat {
    Table,
    Json,
    Csv,
    Dot,
}
