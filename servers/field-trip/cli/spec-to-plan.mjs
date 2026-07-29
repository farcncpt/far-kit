#!/usr/bin/env node
/**
 * Spec-to-Plan — Convert a video-digest JSON spec into an actionable project plan.
 *
 * Takes the structured requirements spec from video-digest.mjs and generates:
 * - A project scaffold plan (which files to create)
 * - A task list for the agent
 * - A CLAUDE.md section with project requirements
 * - Component list with expected DOM structure
 *
 * Usage:
 *   node cli/spec-to-plan.mjs spec.json [--output project-plan.md]
 *   node cli/spec-to-plan.mjs spec.json --format json --output plan.json
 *   node cli/spec-to-plan.mjs spec.json --claude-md   — output only CLAUDE.md section
 */

import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

// ─── Utilities ───

function progress(msg) {
  process.stderr.write(`\x1b[36m[spec-to-plan]\x1b[0m ${msg}\n`)
}

function error(msg) {
  process.stderr.write(`\x1b[31m[spec-to-plan] ERROR:\x1b[0m ${msg}\n`)
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function pascalCase(name) {
  return name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("")
}

function kebabCase(name) {
  return slugify(name)
}

// ─── Plan generators ───

function generateScaffold(spec) {
  const files = []
  const projectSlug = slugify(spec.project?.name || "project")

  // Root config files
  files.push({ path: "package.json", type: "config", description: "Project dependencies and scripts" })
  files.push({ path: "next.config.js", type: "config", description: "Next.js configuration" })
  files.push({ path: "tailwind.config.ts", type: "config", description: "Tailwind CSS configuration with brand colors/fonts" })
  files.push({ path: "tsconfig.json", type: "config", description: "TypeScript configuration" })

  // App layout
  files.push({ path: "src/app/layout.tsx", type: "layout", description: "Root layout with fonts, metadata, navigation" })
  files.push({ path: "src/app/globals.css", type: "styles", description: "Global styles and Tailwind directives" })

  // Components - shared
  files.push({ path: "src/components/ui/button.tsx", type: "component", description: "Button component" })
  files.push({ path: "src/components/layout/header.tsx", type: "component", description: "Site header with navigation" })
  files.push({ path: "src/components/layout/footer.tsx", type: "component", description: "Site footer" })

  // Pages from spec
  const pages = spec.pages || []
  for (const page of pages) {
    const pagePath = page.path || `/${slugify(page.name)}`
    const dirPath = pagePath === "/" ? "src/app" : `src/app${pagePath}`
    files.push({
      path: `${dirPath}/page.tsx`,
      type: "page",
      description: `${page.name} page — ${page.description || ""}`.trim(),
    })

    // Section components for this page
    const sections = page.sections || []
    for (const section of sections) {
      const componentName = pascalCase(section.name)
      files.push({
        path: `src/components/sections/${kebabCase(section.name)}.tsx`,
        type: "component",
        description: `${componentName} section — ${section.description || ""}`.trim(),
        page: page.name,
      })

      // Sub-components
      for (const comp of section.components || []) {
        files.push({
          path: `src/components/ui/${kebabCase(comp)}.tsx`,
          type: "component",
          description: `${comp} component used in ${section.name}`,
          page: page.name,
        })
      }
    }
  }

  // Feature-driven files
  const features = spec.features || []
  for (const feature of features) {
    const cat = feature.category?.toLowerCase()
    if (cat === "auth") {
      files.push({ path: "src/app/api/auth/[...nextauth]/route.ts", type: "api", description: "Auth API route" })
      files.push({ path: "src/components/auth/login-form.tsx", type: "component", description: "Login form component" })
      files.push({ path: "src/components/auth/signup-form.tsx", type: "component", description: "Sign-up form component" })
    } else if (cat === "payments") {
      files.push({ path: "src/app/api/payments/route.ts", type: "api", description: "Payment processing API" })
      files.push({ path: "src/components/payments/checkout.tsx", type: "component", description: "Checkout component" })
    } else if (cat === "forms") {
      files.push({ path: `src/components/forms/${kebabCase(feature.name)}.tsx`, type: "component", description: feature.description })
    } else if (cat === "cms") {
      files.push({ path: "src/lib/cms.ts", type: "lib", description: "CMS client and data fetching" })
    } else if (cat === "email") {
      files.push({ path: "src/app/api/contact/route.ts", type: "api", description: "Contact form / email API" })
    }
  }

  // Deduplicate by path
  const seen = new Set()
  return files.filter((f) => {
    if (seen.has(f.path)) return false
    seen.add(f.path)
    return true
  })
}

function generateTaskList(spec, scaffold) {
  const tasks = []
  let taskNum = 0

  function task(phase, title, details, priority = "required") {
    tasks.push({ id: ++taskNum, phase, title, details, priority, done: false })
  }

  // Phase 1: Project Setup
  task("setup", "Initialize Next.js project", "npx create-next-app with TypeScript, Tailwind, App Router")
  task("setup", "Configure Tailwind with brand colors and fonts", buildTailwindConfig(spec.design))
  task("setup", "Set up project structure", `Create directories:\n${scaffold.map((f) => `  ${f.path}`).join("\n")}`)

  // Phase 2: Layout & Navigation
  const navItems = spec.content?.navigation || []
  task("layout", "Build root layout", `Set up fonts, metadata, and shared layout.\nTitle: ${spec.project?.name || "Project"}`)
  task("layout", "Build header/navigation", `Nav items: ${navItems.length > 0 ? navItems.join(", ") : "derive from pages"}`)
  task("layout", "Build footer", "Footer with links, copyright, social icons if applicable")

  // Phase 3: Pages
  const pages = spec.pages || []
  for (const page of pages) {
    const sections = page.sections || []
    const sectionList = sections.map((s) => `  - ${s.name}: ${s.description || ""}`.trim()).join("\n")
    task(
      "pages",
      `Build ${page.name} page (${page.path || "/" + slugify(page.name)})`,
      `${page.description || ""}\n\nSections:\n${sectionList}`.trim()
    )

    for (const section of sections) {
      task(
        "components",
        `Build ${pascalCase(section.name)} section component`,
        `${section.description || ""}\nComponents needed: ${(section.components || []).join(", ") || "none specified"}`,
        "required"
      )
    }
  }

  // Phase 4: Features
  const features = spec.features || []
  for (const feature of features) {
    task(
      "features",
      `Implement: ${feature.name}`,
      `${feature.description || ""}\nCategory: ${feature.category || "general"}`,
      feature.priority || "required"
    )
  }

  // Phase 5: Content & Polish
  task("content", "Add page content and copy", spec.content?.copy_notes || "Use placeholder content matching brand voice")
  task("content", "Add CTA buttons and links", `CTAs: ${(spec.content?.cta_text || []).join(", ") || "determine from design"}`)

  // Phase 6: Testing
  task("testing", "Verify all pages render without errors", "Scan each page via CLI, check for console errors")
  task("testing", "Verify responsive layout", "Test at mobile (375px), tablet (768px), and desktop (1440px)")
  task("testing", "Verify navigation flow", "Click through all nav links, ensure correct routing")

  // Phase 7: Acceptance criteria
  const criteria = spec.acceptance_criteria || []
  for (const criterion of criteria) {
    task("validation", `Verify: ${criterion.slice(0, 80)}`, criterion, "required")
  }

  return tasks
}

function buildTailwindConfig(design) {
  if (!design) return "Configure with default colors"
  const parts = []
  if (design.colors?.primary) parts.push(`Primary: ${design.colors.primary}`)
  if (design.colors?.secondary) parts.push(`Secondary: ${design.colors.secondary}`)
  if (design.colors?.accent) parts.push(`Accent: ${design.colors.accent}`)
  if (design.fonts?.heading) parts.push(`Heading font: ${design.fonts.heading}`)
  if (design.fonts?.body) parts.push(`Body font: ${design.fonts.body}`)
  if (design.style) parts.push(`Style: ${design.style}`)
  return parts.length > 0 ? parts.join("\n") : "Configure with default colors"
}

function generateComponentDomSpec(spec) {
  const components = []
  const pages = spec.pages || []

  for (const page of pages) {
    for (const section of page.sections || []) {
      const comp = {
        name: pascalCase(section.name),
        file: `src/components/sections/${kebabCase(section.name)}.tsx`,
        page: page.name,
        description: section.description || "",
        expectedDom: {
          container: {
            tag: "section",
            attributes: { "data-section": kebabCase(section.name) },
          },
          children: [],
        },
      }

      // Infer DOM structure from section name
      const nameLC = section.name.toLowerCase()
      if (nameLC.includes("hero")) {
        comp.expectedDom.children.push(
          { tag: "h1", description: "Main heading" },
          { tag: "p", description: "Subheading or description" },
          { tag: "a|button", role: "cta", description: "Primary call-to-action" }
        )
      } else if (nameLC.includes("feature") || nameLC.includes("grid")) {
        comp.expectedDom.children.push(
          { tag: "h2", description: "Section heading" },
          { tag: "div", role: "grid", description: "Grid container for cards" }
        )
      } else if (nameLC.includes("testimonial")) {
        comp.expectedDom.children.push(
          { tag: "h2", description: "Section heading" },
          { tag: "blockquote|div", role: "testimonial", description: "Testimonial cards" }
        )
      } else if (nameLC.includes("contact") || nameLC.includes("form")) {
        comp.expectedDom.children.push(
          { tag: "h2", description: "Section heading" },
          { tag: "form", description: "Contact/input form" }
        )
      } else if (nameLC.includes("nav") || nameLC.includes("header")) {
        comp.expectedDom.children.push(
          { tag: "nav", description: "Navigation container" },
          { tag: "a", role: "nav-link", description: "Navigation links", multiple: true }
        )
      } else if (nameLC.includes("footer")) {
        comp.expectedDom.children.push(
          { tag: "footer", description: "Footer container" },
          { tag: "a", description: "Footer links", multiple: true }
        )
      } else {
        comp.expectedDom.children.push(
          { tag: "h2", description: "Section heading" },
          { tag: "div", description: "Section content" }
        )
      }

      // Add sub-components
      for (const subComp of section.components || []) {
        comp.expectedDom.children.push({
          tag: "div",
          component: subComp,
          description: `${subComp} component`,
        })
      }

      components.push(comp)
    }
  }

  return components
}

// ─── Output formatters ───

function formatMarkdown(spec, scaffold, tasks, components) {
  const lines = []
  const projectName = spec.project?.name || "Untitled Project"

  lines.push(`# Project Plan: ${projectName}`)
  lines.push("")
  lines.push(`> Generated by \`spec-to-plan\` on ${new Date().toISOString().split("T")[0]}`)
  lines.push(`> Source: ${spec._meta?.source_file || "unknown"}`)
  lines.push("")

  // Project overview
  lines.push("## Project Overview")
  lines.push("")
  if (spec.project?.description) lines.push(spec.project.description)
  if (spec.project?.type) lines.push(`\n**Type:** ${spec.project.type}`)
  lines.push("")

  // Design
  if (spec.design) {
    lines.push("## Design Direction")
    lines.push("")
    if (spec.design.style) lines.push(`**Style:** ${spec.design.style}`)
    if (spec.design.mood) lines.push(`**Mood:** ${spec.design.mood}`)
    if (spec.design.colors) {
      lines.push("\n**Colors:**")
      for (const [k, v] of Object.entries(spec.design.colors)) {
        if (v && k !== "notes") lines.push(`- ${k}: \`${v}\``)
      }
      if (spec.design.colors.notes) lines.push(`- Notes: ${spec.design.colors.notes}`)
    }
    if (spec.design.fonts) {
      lines.push("\n**Typography:**")
      if (spec.design.fonts.heading) lines.push(`- Heading: ${spec.design.fonts.heading}`)
      if (spec.design.fonts.body) lines.push(`- Body: ${spec.design.fonts.body}`)
      if (spec.design.fonts.notes) lines.push(`- Notes: ${spec.design.fonts.notes}`)
    }
    lines.push("")
  }

  // File scaffold
  lines.push("## File Scaffold")
  lines.push("")
  lines.push("```")
  const byType = {}
  for (const f of scaffold) {
    const t = f.type || "other"
    if (!byType[t]) byType[t] = []
    byType[t].push(f)
  }
  for (const [type, files] of Object.entries(byType)) {
    lines.push(`# ${type}`)
    for (const f of files) {
      lines.push(`${f.path}`)
    }
    lines.push("")
  }
  lines.push("```")
  lines.push("")

  // Task list
  lines.push("## Task List")
  lines.push("")
  const phases = [...new Set(tasks.map((t) => t.phase))]
  for (const phase of phases) {
    lines.push(`### ${phase.charAt(0).toUpperCase() + phase.slice(1)}`)
    lines.push("")
    const phaseTasks = tasks.filter((t) => t.phase === phase)
    for (const t of phaseTasks) {
      const priorityTag = t.priority === "nice-to-have" ? " (nice-to-have)" : t.priority === "future" ? " (future)" : ""
      lines.push(`- [ ] **${t.id}.** ${t.title}${priorityTag}`)
      if (t.details) {
        const detailLines = t.details.split("\n")
        for (const dl of detailLines) {
          lines.push(`      ${dl}`)
        }
      }
    }
    lines.push("")
  }

  // Component DOM specs
  lines.push("## Component DOM Structure")
  lines.push("")
  for (const comp of components) {
    lines.push(`### ${comp.name}`)
    lines.push(`- **File:** \`${comp.file}\``)
    lines.push(`- **Page:** ${comp.page}`)
    if (comp.description) lines.push(`- **Purpose:** ${comp.description}`)
    lines.push("")
    lines.push("Expected DOM:")
    lines.push("```html")
    lines.push(`<${comp.expectedDom.container.tag} data-section="${comp.expectedDom.container.attributes?.["data-section"] || ""}">`)
    for (const child of comp.expectedDom.children) {
      const tag = child.tag.split("|")[0]
      const attrs = []
      if (child.role) attrs.push(`role="${child.role}"`)
      if (child.component) attrs.push(`<!-- ${child.component} -->`)
      const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : ""
      lines.push(`  <${tag}${attrStr}> <!-- ${child.description} -->`)
    }
    lines.push(`</${comp.expectedDom.container.tag}>`)
    lines.push("```")
    lines.push("")
  }

  // References
  const refs = spec.references || []
  if (refs.length > 0) {
    lines.push("## Reference Sites")
    lines.push("")
    for (const ref of refs) {
      lines.push(`- ${ref.url || "(no URL)"} — ${ref.description || ""} (${ref.aspect || ""})`)
    }
    lines.push("")
  }

  // Open questions
  const questions = spec.open_questions || []
  if (questions.length > 0) {
    lines.push("## Open Questions")
    lines.push("")
    for (const q of questions) {
      lines.push(`- ${q}`)
    }
    lines.push("")
  }

  // Technical requirements
  if (spec.technical) {
    lines.push("## Technical Requirements")
    lines.push("")
    if (spec.technical.requirements?.length > 0) {
      for (const r of spec.technical.requirements) lines.push(`- ${r}`)
    }
    if (spec.technical.integrations?.length > 0) {
      lines.push(`\n**Integrations:** ${spec.technical.integrations.join(", ")}`)
    }
    if (spec.technical.hosting) lines.push(`**Hosting:** ${spec.technical.hosting}`)
    if (spec.technical.framework) lines.push(`**Framework:** ${spec.technical.framework}`)
    lines.push("")
  }

  return lines.join("\n")
}

function formatClaudeMd(spec, tasks, components) {
  const lines = []
  const projectName = spec.project?.name || "Untitled Project"

  lines.push(`# ${projectName} — Project Requirements`)
  lines.push("")
  lines.push(`## Overview`)
  lines.push(spec.project?.description || "Client project.")
  lines.push(`Type: ${spec.project?.type || "web application"}`)
  lines.push("")

  // Design system
  lines.push("## Design System")
  lines.push("")
  if (spec.design) {
    if (spec.design.style) lines.push(`Style: ${spec.design.style}`)
    if (spec.design.mood) lines.push(`Mood: ${spec.design.mood}`)
    if (spec.design.colors) {
      lines.push("\nColors:")
      for (const [k, v] of Object.entries(spec.design.colors)) {
        if (v && k !== "notes") lines.push(`  ${k}: ${v}`)
      }
    }
    if (spec.design.fonts) {
      lines.push("\nFonts:")
      if (spec.design.fonts.heading) lines.push(`  heading: ${spec.design.fonts.heading}`)
      if (spec.design.fonts.body) lines.push(`  body: ${spec.design.fonts.body}`)
    }
  }
  lines.push("")

  // Pages and expected elements
  lines.push("## Pages")
  lines.push("")
  for (const page of spec.pages || []) {
    lines.push(`### ${page.name} (${page.path || "/" + slugify(page.name)})`)
    lines.push(page.description || "")
    lines.push("")
    for (const section of page.sections || []) {
      lines.push(`- **${section.name}**: ${section.description || ""}`)
      for (const comp of section.components || []) {
        lines.push(`  - Component: \`${pascalCase(comp)}\``)
      }
    }
    lines.push("")
  }

  // Quality gates
  lines.push("## Quality Gates")
  lines.push("")
  lines.push("Before committing, verify:")
  lines.push("")

  for (const comp of components) {
    const checks = comp.expectedDom.children
      .map((c) => `  - \`${c.tag.split("|")[0]}\` — ${c.description}`)
      .join("\n")
    lines.push(`- **${comp.name}** (\`${comp.file}\`):`)
    lines.push(checks)
  }
  lines.push("")

  // Features
  const mustHave = (spec.features || []).filter((f) => f.priority !== "future")
  if (mustHave.length > 0) {
    lines.push("## Required Features")
    lines.push("")
    for (const f of mustHave) {
      lines.push(`- **${f.name}**: ${f.description || ""} [${f.category || "general"}]`)
    }
    lines.push("")
  }

  // Acceptance criteria
  if (spec.acceptance_criteria?.length > 0) {
    lines.push("## Acceptance Criteria")
    lines.push("")
    for (const c of spec.acceptance_criteria) {
      lines.push(`- [ ] ${c}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

function formatJson(spec, scaffold, tasks, components) {
  return JSON.stringify(
    {
      project: spec.project,
      scaffold,
      tasks,
      components,
      design: spec.design,
      references: spec.references,
      open_questions: spec.open_questions,
      technical: spec.technical,
      _meta: {
        ...spec._meta,
        plan_generated_at: new Date().toISOString(),
      },
    },
    null,
    2
  )
}

// ─── Main ───

function printUsage() {
  console.error(`
Spec-to-Plan — Convert a video-digest spec into a project plan

Usage:
  node cli/spec-to-plan.mjs <spec.json> [options]

Options:
  --output, -o <path>   Write plan to file (default: stdout)
  --format <type>       Output format: markdown (default), json, claude-md
  --claude-md           Shortcut for --format claude-md
  --help, -h            Show this help

Examples:
  node cli/spec-to-plan.mjs spec.json
  node cli/spec-to-plan.mjs spec.json -o project-plan.md
  node cli/spec-to-plan.mjs spec.json --claude-md -o CLAUDE.md
  node cli/spec-to-plan.mjs spec.json --format json -o plan.json
`)
}

async function main() {
  let args
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        format: { type: "string", default: "markdown" },
        "claude-md": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    })
  } catch (e) {
    error(e.message)
    printUsage()
    process.exit(1)
  }

  if (args.values.help || args.positionals.length === 0) {
    printUsage()
    process.exit(args.values.help ? 0 : 1)
  }

  const specPath = path.resolve(args.positionals[0])
  const outputPath = args.values.output ? path.resolve(args.values.output) : null
  let format = args.values["claude-md"] ? "claude-md" : args.values.format || "markdown"

  // Read spec
  if (!fs.existsSync(specPath)) {
    error(`Spec file not found: ${specPath}`)
    process.exit(1)
  }

  let spec
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf-8"))
  } catch (e) {
    error(`Failed to parse spec JSON: ${e.message}`)
    process.exit(1)
  }

  progress(`Loaded spec: ${spec.project?.name || "(unnamed)"}`)
  progress(`Pages: ${spec.pages?.length || 0}, Features: ${spec.features?.length || 0}`)

  // Generate plan components
  const scaffold = generateScaffold(spec)
  const tasks = generateTaskList(spec, scaffold)
  const components = generateComponentDomSpec(spec)

  progress(`Scaffold: ${scaffold.length} files`)
  progress(`Tasks: ${tasks.length} tasks`)
  progress(`Components: ${components.length} DOM specs`)

  // Format output
  let output
  switch (format) {
    case "json":
      output = formatJson(spec, scaffold, tasks, components)
      break
    case "claude-md":
      output = formatClaudeMd(spec, tasks, components)
      break
    case "markdown":
    default:
      output = formatMarkdown(spec, scaffold, tasks, components)
      break
  }

  // Write output
  if (outputPath) {
    fs.writeFileSync(outputPath, output + "\n")
    progress(`Plan written to: ${outputPath}`)
  } else {
    process.stdout.write(output + "\n")
  }

  progress("Done.")
}

main()
