use anyhow::{Context, Result};
use std::path::Path;
use tree_sitter::{Parser, Query, QueryCursor};

use super::types::*;

pub struct SourceParser {
    ts_parser: Parser,
    tsx_parser: Parser,
    js_parser: Parser,
}

impl SourceParser {
    pub fn new() -> Result<Self> {
        let mut ts_parser = Parser::new();
        ts_parser
            .set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
            .context("Failed to set TypeScript language")?;

        let mut tsx_parser = Parser::new();
        tsx_parser
            .set_language(&tree_sitter_typescript::LANGUAGE_TSX.into())
            .context("Failed to set TSX language")?;

        let mut js_parser = Parser::new();
        js_parser
            .set_language(&tree_sitter_javascript::LANGUAGE.into())
            .context("Failed to set JavaScript language")?;

        Ok(Self {
            ts_parser,
            tsx_parser,
            js_parser,
        })
    }

    /// Determine if source likely contains JSX (heuristic check)
    fn source_has_jsx(source: &str) -> bool {
        // Simple heuristic: look for JSX-like patterns
        source.contains("<") && (source.contains("/>") || source.contains("</"))
    }

    pub fn parse_file(&mut self, path: &Path, language: Language) -> Result<(Vec<ImportInfo>, Vec<ExportInfo>)> {
        let source = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read file: {}", path.display()))?;

        // Use TSX parser for .tsx/.jsx files
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let use_tsx = ext == "tsx" || ext == "jsx";
        self.parse_source_internal(&source, language, use_tsx)
    }

    pub fn parse_source(&mut self, source: &str, language: Language) -> Result<(Vec<ImportInfo>, Vec<ExportInfo>)> {
        self.parse_source_internal(source, language, false)
    }

    fn parse_source_internal(&mut self, source: &str, language: Language, use_tsx: bool) -> Result<(Vec<ImportInfo>, Vec<ExportInfo>)> {
        let parser = match language {
            Language::TypeScript if use_tsx => &mut self.tsx_parser,
            Language::TypeScript => &mut self.ts_parser,
            Language::JavaScript => &mut self.js_parser,
            Language::Css => return Ok((Vec::new(), Vec::new())),
        };

        let tree = parser
            .parse(source, None)
            .context("Failed to parse source")?;

        let root_node = tree.root_node();
        let source_bytes = source.as_bytes();

        let ts_lang: tree_sitter::Language = match language {
            Language::TypeScript if use_tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Language::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Language::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Language::Css => return Ok((Vec::new(), Vec::new())),
        };

        let imports = extract_imports(&ts_lang, root_node, source_bytes)?;
        let exports = extract_exports(&ts_lang, root_node, source_bytes)?;

        Ok((imports, exports))
    }

    pub fn parse_file_enriched(
        &mut self,
        path: &Path,
        language: Language,
        enrichments: Enrichments,
    ) -> Result<(Vec<ImportInfo>, Vec<ExportInfo>, EnrichmentData)> {
        let source = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read file: {}", path.display()))?;

        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let use_tsx = ext == "tsx" || ext == "jsx";
        self.parse_source_enriched_internal(&source, language, enrichments, use_tsx)
    }

    pub fn parse_source_enriched(
        &mut self,
        source: &str,
        language: Language,
        enrichments: Enrichments,
    ) -> Result<(Vec<ImportInfo>, Vec<ExportInfo>, EnrichmentData)> {
        // Auto-detect JSX in source for enrichment (since no file extension)
        let use_tsx = matches!(language, Language::TypeScript | Language::JavaScript)
            && (enrichments.jsx_elements && Self::source_has_jsx(source));
        self.parse_source_enriched_internal(source, language, enrichments, use_tsx)
    }

    fn parse_source_enriched_internal(
        &mut self,
        source: &str,
        language: Language,
        enrichments: Enrichments,
        use_tsx: bool,
    ) -> Result<(Vec<ImportInfo>, Vec<ExportInfo>, EnrichmentData)> {
        let parser = match language {
            Language::TypeScript if use_tsx => &mut self.tsx_parser,
            Language::TypeScript => &mut self.ts_parser,
            Language::JavaScript => &mut self.js_parser,
            Language::Css => return Ok((Vec::new(), Vec::new(), EnrichmentData::default())),
        };

        let tree = parser
            .parse(source, None)
            .context("Failed to parse source")?;

        let root_node = tree.root_node();
        let source_bytes = source.as_bytes();

        let ts_lang: tree_sitter::Language = match language {
            Language::TypeScript if use_tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Language::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Language::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Language::Css => return Ok((Vec::new(), Vec::new(), EnrichmentData::default())),
        };

        let imports = extract_imports(&ts_lang, root_node, source_bytes)?;
        let exports = extract_exports(&ts_lang, root_node, source_bytes)?;

        let mut data = EnrichmentData::default();

        if enrichments.symbol_usages {
            data.symbol_usages = Some(extract_symbol_usages(root_node, source_bytes));
        }
        if enrichments.jsx_elements {
            data.jsx_elements = Some(extract_jsx_elements(&ts_lang, root_node, source_bytes));
        }
        if enrichments.env_references {
            data.env_references = Some(extract_env_references(root_node, source_bytes));
        }
        if enrichments.call_sites {
            data.call_sites = Some(extract_call_sites(root_node, source_bytes));
        }

        Ok((imports, exports, data))
    }
}

