---
name: Field Trip Pill Command Center
description: The floating FT pill is the single entry point for every Field Trip feature. Global toggle via Ctrl+Space. Contains tools for annotation, prototyping, scanning, spotlight, AI input, and settings.
when_to_use: Ctrl+Space, floating pill, FT pill, toolbar, toggle pill, field-trip activation, ask button, pill buttons, consumer vs developer mode, feature tiers
source: joyride-web-extension/src/skills/field-trip-pill.json v1.0.0
---

# Field Trip Pill Command Center

The FT pill is a floating toolbar that sits above any webpage and provides the single entry point for every Field Trip feature. It's draggable, globally toggleable with `Ctrl+Space`, and adapts its button set based on the user's feature tier (consumer / developer / agent).

## Global Controls

| Action | Behavior |
|--------|----------|
| **Toggle** | `Ctrl+Space` — show/hide pill globally across all tabs |
| **Close** | Click X button on pill — same as `Ctrl+Space` |
| **Drag** | Grab the FT logo to reposition the pill anywhere on screen |
| **Persistence** | Visibility state saved in `chrome.storage`, synced across all tabs instantly |

## Buttons (in order, left to right)

### 1. Logo (FT)
Drag to reposition the pill. Not a click target.

### 2. Ask (chat bubble)
Toggles the quick input bar above the pill. Type natural-language commands or questions.

- **Placeholder:** "Ask about this page..."
- **Submit:** Enter key or click send arrow
- **Close:** Escape key
- **Examples:** "show me around", "what does this button do?", "fix the contrast", "make the hero taller"

### 3. Annotate (pencil)
Toggles annotation mode — click elements to attach instructions for AI agents.
- Active indicator: blue highlight on button

### 4. Prototype (grid/layout)
Toggles prototype mode — click elements to resize with drag handles.
- Active indicator: purple highlight on button

### 5. Scan (magnifying glass)
Quick scan — shows element count summary popup (links, buttons, inputs, images, headings, forms).
- Popup auto-dismisses after 4 seconds

### 6. Spotlight (star)
Spotlight mode — highlight and annotate specific elements.

### 7. Settings (gear)
Opens settings panel (planned — relay status, feature toggles, account).

### 8. Close (X)
Hides pill (`Ctrl+Space` to show again).

## Feature Tiers

The pill adapts its button set based on the user's enabled tier:

### Consumer (default)
Guided tours, annotations, AI chat, spotlights.
**Visible buttons:** `ask`, `annotate`, `spotlight`, `settings`, `close`

### Developer (enabled in settings)
Adds scanning, prototyping, relay tools.
**Visible buttons:** `ask`, `annotate`, `prototype`, `scan`, `spotlight`, `settings`, `close`

### Agent (future)
Multi-agent orchestration, browser automation fleet.
**Visible buttons:** `ask`, `annotate`, `prototype`, `scan`, `spotlight`, `agents`, `settings`, `close`

## Styling Reference

| Property | Value |
|----------|-------|
| Background | `#0f172a` |
| Border | `#1e293b` |
| Border radius | `12px` |
| Button size | `32px` |
| Logo gradient | `linear-gradient(135deg, #3b82f6, #8b5cf6)` |
| Opacity (default) | `0.7` |
| Opacity (hover) | `1.0` |
| Position | `bottom: 16px; right: 16px` |

## Related skills
- `field-trip-ai-tours` — what the Ask button triggers
- `field-trip-annotation` — what the Annotate button enables
- `field-trip-prototype` — what the Prototype button enables
- `field-trip-scanner` — what the Scan button summarizes
