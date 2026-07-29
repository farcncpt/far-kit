use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use crate::config::loader::load_project_config;
use crate::core::graph::DependencyGraph;
use crate::core::types::*;
use crate::deadcode::analyzer::find_dead_code;
use crate::delete_op::deleter::compute_delete;
use crate::impact::classifier::reclassify_effects;
use crate::impact::detector::detect_changes;
use crate::impact::task_generator::generate_tasks;
use crate::impact::tracer::trace_cascade;
use crate::move_op::mover::{compute_bulk_move, compute_folder_move, compute_move};
use crate::rename_op::renamer::compute_rename;

#[derive(Debug, Deserialize)]
struct ServeRequest {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Serialize)]
struct ServeResponse {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ServeResponse {
    fn ok(id: u64, result: Value) -> Self {
        Self { id, result: Some(result), error: None }
    }

    fn err(id: u64, msg: String) -> Self {
        Self { id, result: None, error: Some(msg) }
    }
}

pub fn run_serve(project_root: PathBuf) -> Result<()> {
    let config = load_project_config(&project_root)
        .context("Failed to load project config")?;
    let mut graph = DependencyGraph::build(&project_root, &config)
        .context("Failed to build dependency graph")?;

    // Signal readiness
    let ready = serde_json::json!({"ready": true});
    let stdout = io::stdout();
    {
        let mut out = stdout.lock();
        serde_json::to_writer(&mut out, &ready)?;
        out.write_all(b"\n")?;
        out.flush()?;
    }

    eprintln!("[serve] Ready. Graph: {} files, {} edges", graph.file_count(), graph.edge_count());

    let stdin = io::stdin();
    let reader = stdin.lock();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[serve] stdin read error: {}", e);
                break;
            }
        };

        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let req: ServeRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[serve] JSON parse error: {}", e);
                let resp = ServeResponse::err(0, format!("Invalid JSON: {}", e));
                write_response(&resp);
                continue;
            }
        };

        let resp = dispatch(&req, &project_root, &config, &mut graph);
        write_response(&resp);
    }

    eprintln!("[serve] Stdin closed, shutting down");
    Ok(())
}

fn write_response(resp: &ServeResponse) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if let Err(e) = serde_json::to_writer(&mut out, resp) {
        eprintln!("[serve] Failed to write response: {}", e);
        return;
    }
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn dispatch(
    req: &ServeRequest,
    project_root: &Path,
    config: &ProjectConfig,
    graph: &mut DependencyGraph,
) -> ServeResponse {
    let result = match req.command.as_str() {
        "scan" => handle_scan(project_root, graph),
        "analyze" => handle_analyze(req, project_root, graph),
        "move" => handle_move(req, graph, config),
        "move_bulk" => handle_move_bulk(req, graph, config),
        "impact" => handle_impact(req, project_root, graph),
        "auto_fix" => handle_impact(req, project_root, graph),
        "delete" => handle_delete(req, graph),
        "rename" => handle_rename(req, graph),
        "dead_code" => handle_dead_code(req, project_root, graph),
        "ui_audit" => handle_ui_audit(project_root, config, graph),
        "deps_audit" => handle_deps_audit(project_root, config, graph),
        "env_audit" => handle_env_audit(req, project_root, config, graph),
        "scan_routes" => handle_scan_routes(project_root, graph),
        "rescan" => handle_rescan(project_root, config, graph),
        other => Err(anyhow::anyhow!("Unknown command: {}", other)),
    };

    match result {
        Ok(val) => ServeResponse::ok(req.id, val),
        Err(e) => ServeResponse::err(req.id, format!("{:#}", e)),
    }
}

// ─── Command Handlers ───