fn extract_imports(
    language: &tree_sitter::Language,
    root_node: tree_sitter::Node,
    source: &[u8],
) -> Result<Vec<ImportInfo>> {
    let mut imports = Vec::new();

    // ES import statements: import { x } from "source"
    // Also matches: import x from "source", import * as x from "source"
    // Also matches: import "source" (side-effect)
    let import_query = Query::new(
        language,
        r#"(import_statement
          source: (string) @source
        ) @import"#,
    )
    .context("Failed to create import query")?;

    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(&import_query, root_node, source);

    for m in matches {
        let source_node = m.captures.iter().find(|c| {
            import_query.capture_names()[c.index as usize] == "source"
        });

        if let Some(src_cap) = source_node {
            let raw = src_cap.node.utf8_text(source).unwrap_or("");
            let source_str = raw.trim_matches(|c| c == '"' || c == '\'' || c == '`');

            let import_cap = m.captures.iter().find(|c| {
                import_query.capture_names()[c.index as usize] == "import"
            });

            let (line, column) = if let Some(imp) = import_cap {
                (imp.node.start_position().row + 1, imp.node.start_position().column)
            } else {
                (src_cap.node.start_position().row + 1, src_cap.node.start_position().column)
            };

            let import_node_actual = import_cap.map(|c| c.node);
            let specifiers = extract_import_specifiers(import_node_actual, source);
            let is_type_only = import_node_actual
                .map(|n| {
                    let text = n.utf8_text(source).unwrap_or("");
                    text.starts_with("import type ")
                })
                .unwrap_or(false);

            imports.push(ImportInfo {
                source: source_str.to_string(),
                resolved_path: None,
                specifiers,
                import_type: ImportType::Static,
                is_type_only,
                line,
                column,
            });
        }
    }

    // CommonJS require: const x = require("source")
    let require_query = Query::new(
        language,
        r#"(call_expression
          function: (identifier) @fn_name
          arguments: (arguments (string) @source)
          (#eq? @fn_name "require")
        )"#,
    );

    if let Ok(ref query) = require_query {
        let mut cursor = QueryCursor::new();
        let matches = cursor.matches(query, root_node, source);

        for m in matches {
            let source_node = m.captures.iter().find(|c| {
                query.capture_names()[c.index as usize] == "source"
            });

            if let Some(src_cap) = source_node {
                let raw = src_cap.node.utf8_text(source).unwrap_or("");
                let source_str = raw.trim_matches(|c| c == '"' || c == '\'' || c == '`');

                imports.push(ImportInfo {
                    source: source_str.to_string(),
                    resolved_path: None,
                    specifiers: Vec::new(),
                    import_type: ImportType::Require,
                    is_type_only: false,
                    line: src_cap.node.start_position().row + 1,
                    column: src_cap.node.start_position().column,
                });
            }
        }
    }

    // Dynamic imports: import("source")
    let dynamic_query = Query::new(
        language,
        r#"(call_expression
          function: (import)
          arguments: (arguments (string) @source)
        )"#,
    );

    if let Ok(ref query) = dynamic_query {
        let mut cursor = QueryCursor::new();
        let matches = cursor.matches(query, root_node, source);

        for m in matches {
            let source_node = m.captures.iter().find(|c| {
                query.capture_names()[c.index as usize] == "source"
            });

            if let Some(src_cap) = source_node {
                let raw = src_cap.node.utf8_text(source).unwrap_or("");
                let source_str = raw.trim_matches(|c| c == '"' || c == '\'' || c == '`');

                imports.push(ImportInfo {
                    source: source_str.to_string(),
                    resolved_path: None,
                    specifiers: Vec::new(),
                    import_type: ImportType::Dynamic,
                    is_type_only: false,
                    line: src_cap.node.start_position().row + 1,
                    column: src_cap.node.start_position().column,
                });
            }
        }
    }

    Ok(imports)
}

