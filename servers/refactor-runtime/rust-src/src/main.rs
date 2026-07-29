use anyhow::{Context, Result};
use clap::Parser;
use std::path::Path;

use refactor_runtime::audit::logger::AuditLogger;
use refactor_runtime::audit::rollback;
use refactor_runtime::cli::commands::{Cli, Commands, OutputFormat};
use refactor_runtime::config::loader::load_project_config;
use refactor_runtime::core::graph::DependencyGraph;
use refactor_runtime::core::types::*;
use refactor_runtime::impact::classifier::reclassify_effects;
use refactor_runtime::impact::detector::detect_changes;
use refactor_runtime::impact::task_generator::{format_task_summary, generate_tasks};
use refactor_runtime::impact::tracer::trace_cascade;
use refactor_runtime::move_op::mover::{compute_bulk_move, compute_folder_move, compute_move};
use refactor_runtime::move_op::rewriter::{apply_rewrites, move_file};
use refactor_runtime::move_op::route_scanner::apply_route_rewrites;
use refactor_runtime::delete_op::deleter::compute_delete;
use refactor_runtime::rename_op::renamer::compute_rename;
use refactor_runtime::deadcode::analyzer::find_dead_code;

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Scan { path, output } => cmd_scan(&path, &output),
        Commands::Move {
            old_path,
            new_path,
            dry_run,
            manifest,
            audit_log,
            output,
        } => {
            if let Some(manifest_path) = manifest {
                cmd_move_bulk(&manifest_path, dry_run, audit_log.as_deref(), &output)
            } else {
                cmd_move(&old_path, &new_path, dry_run, audit_log.as_deref(), &output)
            }
        }
        Commands::Analyze {
            path,
            circular,
            orphans,
            depth: _depth,
            output,
        } => cmd_analyze(&path, circular, orphans, _depth, &output),
        Commands::Impact {
            file,
            since,
            output,
            auto_fix,
            generate_tasks: gen_tasks,
        } => cmd_impact(&file, since.as_deref(), &output, auto_fix, gen_tasks),
        Commands::Rollback {
            audit_log,
            dry_run,
            output,
        } => cmd_rollback(&audit_log, dry_run, &output),
        Commands::Delete { file, dry_run, output } => cmd_delete(&file, dry_run, &output),
        Commands::Rename {
            file,
            old_name,
            new_name,
            dry_run,
            output,
        } => cmd_rename(&file, &old_name, &new_name, dry_run, &output),
        Commands::DeadCode {
            path,
            entry_points,
            output,
        } => cmd_dead_code(&path, &entry_points, &output),
        Commands::UiAudit { path, output } => cmd_ui_audit(&path, &output),
        Commands::DepsAudit { path, output } => cmd_deps_audit(&path, &output),
        Commands::EnvAudit {
            path,
            env_files,
            output,
        } => cmd_env_audit(&path, &env_files, &output),
        Commands::Serve { path } => refactor_runtime::serve::run_serve(path),
    }
}