fn handle_scan(project_root: &Path, graph: &DependencyGraph) -> Result<Value> {
    let by_lang = graph.files_by_language();
    let (total_imports, total_exports) = graph.import_export_counts();

    let result = ScanResult {
        project_root: project_root.to_path_buf(),
        files: graph
            .all_files()
            .iter()
            .filter_map(|p| graph.get_file_info(p).cloned())
            .collect(),
        total_files: graph.file_count(),
        files_by_language: by_lang,
        total_imports,
        total_exports,
    };

    Ok(serde_json::to_value(&result)?)
}

fn handle_analyze(req: &ServeRequest, project_root: &Path, graph: &DependencyGraph) -> Result<Value> {
    let circular = req.args.get("circular").and_then(|v| v.as_bool()).unwrap_or(false);
    let orphans = req.args.get("orphans").and_then(|v| v.as_bool()).unwrap_or(false);

    let by_lang = graph.files_by_language();
    let (total_imports, total_exports) = graph.import_export_counts();

    let mut result = serde_json::json!({
        "project_root": project_root,
        "total_files": graph.file_count(),
        "total_edges": graph.edge_count(),
        "files_by_language": by_lang,
        "total_imports": total_imports,
        "total_exports": total_exports,
    });

    if circular {
        let cycles = graph.find_circular_deps();
        result["circular_dependencies"] = serde_json::json!(
            cycles.iter().map(|c| {
                c.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
            }).collect::<Vec<_>>()
        );
    }

    if orphans {
        let orphan_list = graph.find_orphans();
        result["orphans"] = serde_json::json!(
            orphan_list.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
        );
    }

    Ok(result)
}

