use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    TypeScript,
    JavaScript,
    Css,
}

impl Language {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "ts" | "tsx" | "mts" | "cts" => Some(Language::TypeScript),
            "js" | "jsx" | "mjs" | "cjs" => Some(Language::JavaScript),
            "css" | "scss" | "sass" | "less" => Some(Language::Css),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: PathBuf,
    pub relative_path: String,
    pub imports: Vec<ImportInfo>,
    pub exports: Vec<ExportInfo>,
    pub language: Language,
    // Optional enrichment fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_usages: Option<Vec<SymbolUsage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jsx_elements: Option<Vec<JSXElementInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_references: Option<Vec<EnvReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_sites: Option<Vec<CallSiteInfo>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportType {
    Static,
    Dynamic,
    Require,
    Css,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportInfo {
    pub source: String,
    pub resolved_path: Option<PathBuf>,
    pub specifiers: Vec<ImportSpecifier>,
    #[serde(rename = "type")]
    pub import_type: ImportType,
    pub is_type_only: bool,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSpecifier {
    pub name: String,
    pub alias: Option<String>,
    pub is_default: bool,
    pub is_namespace: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportType {
    Function,
    Class,
    Variable,
    Type,
    Interface,
    Enum,
    ReExport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub export_type: ExportType,
    pub is_default: bool,
    pub signature: Option<FunctionSignature>,
    pub line: usize,
    pub re_export_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionSignature {
    pub name: String,
    pub params: Vec<ParamInfo>,
    pub return_type: String,
    pub is_async: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
    pub optional: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveOperation {
    pub old_path: PathBuf,
    pub new_path: PathBuf,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveManifest {
    pub moves: Vec<MoveOperation>,
    pub project_root: PathBuf,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveResult {
    pub operation: MoveOperation,
    pub affected_files: Vec<AffectedFile>,
    pub total_files_updated: usize,
    pub route_changes: Vec<RouteChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteChange {
    pub file: PathBuf,
    pub line: usize,
    pub old_route: String,
    pub new_route: String,
    pub context: String,
    pub applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderMoveResult {
    pub old_dir: PathBuf,
    pub new_dir: PathBuf,
    pub files_moved: usize,
    pub operations: Vec<MoveOperation>,
    pub results: Vec<MoveResult>,
    pub route_changes: Vec<RouteChange>,
    pub total_files_updated: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AffectedFile {
    pub path: PathBuf,
    pub old_import: String,
    pub new_import: String,
    pub line: usize,
    pub applied: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeType {
    ParamAddedRequired,
    ParamAddedOptional,
    ParamRemoved,
    ParamTypeChanged,
    ReturnTypeChanged,
    ReturnTypeWidened,
    ReturnTypeNarrowed,
    Renamed,
    Removed,
    InterfaceFieldAdded,
    InterfaceFieldRemoved,
    InterfaceFieldChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeInfo {
    pub file: PathBuf,
    pub entity: String,
    pub change_type: ChangeType,
    pub old_signature: Option<String>,
    pub new_signature: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Classification {
    MechanicalAuto,
    MechanicalConfirm,
    LogicSimple,
    LogicComplex,
    Architectural,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CascadeEffect {
    pub file: PathBuf,
    pub line: usize,
    pub depth: usize,
    pub classification: Classification,
    pub description: String,
    pub calling_code: String,
    pub suggested_fix: Option<String>,
    pub auto_fixable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImpactReport {
    pub change: ChangeInfo,
    pub effects: Vec<CascadeEffect>,
    pub auto_fixed: usize,
    pub needs_review: usize,
    pub tasks: Vec<TaskItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskItem {
    pub id: String,
    pub file: PathBuf,
    pub line: usize,
    pub severity: Severity,
    pub classification: Classification,
    pub description: String,
    pub context: TaskContext,
    pub cascade_depth: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskContext {
    pub changed_entity: String,
    pub change_type: ChangeType,
    pub calling_code: String,
    pub suggested_approach: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOperation {
    Move,
    Rewrite,
    AutoFix,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub timestamp: String,
    pub operation: AuditOperation,
    pub file: PathBuf,
    pub old_content: String,
    pub new_content: String,
    pub line: usize,
    pub rollbackable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub project_root: PathBuf,
    pub files: Vec<FileInfo>,
    pub total_files: usize,
    pub files_by_language: HashMap<String, usize>,
    pub total_imports: usize,
    pub total_exports: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectConfig {
    pub project_root: PathBuf,
    pub path_aliases: HashMap<String, Vec<String>>,
    pub base_url: Option<String>,
    pub exclude_patterns: Vec<String>,
}

// ============================================================
// Parser Enrichment Types
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolUsageType {
    Reference,
    Call,
    TypeReference,
    JsxComponent,
    PropertyAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolUsage {
    pub name: String,
    #[serde(rename = "type")]
    pub usage_type: SymbolUsageType,
    pub line: usize,
    pub column: usize,
    pub is_write: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropValueType {
    Expression,
    Literal,
    Spread,
    Shorthand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JSXPropInfo {
    pub name: String,
    pub has_value: bool,
    pub is_event_handler: bool,
    pub value_type: PropValueType,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JSXElementInfo {
    pub tag_name: String,
    pub props: Vec<JSXPropInfo>,
    pub has_children: bool,
    pub line: usize,
    pub is_component: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvAccessPattern {
    ProcessEnv,
    ImportMetaEnv,
    DenoEnv,
    Dotenv,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvReference {
    pub variable: String,
    pub access_pattern: EnvAccessPattern,
    pub line: usize,
    pub has_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallSiteInfo {
    pub callee: String,
    pub arguments: usize,
    pub line: usize,
    pub is_chained: bool,
    pub receiver: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Enrichments {
    pub symbol_usages: bool,
    pub jsx_elements: bool,
    pub env_references: bool,
    pub call_sites: bool,
}

impl Enrichments {
    pub fn all() -> Self {
        Self {
            symbol_usages: true,
            jsx_elements: true,
            env_references: true,
            call_sites: true,
        }
    }

    pub fn none() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Default)]
pub struct EnrichmentData {
    pub symbol_usages: Option<Vec<SymbolUsage>>,
    pub jsx_elements: Option<Vec<JSXElementInfo>>,
    pub env_references: Option<Vec<EnvReference>>,
    pub call_sites: Option<Vec<CallSiteInfo>>,
}

// ============================================================
// Delete Operation
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteResult {
    pub target_file: PathBuf,
    pub affected_files: Vec<DeleteAffectedFile>,
    pub re_export_breaks: Vec<ReExportBreak>,
    pub total_imports_removed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteAffectedFile {
    pub path: PathBuf,
    pub imports_to_remove: Vec<ImportRemoval>,
    pub applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportRemoval {
    pub line: usize,
    pub specifier: String,
    pub full_line_removal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReExportBreak {
    pub file: PathBuf,
    pub symbol: String,
    pub line: usize,
}

// ============================================================
// Rename Operation
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameResult {
    pub old_name: String,
    pub new_name: String,
    pub source_file: PathBuf,
    pub affected_files: Vec<RenameAffectedFile>,
    pub dynamic_access_warnings: Vec<DynamicAccessWarning>,
    pub total_rewrites: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameAffectedFile {
    pub path: PathBuf,
    pub rewrites: Vec<RenameRewrite>,
    pub applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameRewrite {
    pub line: usize,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicAccessWarning {
    pub file: PathBuf,
    pub line: usize,
    pub context: String,
}

// ============================================================
// Dead Code Analysis
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeadCodeConfidence {
    Definite,
    Possible,
    SideEffect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeadCodeResult {
    pub entry_points: Vec<PathBuf>,
    pub reachable_files: usize,
    pub dead_files: Vec<DeadFileInfo>,
    pub dead_exports: Vec<DeadExportInfo>,
    pub total_dead_lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeadFileInfo {
    pub path: PathBuf,
    pub confidence: DeadCodeConfidence,
    pub reason: String,
    pub line_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeadExportInfo {
    pub file: PathBuf,
    pub export_name: String,
    pub line: usize,
    pub confidence: DeadCodeConfidence,
}

// ============================================================
// UI Audit
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UIAuditFindingType {
    MissingHandler,
    UnconnectedHandler,
    UnusedState,
    MissingKey,
    DeadComponent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIAuditResult {
    pub total_components_scanned: usize,
    pub findings: Vec<UIAuditFinding>,
    pub summary: UIAuditSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIAuditSummary {
    pub missing_handlers: usize,
    pub unconnected_handlers: usize,
    pub unused_state: usize,
    pub missing_keys: usize,
    pub dead_components: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIAuditFinding {
    pub finding_type: UIAuditFindingType,
    pub file: PathBuf,
    pub line: usize,
    pub component: String,
    pub description: String,
    pub severity: Severity,
    pub auto_fixable: bool,
    pub suggested_fix: Option<String>,
}

// ============================================================
// Deps Audit
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepsAuditResult {
    pub unused_deps: Vec<UnusedDep>,
    pub undeclared_deps: Vec<UndeclaredDep>,
    pub duplicate_imports: Vec<DuplicateImport>,
    pub total_declared: usize,
    pub total_used: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnusedDep {
    pub name: String,
    pub is_dev: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndeclaredDep {
    pub name: String,
    pub used_in: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateImport {
    pub module: String,
    pub paths: Vec<String>,
    pub files: Vec<PathBuf>,
}

// ============================================================
// Env Audit
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvAuditResult {
    pub stale_vars: Vec<StaleVar>,
    pub missing_vars: Vec<MissingVar>,
    pub no_default_vars: Vec<NoDefaultVar>,
    pub inconsistent_vars: Vec<InconsistentVar>,
    pub total_declared: usize,
    pub total_referenced: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaleVar {
    pub name: String,
    pub declared_in: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingVar {
    pub name: String,
    pub used_in: Vec<VarUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VarUsage {
    pub file: PathBuf,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoDefaultVar {
    pub name: String,
    pub used_in: Vec<VarUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InconsistentVar {
    pub name: String,
    pub present_in: Vec<String>,
    pub missing_from: Vec<String>,
}