fn cmd_scan(path: &Path, output: &OutputFormat) -> Result<()> {
    let config = load_project_config(path)?;
    let graph = DependencyGraph::build(path, &config)?;

    let by_lang = graph.files_by_language();
    let (total_imports, total_exports) = graph.import_export_counts();

    match output {
        OutputFormat::Json => {
            let result = ScanResult {
                project_root: path.to_path_buf(),
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
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        _ => {
            println!("Scan Results: {}", path.display());
            println!("{}", "=".repeat(50));
            println!("Total files: {}", graph.file_count());
            println!();
            println!("Files by language:");
            for (lang, count) in &by_lang {
                println!("  {}: {}", lang, count);
            }
            println!();
            println!("Total imports: {}", total_imports);
            println!("Total exports: {}", total_exports);
            println!("Total edges:   {}", graph.edge_count());
        }
    }

    Ok(())
}

fn cmd_move(
    old_path: &Path,
    new_path: &Path,
    dry_run: bool,
    audit_log_dir: Option<&Path>,
    output: &OutputFormat,
) -> Result<()> {
    // Find project root (walk up until we find package.json or tsconfig.json)
    let project_root = find_project_root(old_path)?;
    let config = load_project_config(&project_root)?;
    let graph = DependencyGraph::build(&project_root, &config)?;

    let mut audit_logger = audit_log_dir
        .map(AuditLogger::new)
        .transpose()?;

    let is_json = matches!(output, OutputFormat::Json);

    if dry_run && !is_json {
        println!("DRY RUN — no files will be modified\n");
    }

    if old_path.is_dir() {
        // Folder move
        let mut folder_result = compute_folder_move(old_path, new_path, &graph, &config)?;

        if !dry_run {
            let mut total_applied = 0;
            for result in &folder_result.results {
                let applied = apply_rewrites(result, false, audit_logger.as_mut())?;
                total_applied += applied.len();
            }
            if !folder_result.route_changes.is_empty() {
                apply_route_rewrites(&mut folder_result.route_changes, false)?;
            }
            for op in &folder_result.operations {
                move_file(&op.old_path, &op.new_path, false)?;
            }
            if let Some(ref mut logger) = audit_logger {
                logger.log(AuditEntry {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    operation: AuditOperation::Move,
                    file: old_path.to_path_buf(),
                    old_content: old_path.to_string_lossy().to_string(),
                    new_content: new_path.to_string_lossy().to_string(),
                    line: 0,
                    rollbackable: true,
                })?;
                logger.flush()?;
            }

            if !is_json {
                println!("Applied {} import rewrites", total_applied);
                println!("{} files moved successfully", folder_result.files_moved);
            }
        }

        if is_json {
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
            println!("{}", serde_json::to_string_pretty(&json)?);
        } else {
            println!(
                "Folder move: {} -> {}",
                old_path.display(),
                new_path.display()
            );
            println!("Files to move: {}", folder_result.files_moved);
            println!("Total files needing import updates: {}", folder_result.total_files_updated);

            for result in &folder_result.results {
                if !result.affected_files.is_empty() {
                    println!(
                        "  {} -> {}",
                        result.operation.old_path.display(),
                        result.operation.new_path.display()
                    );
                    for affected in &result.affected_files {
                        println!(
                            "    {}:{} — \"{}\" -> \"{}\"",
                            affected.path.display(),
                            affected.line,
                            affected.old_import,
                            affected.new_import
                        );
                    }
                }
            }

            if !folder_result.route_changes.is_empty() {
                println!("\nRoute changes ({}):", folder_result.route_changes.len());
                for rc in &folder_result.route_changes {
                    println!(
                        "  {}:{} — \"{}\" -> \"{}\"",
                        rc.file.display(),
                        rc.line,
                        rc.old_route,
                        rc.new_route
                    );
                }
            }
        }
    } else {
        // Single file move
        let mut result = compute_move(old_path, new_path, &graph, &config)?;

        if !dry_run {
            let applied = apply_rewrites(&result, false, audit_logger.as_mut())?;
            if !result.route_changes.is_empty() {
                apply_route_rewrites(&mut result.route_changes, false)?;
            }
            move_file(old_path, new_path, false)?;
            if let Some(ref mut logger) = audit_logger {
                logger.log(AuditEntry {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    operation: AuditOperation::Move,
                    file: old_path.to_path_buf(),
                    old_content: old_path.to_string_lossy().to_string(),
                    new_content: new_path.to_string_lossy().to_string(),
                    line: 0,
                    rollbackable: true,
                })?;
                logger.flush()?;
            }

            if !is_json {
                println!("Applied {} rewrites", applied.len());
                println!("File moved successfully");
            }
        }

        if is_json {
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
            println!("{}", serde_json::to_string_pretty(&json)?);
        } else {
            println!(
                "Move: {} -> {}",
                old_path.display(),
                new_path.display()
            );
            println!("Affected files: {}\n", result.affected_files.len());

            for affected in &result.affected_files {
                println!(
                    "  {}:{} — \"{}\" -> \"{}\"",
                    affected.path.display(),
                    affected.line,
                    affected.old_import,
                    affected.new_import
                );
            }

            if !result.route_changes.is_empty() {
                println!("\nRoute changes ({}):", result.route_changes.len());
                for rc in &result.route_changes {
                    println!(
                        "  {}:{} — \"{}\" -> \"{}\"",
                        rc.file.display(),
                        rc.line,
                        rc.old_route,
                        rc.new_route
                    );
                }
            }
        }
    }

    Ok(())
}

fn cmd_move_bulk(
    manifest_path: &Path,
    dry_run: bool,
    audit_log_dir: Option<&Path>,
    output: &OutputFormat,
) -> Result<()> {
    let manifest_content = std::fs::read_to_string(manifest_path)
        .context("Failed to read manifest file")?;
    let mut manifest: MoveManifest = serde_json::from_str(&manifest_content)
        .context("Failed to parse manifest JSON")?;
    manifest.dry_run = dry_run;

    let config = load_project_config(&manifest.project_root)?;
    let graph = DependencyGraph::build(&manifest.project_root, &config)?;

    let results = compute_bulk_move(&manifest, &graph, &config)?;

    let mut audit_logger = audit_log_dir
        .map(AuditLogger::new)
        .transpose()?;

    let is_json = matches!(output, OutputFormat::Json);

    if dry_run && !is_json {
        println!("DRY RUN — no files will be modified\n");
    }

    if !dry_run {
        for result in &results {
            let applied = apply_rewrites(result, false, audit_logger.as_mut())?;
            move_file(&result.operation.old_path, &result.operation.new_path, false)?;
            if !is_json {
                println!(
                    "Move: {} -> {} — Applied {} rewrites, file moved",
                    result.operation.old_path.display(),
                    result.operation.new_path.display(),
                    applied.len()
                );
            }
        }

        if let Some(ref logger) = audit_logger {
            let log_path = logger.flush()?;
            if !is_json {
                println!("\nAudit log: {}", log_path.display());
            }
        }
    }

    if is_json {
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
            "dryRun": dry_run,
        });
        println!("{}", serde_json::to_string_pretty(&json)?);
    } else if dry_run {
        for result in &results {
            println!(
                "Move: {} -> {} ({} affected files)",
                result.operation.old_path.display(),
                result.operation.new_path.display(),
                result.affected_files.len()
            );
        }
    }

    Ok(())
}