fn extract_import_specifiers(
    node: Option<tree_sitter::Node>,
    source: &[u8],
) -> Vec<ImportSpecifier> {
    let mut specifiers = Vec::new();
    let node = match node {
        Some(n) => n,
        None => return specifiers,
    };

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            // import x from "..."
            "import_clause" | "identifier" => {
                if child.kind() == "identifier" {
                    let name = child.utf8_text(source).unwrap_or("").to_string();
                    if name != "import" && name != "from" && name != "type" {
                        specifiers.push(ImportSpecifier {
                            name: name.clone(),
                            alias: None,
                            is_default: true,
                            is_namespace: false,
                        });
                    }
                } else {
                    // Recurse into import_clause
                    let inner = extract_import_specifiers(Some(child), source);
                    specifiers.extend(inner);
                }
            }
            // import * as x from "..."
            "namespace_import" => {
                let mut c2 = child.walk();
                for inner in child.children(&mut c2) {
                    if inner.kind() == "identifier" {
                        let name = inner.utf8_text(source).unwrap_or("").to_string();
                        specifiers.push(ImportSpecifier {
                            name,
                            alias: None,
                            is_default: false,
                            is_namespace: true,
                        });
                    }
                }
            }
            // import { x, y as z } from "..."
            "named_imports" => {
                let mut c2 = child.walk();
                for inner in child.children(&mut c2) {
                    if inner.kind() == "import_specifier" {
                        let mut name = String::new();
                        let mut alias = None;
                        let mut c3 = inner.walk();
                        let children: Vec<_> = inner.children(&mut c3).collect();
                        let identifiers: Vec<_> = children
                            .iter()
                            .filter(|n| n.kind() == "identifier")
                            .collect();

                        if identifiers.len() >= 2 {
                            name = identifiers[0].utf8_text(source).unwrap_or("").to_string();
                            alias = Some(identifiers[1].utf8_text(source).unwrap_or("").to_string());
                        } else if let Some(id) = identifiers.first() {
                            name = id.utf8_text(source).unwrap_or("").to_string();
                        }

                        if !name.is_empty() {
                            specifiers.push(ImportSpecifier {
                                name,
                                alias,
                                is_default: false,
                                is_namespace: false,
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }

    specifiers
}

fn extract_exports(
    _language: &tree_sitter::Language,
    root_node: tree_sitter::Node,
    source: &[u8],
) -> Result<Vec<ExportInfo>> {
    let mut exports = Vec::new();

    // Walk tree manually to find export statements
    let mut cursor = root_node.walk();
    for child in root_node.children(&mut cursor) {
        match child.kind() {
            "export_statement" => {
                let line = child.start_position().row + 1;
                let text = child.utf8_text(source).unwrap_or("");

                // Re-export: export { x } from "source" or export * from "source"
                let re_export_source = extract_re_export_source(child, source);

                if re_export_source.is_some() {
                    // Named re-exports
                    let mut c2 = child.walk();
                    let mut found_names = false;
                    for inner in child.children(&mut c2) {
                        if inner.kind() == "export_clause" {
                            let mut c3 = inner.walk();
                            for spec in inner.children(&mut c3) {
                                if spec.kind() == "export_specifier" {
                                    let name_node = spec
                                        .child_by_field_name("name")
                                        .or_else(|| {
                                            let mut c4 = spec.walk();
                                            let result = spec.children(&mut c4).find(|n| n.kind() == "identifier");
                                            result
                                        });
                                    let name = name_node
                                        .map(|n| n.utf8_text(source).unwrap_or(""))
                                        .unwrap_or("")
                                        .to_string();
                                    if !name.is_empty() {
                                        exports.push(ExportInfo {
                                            name,
                                            export_type: ExportType::ReExport,
                                            is_default: false,
                                            signature: None,
                                            line,
                                            re_export_source: re_export_source.clone(),
                                        });
                                        found_names = true;
                                    }
                                }
                            }
                        }
                    }
                    if !found_names {
                        // export * from "source"
                        exports.push(ExportInfo {
                            name: "*".to_string(),
                            export_type: ExportType::ReExport,
                            is_default: false,
                            signature: None,
                            line,
                            re_export_source,
                        });
                    }
                    continue;
                }

                // Check child declaration
                let mut c2 = child.walk();
                for inner in child.children(&mut c2) {
                    match inner.kind() {
                        "function_declaration" | "function_signature" => {
                            let name = inner
                                .child_by_field_name("name")
                                .map(|n| n.utf8_text(source).unwrap_or(""))
                                .unwrap_or("default")
                                .to_string();
                            let is_default = text.contains("export default");
                            exports.push(ExportInfo {
                                name,
                                export_type: ExportType::Function,
                                is_default,
                                signature: None,
                                line,
                                re_export_source: None,
                            });
                        }
                        "class_declaration" => {
                            let name = inner
                                .child_by_field_name("name")
                                .map(|n| n.utf8_text(source).unwrap_or(""))
                                .unwrap_or("default")
                                .to_string();
                            let is_default = text.contains("export default");
                            exports.push(ExportInfo {
                                name,
                                export_type: ExportType::Class,
                                is_default,
                                signature: None,
                                line,
                                re_export_source: None,
                            });
                        }
                        "lexical_declaration" | "variable_declaration" => {
                            // export const x = ...
                            let mut c3 = inner.walk();
                            for decl in inner.children(&mut c3) {
                                if decl.kind() == "variable_declarator" {
                                    let name = decl
                                        .child_by_field_name("name")
                                        .map(|n| n.utf8_text(source).unwrap_or(""))
                                        .unwrap_or("")
                                        .to_string();
                                    if !name.is_empty() {
                                        exports.push(ExportInfo {
                                            name,
                                            export_type: ExportType::Variable,
                                            is_default: false,
                                            signature: None,
                                            line,
                                            re_export_source: None,
                                        });
                                    }
                                }
                            }
                        }
                        "type_alias_declaration" => {
                            let name = inner
                                .child_by_field_name("name")
                                .map(|n| n.utf8_text(source).unwrap_or(""))
                                .unwrap_or("")
                                .to_string();
                            exports.push(ExportInfo {
                                name,
                                export_type: ExportType::Type,
                                is_default: false,
                                signature: None,
                                line,
                                re_export_source: None,
                            });
                        }
                        "interface_declaration" => {
                            let name = inner
                                .child_by_field_name("name")
                                .map(|n| n.utf8_text(source).unwrap_or(""))
                                .unwrap_or("")
                                .to_string();
                            exports.push(ExportInfo {
                                name,
                                export_type: ExportType::Interface,
                                is_default: false,
                                signature: None,
                                line,
                                re_export_source: None,
                            });
                        }
                        "enum_declaration" => {
                            let name = inner
                                .child_by_field_name("name")
                                .map(|n| n.utf8_text(source).unwrap_or(""))
                                .unwrap_or("")
                                .to_string();
                            exports.push(ExportInfo {
                                name,
                                export_type: ExportType::Enum,
                                is_default: false,
                                signature: None,
                                line,
                                re_export_source: None,
                            });
                        }
                        "export_clause" => {
                            // export { x, y }
                            let mut c3 = inner.walk();
                            for spec in inner.children(&mut c3) {
                                if spec.kind() == "export_specifier" {
                                    let name_node = spec
                                        .child_by_field_name("name")
                                        .or_else(|| {
                                            let mut c4 = spec.walk();
                                            let result = spec.children(&mut c4).find(|n| n.kind() == "identifier");
                                            result
                                        });
                                    let name = name_node
                                        .map(|n| n.utf8_text(source).unwrap_or(""))
                                        .unwrap_or("")
                                        .to_string();
                                    if !name.is_empty() {
                                        exports.push(ExportInfo {
                                            name,
                                            export_type: ExportType::Variable,
                                            is_default: false,
                                            signature: None,
                                            line,
                                            re_export_source: None,
                                        });
                                    }
                                }
                            }
                        }
                        _ => {
                            // export default expression
                            if text.starts_with("export default") {
                                exports.push(ExportInfo {
                                    name: "default".to_string(),
                                    export_type: ExportType::Variable,
                                    is_default: true,
                                    signature: None,
                                    line,
                                    re_export_source: None,
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Ok(exports)
}

fn extract_re_export_source(node: tree_sitter::Node, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "string" {
            let text = child.utf8_text(source).unwrap_or("");
            return Some(text.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string());
        }
    }
    None
}

// ============================================================
// Parser Enrichment Extraction Functions
// ============================================================

/// Check if a node is inside an import or export statement
fn is_inside_import_or_export(node: tree_sitter::Node) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "import_statement" | "export_statement" => return true,
            _ => current = parent.parent(),
        }
    }
    false
}

/// Extract symbol usages from source, skipping those inside import/export statements.
/// Classifies by parent node type.
fn extract_symbol_usages(
    root_node: tree_sitter::Node,
    source: &[u8],
) -> Vec<SymbolUsage> {
    let mut usages = Vec::new();
    let mut cursor = root_node.walk();
    walk_for_identifiers(root_node, &mut cursor, source, &mut usages);
    usages
}

fn walk_for_identifiers(
    node: tree_sitter::Node,
    cursor: &mut tree_sitter::TreeCursor,
    source: &[u8],
    usages: &mut Vec<SymbolUsage>,
) {
    if node.kind() == "identifier" || node.kind() == "type_identifier" || node.kind() == "property_identifier" {
        if !is_inside_import_or_export(node) {
            let name = node.utf8_text(source).unwrap_or("").to_string();
            if !name.is_empty() {
                let parent = node.parent();
                let parent_kind = parent.map(|p| p.kind()).unwrap_or("");

                let usage_type = classify_symbol_usage(node, parent_kind);
                let is_write = matches!(parent_kind, "variable_declarator" | "assignment_expression")
                    || (parent_kind == "assignment_expression"
                        && parent.and_then(|p| p.child_by_field_name("left"))
                            .map(|left| left.id() == node.id())
                            .unwrap_or(false));

                usages.push(SymbolUsage {
                    name,
                    usage_type,
                    line: node.start_position().row + 1,
                    column: node.start_position().column,
                    is_write,
                });
            }
        }
    }

    // Recurse into children
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            let mut child_cursor = child.walk();
            walk_for_identifiers(child, &mut child_cursor, source, usages);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
        cursor.goto_parent();
    }
}

fn classify_symbol_usage(node: tree_sitter::Node, parent_kind: &str) -> SymbolUsageType {
    match parent_kind {
        "call_expression" => {
            // Check if this identifier is the function being called
            if let Some(parent) = node.parent() {
                if let Some(func_node) = parent.child_by_field_name("function") {
                    if func_node.id() == node.id() {
                        return SymbolUsageType::Call;
                    }
                }
            }
            SymbolUsageType::Reference
        }
        "member_expression" => SymbolUsageType::PropertyAccess,
        "type_annotation" | "type_identifier" | "generic_type" | "predefined_type" => {
            SymbolUsageType::TypeReference
        }
        "jsx_opening_element" | "jsx_closing_element" | "jsx_self_closing_element" => {
            SymbolUsageType::JsxComponent
        }
        _ => {
            if node.kind() == "type_identifier" {
                SymbolUsageType::TypeReference
            } else {
                SymbolUsageType::Reference
            }
        }
    }
}

/// Extract JSX element info from source.
/// Requires TSX language for accurate parsing.
fn extract_jsx_elements(
    language: &tree_sitter::Language,
    root_node: tree_sitter::Node,
    source: &[u8],
) -> Vec<JSXElementInfo> {
    let mut elements = Vec::new();

    // Query for both self-closing and opening JSX elements
    let query_str = r#"[
        (jsx_opening_element) @open
        (jsx_self_closing_element) @self_close
    ]"#;

    let query = match Query::new(language, query_str) {
        Ok(q) => q,
        Err(_) => return elements, // JSX not supported by this language grammar
    };

    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(&query, root_node, source);

    for m in matches {
        for cap in m.captures {
            let node = cap.node;
            let is_self_closing = node.kind() == "jsx_self_closing_element";

            // Extract tag name (first child that is identifier or member_expression)
            let tag_name = extract_jsx_tag_name(node, source);
            if tag_name.is_empty() {
                continue;
            }

            // A component is uppercase first letter (React convention)
            let is_component = tag_name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);

            // Extract props
            let props = extract_jsx_props(node, source);

            // Determine if element has children (for opening elements, check parent jsx_element)
            let has_children = if !is_self_closing {
                node.parent()
                    .map(|parent| {
                        // Parent is jsx_element; check if it has children beyond open/close tags
                        let child_count = parent.named_child_count();
                        child_count > 2 // open tag + close tag = 2, anything more = has children
                    })
                    .unwrap_or(false)
            } else {
                false
            };

            elements.push(JSXElementInfo {
                tag_name,
                props,
                has_children,
                line: node.start_position().row + 1,
                is_component,
            });
        }
    }

    elements
}

fn extract_jsx_tag_name(node: tree_sitter::Node, source: &[u8]) -> String {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "identifier" | "member_expression" => {
                return child.utf8_text(source).unwrap_or("").to_string();
            }
            _ => {}
        }
    }
    String::new()
}

fn extract_jsx_props(node: tree_sitter::Node, source: &[u8]) -> Vec<JSXPropInfo> {
    let mut props = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "jsx_attribute" => {
                let name_from_field = child.child_by_field_name("name");
                let name_node = if name_from_field.is_some() {
                    name_from_field
                } else {
                    let mut c2 = child.walk();
                    let found = child.children(&mut c2)
                        .find(|n| n.kind() == "property_identifier" || n.kind() == "identifier");
                    found
                };
                let name = name_node
                    .map(|n| n.utf8_text(source).unwrap_or("").to_string())
                    .unwrap_or_default();

                if name.is_empty() {
                    continue;
                }

                let has_value = child.child_by_field_name("value").is_some()
                    || child.named_child_count() > 1;

                let is_event_handler = name.starts_with("on") && name.len() > 2
                    && name.chars().nth(2).map(|c| c.is_uppercase()).unwrap_or(false);

                let value_type = if !has_value {
                    PropValueType::Shorthand
                } else {
                    let value_from_field = child.child_by_field_name("value");
                    let value_node = if value_from_field.is_some() {
                        value_from_field
                    } else {
                        let mut c2 = child.walk();
                        let found = child.children(&mut c2).nth(2); // skip name and "="
                        found
                    };
                    match value_node.map(|n| n.kind()) {
                        Some("string") | Some("string_fragment") => PropValueType::Literal,
                        Some("jsx_expression") => PropValueType::Expression,
                        _ => PropValueType::Expression,
                    }
                };

                props.push(JSXPropInfo {
                    name,
                    has_value,
                    is_event_handler,
                    value_type,
                    line: child.start_position().row + 1,
                });
            }
            "jsx_expression" => {
                // Spread attribute: {...props}
                let text = child.utf8_text(source).unwrap_or("");
                if text.contains("...") {
                    props.push(JSXPropInfo {
                        name: text.trim_matches(|c: char| c == '{' || c == '}').trim().to_string(),
                        has_value: true,
                        is_event_handler: false,
                        value_type: PropValueType::Spread,
                        line: child.start_position().row + 1,
                    });
                }
            }
            _ => {}
        }
    }
    props
}

/// Extract environment variable references (process.env.*, import.meta.env.*)
fn extract_env_references(
    root_node: tree_sitter::Node,
    source: &[u8],
) -> Vec<EnvReference> {
    let mut refs = Vec::new();
    walk_for_env_refs(root_node, source, &mut refs);
    refs
}

fn walk_for_env_refs(
    node: tree_sitter::Node,
    source: &[u8],
    refs: &mut Vec<EnvReference>,
) {
    if node.kind() == "member_expression" {
        let text = node.utf8_text(source).unwrap_or("");

        // process.env.SOMETHING
        if let Some(var_name) = text.strip_prefix("process.env.") {
            // Check if there's a default (look at grandparent for || or ??)
            let has_default = check_has_default(node);
            if !var_name.is_empty() && !var_name.contains('.') {
                refs.push(EnvReference {
                    variable: var_name.to_string(),
                    access_pattern: EnvAccessPattern::ProcessEnv,
                    line: node.start_position().row + 1,
                    has_default,
                });
                return; // Don't recurse into children of this matched node
            }
        }

        // import.meta.env.SOMETHING
        if let Some(var_name) = text.strip_prefix("import.meta.env.") {
            let has_default = check_has_default(node);
            if !var_name.is_empty() && !var_name.contains('.') {
                refs.push(EnvReference {
                    variable: var_name.to_string(),
                    access_pattern: EnvAccessPattern::ImportMetaEnv,
                    line: node.start_position().row + 1,
                    has_default,
                });
                return;
            }
        }

        // Deno.env.get("SOMETHING")
        if text.starts_with("Deno.env") {
            if let Some(parent) = node.parent() {
                if parent.kind() == "call_expression" {
                    let parent_text = parent.utf8_text(source).unwrap_or("");
                    if let Some(start) = parent_text.find('"').or_else(|| parent_text.find('\'')) {
                        let rest = &parent_text[start + 1..];
                        if let Some(end) = rest.find('"').or_else(|| rest.find('\'')) {
                            let var_name = &rest[..end];
                            refs.push(EnvReference {
                                variable: var_name.to_string(),
                                access_pattern: EnvAccessPattern::DenoEnv,
                                line: node.start_position().row + 1,
                                has_default: check_has_default(parent),
                            });
                            return;
                        }
                    }
                }
            }
        }
    }

    // Recurse
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            walk_for_env_refs(cursor.node(), source, refs);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}

/// Check if a node's parent context suggests a default value (|| or ??)
fn check_has_default(node: tree_sitter::Node) -> bool {
    if let Some(parent) = node.parent() {
        if parent.kind() == "binary_expression" {
            // Check for || or ?? operator by walking children
            let mut cursor = parent.walk();
            for child in parent.children(&mut cursor) {
                let kind = child.kind();
                if kind == "||" || kind == "??" {
                    return true;
                }
            }
        }
    }
    false
}

/// Extract call site information from source
fn extract_call_sites(
    root_node: tree_sitter::Node,
    source: &[u8],
) -> Vec<CallSiteInfo> {
    let mut sites = Vec::new();
    walk_for_call_sites(root_node, source, &mut sites);
    sites
}

fn walk_for_call_sites(
    node: tree_sitter::Node,
    source: &[u8],
    sites: &mut Vec<CallSiteInfo>,
) {
    if node.kind() == "call_expression" {
        let func_node = node.child_by_field_name("function");
        let args_node = node.child_by_field_name("arguments");

        if let Some(func) = func_node {
            let callee_text = func.utf8_text(source).unwrap_or("").to_string();

            let arg_count = args_node
                .map(|args| {
                    let mut count = 0;
                    let mut c = args.walk();
                    for child in args.children(&mut c) {
                        // Count non-punctuation children as arguments
                        if child.kind() != "(" && child.kind() != ")" && child.kind() != "," {
                            count += 1;
                        }
                    }
                    count
                })
                .unwrap_or(0);

            // Determine if chained and extract receiver
            let (is_chained, receiver) = if func.kind() == "member_expression" {
                let object = func.child_by_field_name("object");
                let receiver_text = object
                    .map(|o| o.utf8_text(source).unwrap_or("").to_string());
                // It's chained if the object is itself a call_expression
                let chained = object.map(|o| o.kind() == "call_expression").unwrap_or(false);
                (chained, receiver_text)
            } else {
                (false, None)
            };

            // Extract just the method/function name from callee
            let callee = if func.kind() == "member_expression" {
                func.child_by_field_name("property")
                    .map(|p| p.utf8_text(source).unwrap_or("").to_string())
                    .unwrap_or(callee_text)
            } else {
                callee_text
            };

            sites.push(CallSiteInfo {
                callee,
                arguments: arg_count,
                line: node.start_position().row + 1,
                is_chained,
                receiver,
            });
        }
    }

    // Recurse
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            walk_for_call_sites(cursor.node(), source, sites);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ts(source: &str) -> (Vec<ImportInfo>, Vec<ExportInfo>) {
        let mut parser = SourceParser::new().unwrap();
        parser.parse_source(source, Language::TypeScript).unwrap()
    }

    #[test]
    fn test_es_imports() {
        let (imports, _) = parse_ts(r#"
import { foo, bar } from "./lib/utils";
import defaultExport from "../models/user";
import * as path from "path";
"#);

        assert_eq!(imports.len(), 3);
        assert_eq!(imports[0].source, "./lib/utils");
        assert_eq!(imports[0].import_type, ImportType::Static);
        assert_eq!(imports[1].source, "../models/user");
        assert_eq!(imports[2].source, "path");
    }

    #[test]
    fn test_type_only_import() {
        let (imports, _) = parse_ts(r#"
import type { User } from "./types";
"#);

        assert_eq!(imports.len(), 1);
        assert!(imports[0].is_type_only);
        assert_eq!(imports[0].source, "./types");
    }

    #[test]
    fn test_require_import() {
        let (imports, _) = parse_ts(r#"
const fs = require("fs");
const utils = require("./utils");
"#);

        let requires: Vec<_> = imports
            .iter()
            .filter(|i| i.import_type == ImportType::Require)
            .collect();
        assert_eq!(requires.len(), 2);
        assert_eq!(requires[0].source, "fs");
        assert_eq!(requires[1].source, "./utils");
    }

    #[test]
    fn test_dynamic_import() {
        let (imports, _) = parse_ts(r#"
const mod = await import("./lazy-module");
"#);

        let dynamic: Vec<_> = imports
            .iter()
            .filter(|i| i.import_type == ImportType::Dynamic)
            .collect();
        assert_eq!(dynamic.len(), 1);
        assert_eq!(dynamic[0].source, "./lazy-module");
    }

    #[test]
    fn test_exports() {
        let (_, exports) = parse_ts(r#"
export function greet(name: string): string { return `Hi ${name}`; }
export const VERSION = "1.0.0";
export class UserService {}
export interface Config {}
export type UserId = string;
export enum Status { Active, Inactive }
"#);

        assert_eq!(exports.len(), 6);
        assert_eq!(exports[0].export_type, ExportType::Function);
        assert_eq!(exports[0].name, "greet");
        assert_eq!(exports[1].export_type, ExportType::Variable);
        assert_eq!(exports[1].name, "VERSION");
        assert_eq!(exports[2].export_type, ExportType::Class);
        assert_eq!(exports[3].export_type, ExportType::Interface);
        assert_eq!(exports[4].export_type, ExportType::Type);
        assert_eq!(exports[5].export_type, ExportType::Enum);
    }

    #[test]
    fn test_re_exports() {
        let (_, exports) = parse_ts(r#"
export { foo, bar } from "./utils";
export * from "./types";
"#);

        assert!(exports.len() >= 2);
        let re_exports: Vec<_> = exports
            .iter()
            .filter(|e| e.export_type == ExportType::ReExport)
            .collect();
        assert!(re_exports.len() >= 2);
    }

    #[test]
    fn test_default_export() {
        let (_, exports) = parse_ts(r#"
export default function main() {}
"#);

        assert!(!exports.is_empty());
        assert!(exports.iter().any(|e| e.is_default));
    }

    // ============================================================
    // Enrichment Tests
    // ============================================================

    #[test]
    fn test_extract_symbol_usages() {
        let source = r#"
const x = 10;
const y = x + 5;
console.log(y);
"#;
        let mut parser = SourceParser::new().unwrap();
        let enrichments = Enrichments { symbol_usages: true, ..Default::default() };
        let (_imports, _exports, data) = parser.parse_source_enriched(source, Language::TypeScript, enrichments).unwrap();
        let usages = data.symbol_usages.unwrap();
        assert!(!usages.is_empty());
        // console should appear as PropertyAccess (it's the object in console.log)
        assert!(usages.iter().any(|u| u.name == "console"));
        // x should appear as a reference
        assert!(usages.iter().any(|u| u.name == "x"));
        // y should appear
        assert!(usages.iter().any(|u| u.name == "y"));
    }

    #[test]
    fn test_extract_env_references() {
        let source = r#"
const url = process.env.DATABASE_URL;
const port = process.env.PORT || 3000;
"#;
        let mut parser = SourceParser::new().unwrap();
        let enrichments = Enrichments { env_references: true, ..Default::default() };
        let (_imports, _exports, data) = parser.parse_source_enriched(source, Language::TypeScript, enrichments).unwrap();
        let refs = data.env_references.unwrap();
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|r| r.variable == "DATABASE_URL"));
        assert!(refs.iter().any(|r| r.variable == "PORT" && r.has_default));
    }

    #[test]
    fn test_extract_call_sites() {
        let source = r#"
console.log("hello");
fetch("/api/data").then(r => r.json());
doSomething(1, 2, 3);
"#;
        let mut parser = SourceParser::new().unwrap();
        let enrichments = Enrichments { call_sites: true, ..Default::default() };
        let (_imports, _exports, data) = parser.parse_source_enriched(source, Language::TypeScript, enrichments).unwrap();
        let sites = data.call_sites.unwrap();
        assert!(!sites.is_empty());
        // console.log call
        assert!(sites.iter().any(|s| s.callee == "log" && s.receiver.as_deref() == Some("console")));
        // fetch call
        assert!(sites.iter().any(|s| s.callee == "fetch" && s.arguments == 1));
        // doSomething call with 3 args
        assert!(sites.iter().any(|s| s.callee == "doSomething" && s.arguments == 3));
    }

    #[test]
    fn test_extract_jsx_elements() {
        // TSX source needs TSX parser. Use parse_source_enriched which auto-detects JSX.
        let source = r#"
function App() {
    return (
        <div className="app">
            <Header title="Hello" onClick={handleClick} />
            <p>Some text</p>
        </div>
    );
}
"#;
        let mut parser = SourceParser::new().unwrap();
        let enrichments = Enrichments { jsx_elements: true, ..Default::default() };
        let (_imports, _exports, data) = parser.parse_source_enriched(source, Language::TypeScript, enrichments).unwrap();
        let elements = data.jsx_elements.unwrap();
        assert!(!elements.is_empty());
        // Header is a component (uppercase)
        assert!(elements.iter().any(|e| e.tag_name == "Header" && e.is_component));
        // div is not a component
        assert!(elements.iter().any(|e| e.tag_name == "div" && !e.is_component));
        // p is not a component
        assert!(elements.iter().any(|e| e.tag_name == "p" && !e.is_component));
        // Header should have onClick as event handler
        let header = elements.iter().find(|e| e.tag_name == "Header").unwrap();
        assert!(header.props.iter().any(|p| p.name == "onClick" && p.is_event_handler));
        assert!(header.props.iter().any(|p| p.name == "title" && !p.is_event_handler));
    }
}
