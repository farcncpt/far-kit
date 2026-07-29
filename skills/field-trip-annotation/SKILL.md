---
name: Field Trip Annotation System
description: Visual annotation layer for AI agents. Users annotate DOM elements with instructions that agents read as context. Supports dynamic (one-time) and structural (persistent) annotations with URL scoping and self-healing selector resolution.
when_to_use: annotate element, leave instructions for agent, page annotations, element instructions, workflow guides, dynamic annotations, structural annotations, self-healing selectors, Alt+A, annotation mode
source: joyride-web-extension/src/skills/field-trip-annotation.json v1.0.0
---

# Field Trip Annotation System

Annotations are how users leave instructions for AI agents at the DOM level. A user highlights an element, types "this button submits the form", and any future agent visiting that page gets the annotation as context automatically. Supports URL scoping (exact / pattern / domain) and self-healing when selectors change.

## Activation

- **Toolbar:** Click the pencil icon (Annotate) on the FT pill
- **Hotkey:** `Alt+A` toggles annotation mode (when toolbar is visible)
- **CLI:** `node cli/annotate.mjs --relay demo --tab <tabId>`
- **MCP:** `mcp__field-trip__browser({ action: "annotations", params: { action: "get", url: "current" } })`

## Annotation Modes

### Annotate mode
Click any element to attach an instruction for AI agents.

- **Activation:** Click pencil icon on pill OR run `annotate.mjs --relay demo`
- **Indicators:** Blue border around viewport, status bar at top center, blue hover highlight on elements
- **Exit:** `Alt+A`, `Escape`, or click X on status bar

## Annotation Types (color-coded)

| Type | Color | Description |
|------|-------|-------------|
| `action` | `#22c55e` (green) | Agent should perform an action on this element |
| `info` | `#3b82f6` (blue) | Context information for the agent |
| `warning` | `#eab308` (yellow) | Be careful with this element |
| `extract` | `#a855f7` (purple) | Extract data from this element |
| `wait` | `#f97316` (orange) | Wait for this element to load/change |
| `skip` | `#ef4444` (red) | Ignore this element |

## URL Scoping

| Scope | Meaning |
|-------|---------|
| `exact` | Annotation applies only to this exact URL |
| `pattern` | Annotation applies to URL pattern (e.g., `example.com/admin/*`) |
| `domain` | Annotation applies to all pages on this domain |

## Agent Commands (via MCP browser tool)

```
// List all annotations across all domains
mcp__field-trip__browser({ action: "annotations", params: { action: "list" } })

// Get annotations for current tab's page
mcp__field-trip__browser({ action: "annotations", params: { action: "get", url: "current" } })

// Create or update an annotation
mcp__field-trip__browser({
  action: "annotations",
  params: {
    action: "save",
    annotation: { id, selector, instruction, category, scope, urlPattern }
  }
})

// Delete an annotation by ID
mcp__field-trip__browser({ action: "annotations", params: { action: "delete", id: "ann-xxx" } })

// List named workflows for a domain
mcp__field-trip__browser({ action: "annotations", params: { action: "workflows", domain: "example.com" } })
```

## Self-Healing Selector Resolution

When an agent visits a page with annotations, the extension tries to resolve each element using fallback strategies in this order:

1. **Primary CSS selector** (what was originally captured)
2. **Fallback selectors** (aria-label, data-testid)
3. **Fuzzy match** by tag + text content
4. **Fuzzy match** by aria/data attributes

**On failure:** The annotation is marked as stale with a reason. Agent or user can update the selector.

## Storage

- **Current:** `chrome.storage.local` (per-extension, persists across sessions)
- **Key:** `field-trip-annotations`
- **Future:** Cloud sync for team sharing and cross-device access

## Agent workflow example

1. User visits a dashboard with a complex submit flow
2. User annotates the submit button with "this requires CAPTCHA before clicking"
3. Later, a coding agent is asked to "fill out the form and submit"
4. Agent calls `annotations action=get url=current`, reads the instruction
5. Agent knows to wait for CAPTCHA completion before clicking submit

## Related skills
- `field-trip-pill` — the FT pill where annotate mode is activated
- `field-trip-relay` — the MCP tool that reads/writes annotations
- `field-trip-scanner` — DOM scanning that annotations augment