fn cmd_analyze(
    path: &Path,
    circular: bool,
    orphans: bool,
    _depth: Option<usize>,
    output: &OutputFormat,
) -> Result<()> {
    let config = load_project_config(path)?;
    let graph = DependencyGraph::build(path, &config)?;

    let by_lang = graph.files_by_language();
    let (total_imports, total_exports) = graph.import_export_counts();

    match output {
        OutputFormat::Json => {
            let mut result = serde_json::json!({
                "project_root": path,
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

            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        OutputFormat::Dot => {
            println!("digraph dependencies {{");
            println!("  rankdir=LR;");
            for file in graph.all_files() {
                let deps = graph.dependencies(file);
                let from_label = file
                    .strip_prefix(path)
                    .unwrap_or(file)
                    .to_string_lossy();
                for dep in deps {
                    let to_label = dep
                        .strip_prefix(path)
                        .unwrap_or(&dep)
                        .to_string_lossy();
                    println!("  \"{}\" -> \"{}\";", from_label, to_label);
                }
            }
            println!("}}");
        }
        _ => {
            println!("Dependency Analysis: {}", path.display());
            println!("{}", "=".repeat(50));
            println!("Total files:   {}", graph.file_count());
            println!("Total edges:   {}", graph.edge_count());
            println!("Total imports: {}", total_imports);
            println!("Total exports: {}", total_exports);
            println!();
            println!("Files by language:");
            for (lang, count) in &by_lang {
                println!("  {}: {}", lang, count);
            }

            if circular {
                println!();
                let cycles = graph.find_circular_deps();
                if cycles.is_empty() {
                    println!("No circular dependencies found.");
                } else {
                    println!("Circular dependencies ({}):", cycles.len());
                    for (i, cycle) in cycles.iter().enumerate() {
                        println!(
                            "  Cycle {}: {}",
                            i + 1,
                            cycle
                                .iter()
                                .map(|p| p
                                    .strip_prefix(path)
                                    .unwrap_or(p)
                                    .to_string_lossy()
                                    .to_string())
                                .collect::<Vec<_>>()
                                .join(" -> ")
                        );
                    }
                }
            }

            if orphans {
                println!();
                let orphan_list = graph.find_orphans();
                if orphan_list.is_empty() {
                    println!("No orphaned modules found.");
                } else {
                    println!("Orphaned modules ({}):", orphan_list.len());
                    for orphan in &orphan_list {
                        println!(
                            "  {}",
                            orphan
                                .strip_prefix(path)
                                .unwrap_or(orphan)
                                .to_string_lossy()
                        );
                    }
                }
            }
        }
    }

    Ok(())
}

fn cmd_impact(
    file: &Path,
    since: Option<&str>,
    output: &OutputFormat,
    auto_fix: bool,
    gen_tasks: bool,
) -> Result<()> {
    let project_root = find_project_root(file)?;
    let config = load_project_config(&project_root)?;
    let graph = DependencyGraph::build(&project_root, &config)?;

    // Get old version from git if --since is provided
    let old_source = if let Some(commit) = since {
        let relative = file
            .strip_prefix(&project_root)
            .unwrap_or(file)
            .to_string_lossy();

        let output_result = std::process::Command::new("git")
            .args(["show", &format!("{}:{}", commit, relative)])
            .current_dir(&project_root)
            .output()
            .context("Failed to run git show")?;

        if output_result.status.success() {
            String::from_utf8_lossy(&output_result.stdout).to_string()
        } else {
            anyhow::bail!(
                "Failed to get file from commit {}: {}",
                commit,
                String::from_utf8_lossy(&output_result.stderr)
            );
        }
    } else {
        anyhow::bail!("--since <commit> is required for impact analysis (compare against a git commit)");
    };

    let new_source = std::fs::read_to_string(file)
        .with_context(|| format!("Failed to read file: {}", file.display()))?;

    let language = file
        .extension()
        .and_then(|e| e.to_str())
        .and_then(Language::from_extension)
        .unwrap_or(Language::TypeScript);

    let changes = detect_changes(&old_source, &new_source, file, language)?;

    if changes.is_empty() {
        println!("No exported changes detected.");
        return Ok(());
    }

    let mut all_effects: Vec<CascadeEffect> = Vec::new();

    for change in &changes {
        let mut effects = trace_cascade(change, &graph, 10);
        reclassify_effects(&mut effects);
        all_effects.extend(effects);
    }

    if auto_fix {
        let auto_fixable: Vec<_> = all_effects
            .iter()
            .filter(|e| e.auto_fixable)
            .cloned()
            .collect();

        let fix_results = refactor_runtime::impact::auto_fixer::apply_auto_fixes(
            &auto_fixable,
            false,
            None,
        )?;

        println!(
            "Auto-fixed {} of {} effects",
            fix_results.iter().filter(|r| r.applied).count(),
            auto_fixable.len()
        );
    }

    match output {
        OutputFormat::Json => {
            let mut reports = Vec::new();
            for change in &changes {
                let effects = trace_cascade(change, &graph, 10);
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
            println!("{}", serde_json::to_string_pretty(&reports)?);
        }
        _ => {
            println!("Impact Analysis: {}", file.display());
            println!("{}", "=".repeat(50));
            println!("Changes detected: {}", changes.len());

            for change in &changes {
                println!(
                    "\n  {} '{}' ({:?})",
                    match change.change_type {
                        ChangeType::Removed => "REMOVED",
                        ChangeType::Renamed => "RENAMED",
                        _ => "CHANGED",
                    },
                    change.entity,
                    change.change_type
                );
                if let Some(ref old) = change.old_signature {
                    println!("    Old: {}", old);
                }
                if let Some(ref new) = change.new_signature {
                    println!("    New: {}", new);
                }
            }

            println!(
                "\nTotal cascade effects: {} ({} auto-fixable, {} need review)",
                all_effects.len(),
                all_effects.iter().filter(|e| e.auto_fixable).count(),
                all_effects.iter().filter(|e| !e.auto_fixable).count()
            );

            for effect in &all_effects {
                println!(
                    "\n  [depth={}] {}:{} — {:?}",
                    effect.depth,
                    effect.file.display(),
                    effect.line,
                    effect.classification
                );
                println!("    {}", effect.description);
                if let Some(ref fix) = effect.suggested_fix {
                    println!("    Fix: {}", fix);
                }
            }

            if gen_tasks {
                println!();
                for change in &changes {
                    let effects = trace_cascade(change, &graph, 10);
                    let tasks = generate_tasks(change, &effects);
                    print!("{}", format_task_summary(&tasks));
                }
            }
        }
    }

    Ok(())
}

fn cmd_rollback(audit_log_path: &Path, dry_run: bool, output: &OutputFormat) -> Result<()> {
    if dry_run && !matches!(output, OutputFormat::Json) {
        println!("DRY RUN — no files will be modified\n");
    }

    let actions = rollback::rollback(audit_log_path, dry_run)?;

    match output {
        OutputFormat::Json => {
            let succeeded = actions.iter().filter(|a| a.success).count();
            let failed = actions.iter().filter(|a| !a.success).count();
            let json = serde_json::json!({
                "auditLog": audit_log_path,
                "totalActions": actions.len(),
                "successful": succeeded,
                "failed": failed,
                "dryRun": dry_run,
                "actions": actions.iter().map(|a| {
                    serde_json::json!({
                        "file": a.file,
                        "action": a.action,
                        "success": a.success,
                    })
                }).collect::<Vec<_>>(),
            });
            println!("{}", serde_json::to_string_pretty(&json)?);
        }
        _ => {
            for action in &actions {
                let status = if action.success { "OK" } else { "FAILED" };
                println!(
                    "[{}] {} — {}",
                    status,
                    action.file.display(),
                    action.action
                );
            }

            let succeeded = actions.iter().filter(|a| a.success).count();
            let failed = actions.iter().filter(|a| !a.success).count();
            println!(
                "\nRollback complete: {} succeeded, {} failed",
                succeeded, failed
            );
        }
    }

    Ok(())
}

fn cmd_delete(file: &Path, dry_run: bool, output: &OutputFormat) -> Result<()> {
    let project_root = find_project_root(file)?;
    let config = load_project_config(&project_root)?;
    let graph = DependencyGraph::build(&project_root, &config)?;

    let result = compute_delete(file, &graph)?;

    if !dry_run {
        if file.exists() {
            std::fs::remove_file(file)?;
        }
    }

    match output {
        OutputFormat::Json => {
            let json = serde_json::json!({
                "targetFile": file,
                "affectedFiles": result.affected_files.iter().map(|af| {
                    serde_json::json!({
                        "path": af.path,
                        "importsToRemove": af.imports_to_remove.iter().map(|i| {
                            serde_json::json!({ "line": i.line, "specifier": i.specifier, "fullLineRemoval": i.full_line_removal })
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
            println!("{}", serde_json::to_string_pretty(&json)?);
        }
        _ => {
            if dry_run {
                println!("DRY RUN — no files will be modified\n");
            }

            println!("Delete: {}", file.display());
            println!("Total imports to remove: {}", result.total_imports_removed);
            println!("Affected files: {}", result.affected_files.len());

            for affected in &result.affected_files {
                println!(
                    "  {} — {} import(s) to remove",
                    affected.path.display(),
                    affected.imports_to_remove.len()
                );
            }

            if !result.re_export_breaks.is_empty() {
                println!("\nRe-export breaks:");
                for brk in &result.re_export_breaks {
                    println!("  {}:{} — re-exports '{}'", brk.file.display(), brk.line, brk.symbol);
                }
            }

            if !dry_run {
                println!("\nFile deleted: {}", file.display());
            }
        }
    }

    Ok(())
}

fn cmd_rename(file: &Path, old_name: &str, new_name: &str, dry_run: bool, output: &OutputFormat) -> Result<()> {
    let project_root = find_project_root(file)?;
    let config = load_project_config(&project_root)?;
    let graph = DependencyGraph::build(&project_root, &config)?;

    let result = compute_rename(file, old_name, new_name, &graph)?;

    match output {
        OutputFormat::Json => {
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
            println!("{}", serde_json::to_string_pretty(&json)?);
        }
        _ => {
            if dry_run {
                println!("DRY RUN — no files will be modified\n");
            }

            println!("Rename: '{}' -> '{}'", result.old_name, result.new_name);
            println!("Source file: {}", result.source_file.display());
            println!("Total rewrites: {}", result.total_rewrites);
            println!("Affected files: {}", result.affected_files.len());

            for affected in &result.affected_files {
                println!(
                    "  {} — {} rewrite(s)",
                    affected.path.display(),
                    affected.rewrites.len()
                );
                for rw in &affected.rewrites {
                    println!("    line {}: '{}' -> '{}'", rw.line, rw.old_text, rw.new_text);
                }
            }

            if !result.dynamic_access_warnings.is_empty() {
                println!("\nDynamic access warnings:");
                for w in &result.dynamic_access_warnings {
                    println!("  {}:{} — {}", w.file.display(), w.line, w.context);
                }
            }
        }
    }

    Ok(())
}

fn cmd_dead_code(path: &Path, entry_points: &[std::path::PathBuf], output: &OutputFormat) -> Result<()> {
    let config = load_project_config(path)?;
    let graph = DependencyGraph::build(path, &config)?;

    // If no explicit entry points, auto-detect Next.js app router entry points
    let effective_entry_points = if entry_points.is_empty() {
        auto_detect_entry_points(path, &graph)
    } else {
        entry_points.to_vec()
    };

    let result = find_dead_code(&graph, &effective_entry_points)?;

    match output {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        _ => {
            println!("Dead Code Analysis: {}", path.display());
            println!("{}", "=".repeat(50));
            println!("Entry points: {}", result.entry_points.len());
            println!("Reachable files: {}", result.reachable_files);
            println!("Dead files: {}", result.dead_files.len());
            println!("Dead exports: {}", result.dead_exports.len());
            println!("Total dead lines: {}", result.total_dead_lines);

            if !result.dead_files.is_empty() {
                println!("\nDead files:");
                for df in &result.dead_files {
                    println!(
                        "  {} ({:?}, {} lines) — {}",
                        df.path.display(),
                        df.confidence,
                        df.line_count,
                        df.reason
                    );
                }
            }

            if !result.dead_exports.is_empty() {
                println!("\nDead exports:");
                for de in &result.dead_exports {
                    println!(
                        "  {}:{} — '{}' ({:?})",
                        de.file.display(),
                        de.line,
                        de.export_name,
                        de.confidence
                    );
                }
            }
        }
    }

    Ok(())
}

fn cmd_ui_audit(path: &Path, output: &OutputFormat) -> Result<()> {
    let config = load_project_config(path)?;
    let graph = DependencyGraph::build(path, &config)?;

    // Build enriched files map with JSX element parsing
    let mut enriched = std::collections::HashMap::new();
    for file_path in graph.all_files() {
        let is_jsx = file_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e == "tsx" || e == "jsx")
            .unwrap_or(false);

        if !is_jsx {
            continue;
        }

        let lang = file_path
            .extension()
            .and_then(|e| e.to_str())
            .and_then(Language::from_extension)
            .unwrap_or(Language::TypeScript);

        let mut parser = match refactor_runtime::core::parser::SourceParser::new() {
            Ok(p) => p,
            Err(_) => continue,
        };

        let enrichments = Enrichments {
            jsx_elements: true,
            symbol_usages: false,
            env_references: false,
            call_sites: false,
        };

        if let Ok((imports, exports, data)) = parser.parse_file_enriched(file_path, lang, enrichments) {
            let relative_path = file_path
                .strip_prefix(path)
                .unwrap_or(file_path)
                .to_string_lossy()
                .to_string();

            enriched.insert(file_path.clone(), FileInfo {
                path: file_path.clone(),
                relative_path,
                imports,
                exports,
                language: lang,
                symbol_usages: None,
                jsx_elements: data.jsx_elements,
                env_references: None,
                call_sites: None,
            });
        }
    }

    let result = refactor_runtime::ui_audit::auditor::audit_ui(&graph, &config, &enriched)?;

    match output {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        _ => {
            println!("UI Audit: {}", path.display());
            println!("{}", "=".repeat(50));
            println!("Components scanned: {}", result.total_components_scanned);
            println!("Total findings: {}", result.findings.len());
            println!("  Missing handlers: {}", result.summary.missing_handlers);
            println!("  Unused state: {}", result.summary.unused_state);
            println!("  Missing keys: {}", result.summary.missing_keys);
            println!("  Dead components: {}", result.summary.dead_components);

            for f in &result.findings {
                println!(
                    "\n  [{:?}] {}:{} — {}",
                    f.severity, f.file.display(), f.line, f.description
                );
            }
        }
    }

    Ok(())
}

fn cmd_deps_audit(path: &Path, output: &OutputFormat) -> Result<()> {
    let config = load_project_config(path)?;
    let graph = DependencyGraph::build(path, &config)?;

    let package_json_path = path.join("package.json");
    let result = refactor_runtime::deps_audit::auditor::audit_deps(&graph, &config, &package_json_path)?;

    match output {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        _ => {
            println!("Dependency Audit: {}", path.display());
            println!("{}", "=".repeat(50));
            println!("Declared: {}", result.total_declared);
            println!("Used: {}", result.total_used);

            if !result.unused_deps.is_empty() {
                println!("\nUnused dependencies:");
                for dep in &result.unused_deps {
                    println!("  {}{}", dep.name, if dep.is_dev { " (dev)" } else { "" });
                }
            }

            if !result.undeclared_deps.is_empty() {
                println!("\nUndeclared dependencies:");
                for dep in &result.undeclared_deps {
                    println!("  {} — used in: {:?}", dep.name, dep.used_in);
                }
            }
        }
    }

    Ok(())
}

fn cmd_env_audit(path: &Path, env_files: &[std::path::PathBuf], output: &OutputFormat) -> Result<()> {
    let config = load_project_config(path)?;
    let graph = DependencyGraph::build(path, &config)?;

    let env_file_paths: Vec<std::path::PathBuf> = if env_files.is_empty() {
        [".env", ".env.local", ".env.production", ".env.example"]
            .iter()
            .map(|f| path.join(f))
            .filter(|f| f.exists())
            .collect()
    } else {
        env_files.iter().map(|f| path.join(f)).collect()
    };

    // Build enriched files map
    let mut enriched = std::collections::HashMap::new();
    for file_path in graph.all_files() {
        if let Some(info) = graph.get_file_info(file_path) {
            enriched.insert(file_path.clone(), info.clone());
        }
    }

    let result = refactor_runtime::env_audit::auditor::audit_env(&config, &env_file_paths, &enriched)?;

    match output {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        _ => {
            println!("Env Audit: {}", path.display());
            println!("{}", "=".repeat(50));
            println!("Declared: {}", result.total_declared);
            println!("Referenced: {}", result.total_referenced);

            if !result.stale_vars.is_empty() {
                println!("\nStale variables:");
                for v in &result.stale_vars {
                    println!("  {} — declared in: {}", v.name, v.declared_in.join(", "));
                }
            }

            if !result.missing_vars.is_empty() {
                println!("\nMissing variables:");
                for v in &result.missing_vars {
                    println!("  {}", v.name);
                }
            }

            if !result.inconsistent_vars.is_empty() {
                println!("\nInconsistent variables:");
                for v in &result.inconsistent_vars {
                    println!(
                        "  {} — present in: {} | missing from: {}",
                        v.name,
                        v.present_in.join(", "),
                        v.missing_from.join(", ")
                    );
                }
            }
        }
    }

    Ok(())
}

/// Auto-detect Next.js app router entry points (pages, layouts, routes, etc.)
fn auto_detect_entry_points(project_root: &Path, graph: &DependencyGraph) -> Vec<std::path::PathBuf> {
    let nextjs_entry_names: std::collections::HashSet<&str> = [
        "page", "layout", "route", "loading", "error", "not-found",
        "template", "default", "middleware", "global-error",
    ].iter().copied().collect();

    let mut entry_points = Vec::new();

    for file_path in graph.all_files() {
        let stem = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        if nextjs_entry_names.contains(stem) {
            entry_points.push(file_path.clone());
            continue;
        }

        // Also treat top-level config files as entry points
        if let Ok(relative) = file_path.strip_prefix(project_root) {
            let depth = relative.components().count();
            if depth == 1 {
                // Top-level files like next.config.ts, tailwind.config.ts, etc.
                entry_points.push(file_path.clone());
            }
        }
    }

    entry_points
}

fn find_project_root(starting_path: &Path) -> Result<std::path::PathBuf> {
    let mut current = if starting_path.is_file() {
        starting_path
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf()
    } else {
        starting_path.to_path_buf()
    };

    loop {
        if current.join("package.json").exists()
            || current.join("tsconfig.json").exists()
            || current.join("Cargo.toml").exists()
        {
            return Ok(current);
        }

        if !current.pop() {
            break;
        }
    }

    // Fallback to starting path
    Ok(if starting_path.is_file() {
        starting_path
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf()
    } else {
        starting_path.to_path_buf()
    })
}