fn handle_move(req: &ServeRequest, graph: &DependencyGraph, config: &ProjectConfig) -> Result<Value> {
    let old_path_str = req.args.get("oldPath")
        .or_else(|| req.args.get("old_path"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing oldPath"))?;
    let new_path_str = req.args.get("newPath")
        .or_else(|| req.args.get("new_path"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing newPath"))?;
    let dry_run = req.args.get("dryRun")
        .or_else(|| req.args.get("dry_run"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let old_path = PathBuf::from(old_path_str);
    let new_path = PathBuf::from(new_path_str);

    if old_path.is_dir() {
        let folder_result = compute_folder_move(&old_path, &new_path, graph, config)?;
        let json = serde_json::json!({
            "type": "folder",
            "oldDir": old_path,
            "newDir": new_path,
            "filesMoved": folder_result.files_moved,
            "totalFilesUpdated": folder_result.total_files_updated,
            "routeChanges": folder_result.route_changes.iter().map(|rc| {
                serde_json::json!({
                    "file": rc.file,
                    "line": rc.line,
                    "oldRoute": rc.old_route,
                    "newRoute": rc.new_route,
                })
            }).collect::<Vec<_>>(),
            "results": folder_result.results.iter().map(|r| {
                serde_json::json!({
                    "operation": { "oldPath": r.operation.old_path, "newPath": r.operation.new_path },
                    "affectedFiles": r.affected_files.len(),
                    "totalFilesUpdated": r.total_files_updated,
                })
            }).collect::<Vec<_>>(),
            "dryRun": dry_run,
        });
        Ok(json)
    } else {
        let result = compute_move(&old_path, &new_path, graph, config)?;
        let json = serde_json::json!({
            "type": "file",
            "operation": { "oldPath": old_path, "newPath": new_path },
            "affectedFiles": result.affected_files.iter().map(|af| {
                serde_json::json!({
                    "path": af.path,
                    "line": af.line,
                    "oldImport": af.old_import,
                    "newImport": af.new_import,
                })
            }).collect::<Vec<_>>(),
            "routeChanges": result.route_changes.iter().map(|rc| {
                serde_json::json!({
                    "file": rc.file,
                    "line": rc.line,
                    "oldRoute": rc.old_route,
                    "newRoute": rc.new_route,
                })
            }).collect::<Vec<_>>(),
            "totalFilesUpdated": result.total_files_updated,
            "dryRun": dry_run,
        });
        Ok(json)
    }
}

fn handle_move_bulk(req: &ServeRequest, graph: &DependencyGraph, config: &ProjectConfig) -> Result<Value> {
    let manifest: MoveManifest = serde_json::from_value(req.args.clone())
        .context("Failed to parse move manifest from args")?;

    let results = compute_bulk_move(&manifest, graph, config)?;

    let json = serde_json::json!({
        "results": results.iter().map(|r| {
            serde_json::json!({
                "operation": { "oldPath": r.operation.old_path, "newPath": r.operation.new_path },
                "affectedFiles": r.affected_files.len(),
                "routeChanges": r.route_changes.iter().map(|rc| {
                    serde_json::json!({
                        "file": rc.file,
                        "line": rc.line,
                        "oldRoute": rc.old_route,
                        "newRoute": rc.new_route,
                    })
                }).collect::<Vec<_>>(),
                "totalFilesUpdated": r.total_files_updated,
            })
        }).collect::<Vec<_>>(),
        "dryRun": manifest.dry_run,
    });

    Ok(json)
}

fn handle_impact(req: &ServeRequest, project_root: &Path, graph: &DependencyGraph) -> Result<Value> {
    let file_str = req.args.get("file")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing file"))?;
    let since = req.args.get("since").or_else(|| req.args.get("sinceCommit")).and_then(|v| v.as_str());
    let auto_fix = req.args.get("autoFix").or_else(|| req.args.get("auto_fix")).and_then(|v| v.as_bool()).unwrap_or(false);
    let gen_tasks = req.args.get("generateTasks").or_else(|| req.args.get("generate_tasks")).and_then(|v| v.as_bool()).unwrap_or(false);

    let file = PathBuf::from(file_str);

    let commit = since.ok_or_else(|| anyhow::anyhow!("--since commit is required for impact analysis"))?;

    let relative = file
        .strip_prefix(project_root)
        .unwrap_or(&file)
        .to_string_lossy();

    let output_result = std::process::Command::new("git")
        .args(["show", &format!("{}:{}", commit, relative)])
        .current_dir(project_root)
        .output()
        .context("Failed to run git show")?;

    if !output_result.status.success() {
        anyhow::bail!(
            "Failed to get file from commit {}: {}",
            commit,
            String::from_utf8_lossy(&output_result.stderr)
        );
    }

    let old_source = String::from_utf8_lossy(&output_result.stdout).to_string();
    let new_source = std::fs::read_to_string(&file)
        .with_context(|| format!("Failed to read file: {}", file.display()))?;

    let language = file
        .extension()
        .and_then(|e| e.to_str())
        .and_then(Language::from_extension)
        .unwrap_or(Language::TypeScript);

    let changes = detect_changes(&old_source, &new_source, &file, language)?;

    if changes.is_empty() {
        return Ok(serde_json::json!([]));
    }

    if auto_fix {
        let mut all_effects: Vec<CascadeEffect> = Vec::new();
        for change in &changes {
            let mut effects = trace_cascade(change, graph, 10);
            reclassify_effects(&mut effects);
            all_effects.extend(effects);
        }

        let auto_fixable: Vec<_> = all_effects
            .iter()
            .filter(|e| e.auto_fixable)
            .cloned()
            .collect();

        let fix_results = crate::impact::auto_fixer::apply_auto_fixes(&auto_fixable, false, None)?;

        return Ok(serde_json::json!({
            "autoFixed": fix_results.iter().filter(|r| r.applied).count(),
            "totalAutoFixable": auto_fixable.len(),
        }));
    }

    let mut reports = Vec::new();
    for change in &changes {
        let effects = trace_cascade(change, graph, 10);
        let tasks = if gen_tasks {
            generate_tasks(change, &effects)
        } else {
            Vec::new()
        };

        reports.push(ImpactReport {
            change: change.clone(),
            effects: effects.clone(),
            auto_fixed: effects.iter().filter(|e| e.auto_fixable).count(),
            needs_review: effects.iter().filter(|e| !e.auto_fixable).count(),
            tasks,
        });
    }

    Ok(serde_json::to_value(&reports)?)
}

fn handle_delete(req: &ServeRequest, graph: &DependencyGraph) -> Result<Value> {
    let file_str = req.args.get("file")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing file"))?;
    let dry_run = req.args.get("dryRun")
        .or_else(|| req.args.get("dry_run"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let file = PathBuf::from(file_str);
    let result = compute_delete(&file, graph)?;

    if !dry_run && file.exists() {
        std::fs::remove_file(&file)?;
    }

    let json = serde_json::json!({
        "targetFile": file,
        "affectedFiles": result.affected_files.iter().map(|af| {
            serde_json::json!({
                "path": af.path,
                "importsToRemove": af.imports_to_remove.iter().map(|i| {
                    serde_json::json!({
                        "line": i.line,
                        "specifier": i.specifier,
                        "fullLineRemoval": i.full_line_removal,
                    })
                }).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "reExportBreaks": result.re_export_breaks.iter().map(|b| {
            serde_json::json!({
                "file": b.file,
                "line": b.line,
                "symbol": b.symbol,
            })
        }).collect::<Vec<_>>(),
        "totalImportsRemoved": result.total_imports_removed,
        "dryRun": dry_run,
    });

    Ok(json)
}

fn handle_rename(req: &ServeRequest, graph: &DependencyGraph) -> Result<Value> {
    let file_str = req.args.get("file")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing file"))?;
    let old_name = req.args.get("oldName")
        .or_else(|| req.args.get("old_name"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing oldName"))?;
    let new_name = req.args.get("newName")
        .or_else(|| req.args.get("new_name"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing newName"))?;
    let dry_run = req.args.get("dryRun")
        .or_else(|| req.args.get("dry_run"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let file = PathBuf::from(file_str);
    let result = compute_rename(&file, old_name, new_name, graph)?;

    let json = serde_json::json!({
        "oldName": result.old_name,
        "newName": result.new_name,
        "sourceFile": result.source_file,
        "affectedFiles": result.affected_files.iter().map(|af| {
            serde_json::json!({
                "path": af.path,
                "rewrites": af.rewrites.iter().map(|rw| {
                    serde_json::json!({
                        "line": rw.line,
                        "oldText": rw.old_text,
                        "newText": rw.new_text,
                    })
                }).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "dynamicAccessWarnings": result.dynamic_access_warnings.iter().map(|w| {
            serde_json::json!({
                "file": w.file,
                "line": w.line,
                "context": w.context,
            })
        }).collect::<Vec<_>>(),
        "totalRewrites": result.total_rewrites,
        "dryRun": dry_run,
    });

    Ok(json)
}

fn handle_dead_code(req: &ServeRequest, project_root: &Path, graph: &DependencyGraph) -> Result<Value> {
    let entry_points: Vec<PathBuf> = req.args.get("entryPoints")
        .or_else(|| req.args.get("entry_points"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| {
                    let p = PathBuf::from(s);
                    if p.is_absolute() { p } else { project_root.join(p) }
                })
                .collect()
        })
        .unwrap_or_default();

    let result = find_dead_code(graph, &entry_points)?;
    Ok(serde_json::to_value(&result)?)
}

fn handle_ui_audit(
    _project_root: &Path,
    config: &ProjectConfig,
    graph: &DependencyGraph,
) -> Result<Value> {
    let mut enriched = HashMap::new();
    for file_path in graph.all_files() {
        if let Some(info) = graph.get_file_info(file_path) {
            enriched.insert(file_path.clone(), info.clone());
        }
    }

    let result = crate::ui_audit::auditor::audit_ui(graph, config, &enriched)?;
    Ok(serde_json::to_value(&result)?)
}

fn handle_deps_audit(
    project_root: &Path,
    config: &ProjectConfig,
    graph: &DependencyGraph,
) -> Result<Value> {
    let package_json_path = project_root.join("package.json");
    let result = crate::deps_audit::auditor::audit_deps(graph, config, &package_json_path)?;
    Ok(serde_json::to_value(&result)?)
}

fn handle_env_audit(
    req: &ServeRequest,
    project_root: &Path,
    config: &ProjectConfig,
    graph: &DependencyGraph,
) -> Result<Value> {
    let env_files: Vec<PathBuf> = req.args.get("envFiles")
        .or_else(|| req.args.get("env_files"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| project_root.join(s))
                .collect()
        })
        .unwrap_or_else(|| {
            [".env", ".env.local", ".env.production", ".env.example"]
                .iter()
                .map(|f| project_root.join(f))
                .filter(|f| f.exists())
                .collect()
        });

    let mut enriched = HashMap::new();
    for file_path in graph.all_files() {
        if let Some(info) = graph.get_file_info(file_path) {
            enriched.insert(file_path.clone(), info.clone());
        }
    }

    let result = crate::env_audit::auditor::audit_env(config, &env_files, &enriched)?;
    Ok(serde_json::to_value(&result)?)
}

fn handle_scan_routes(project_root: &Path, graph: &DependencyGraph) -> Result<Value> {
    let mut routes = Vec::new();

    for file_path in graph.all_files() {
        let rel = file_path
            .strip_prefix(project_root)
            .unwrap_or(file_path)
            .to_string_lossy()
            .replace('\\', "/");

        // Next.js App Router routes
        if let Some(route) = extract_nextjs_route(&rel) {
            routes.push(serde_json::json!({
                "file": rel,
                "route": route,
            }));
        }
    }

    routes.sort_by(|a, b| {
        let ar = a.get("route").and_then(|v| v.as_str()).unwrap_or("");
        let br = b.get("route").and_then(|v| v.as_str()).unwrap_or("");
        ar.cmp(br)
    });

    Ok(serde_json::json!({
        "projectRoot": project_root,
        "totalRoutes": routes.len(),
        "routes": routes,
    }))
}

fn extract_nextjs_route(rel: &str) -> Option<String> {
    // app/(.../)?route.(ts|js)x?
    let route_re = regex::Regex::new(r"^(?:src/)?app/(.+?)/route\.(ts|js)x?$").ok()?;
    let page_re = regex::Regex::new(r"^(?:src/)?app/(.+?)/page\.(ts|js)x?$").ok()?;
    let api_re = regex::Regex::new(r"^(?:src/)?pages/api/(.+?)\.(ts|js)x?$").ok()?;

    if let Some(caps) = route_re.captures(rel) {
        let mut route = caps[1].to_string();
        route = regex::Regex::new(r"\(.*?\)/?").ok()?.replace_all(&route, "").to_string();
        route = route.replace("[...", "*").replace("[", ":").replace("]", "");
        return Some(format!("/{}", route));
    }
    if let Some(caps) = page_re.captures(rel) {
        let mut route = caps[1].to_string();
        route = regex::Regex::new(r"\(.*?\)/?").ok()?.replace_all(&route, "").to_string();
        route = route.replace("[...", "*").replace("[", ":").replace("]", "");
        return Some(format!("/{}", route));
    }
    if let Some(caps) = api_re.captures(rel) {
        let mut route = caps[1].to_string();
        route = route.replace("[...", "*").replace("[", ":").replace("]", "");
        return Some(format!("/api/{}", route));
    }
    None
}

fn handle_rescan(
    project_root: &Path,
    config: &ProjectConfig,
    graph: &mut DependencyGraph,
) -> Result<Value> {
    *graph = DependencyGraph::build(project_root, config)
        .context("Failed to rebuild dependency graph")?;

    eprintln!(
        "[serve] Rescanned: {} files, {} edges",
        graph.file_count(),
        graph.edge_count()
    );

    Ok(serde_json::json!({
        "ok": true,
        "files": graph.file_count(),
        "edges": graph.edge_count(),
    }))
}
