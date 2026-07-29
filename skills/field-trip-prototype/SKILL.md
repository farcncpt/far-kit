---
name: Field Trip Live DOM Prototyping
description: Visually prototype UI changes on any live website. Click elements to get resize handles, drag to resize, use natural language to restyle. Changes are DOM-only — refresh to undo.
when_to_use: live prototyping, resize element, restyle, natural language CSS, visual UI edits, inline style changes, "make this bigger", "change the color", drag handles, prototype mode, client demos
source: joyride-web-extension/src/skills/field-trip-prototype.json v1.0.0
---

# Field Trip Live DOM Prototyping

Prototype mode lets anyone visually change a live website without touching code. Click any element to get 8 drag handles, resize by dragging, or type a natural-language restyle instruction and have the AI apply inline styles on the fly. All changes are DOM-only — a page refresh undoes everything, which is a feature (safe sandbox) and a bug (no Ctrl+Z yet).

## Activation

- **Toolbar:** Click the grid icon (Prototype) on the FT pill
- **Exit:** Escape key or click the Prototype button again

## Capabilities

### Resize
Click any element to reveal 8 drag handles (4 corners + 4 edges):

- top-left, top, top-right
- left, right
- bottom-left, bottom, bottom-right

Drag a handle to resize the element. Changes are applied via inline style.

### Natural language restyle

Use the quick input bar (Ask button on the pill) while in prototype mode to describe a style change:

- "make this button bigger"
- "change the background to dark blue"
- "add more padding"
- "round the corners"
- "make the text white"
- "center this element"

**Flow:** User selects element → types description → AI applies inline styles → user sees result live.

### Code generation

After prototyping, generate implementable code from the changes. Planned output formats:
- Tailwind classes
- Raw CSS
- Inline styles
- React / JSX component
- Diff patch against the current file

## Visual Indicators

**Prototype mode active:**
- Purple border around viewport
- Status bar: "Prototype Mode"
- Purple hover highlight on elements

**Element selected:**
- 8 drag handles on selected element
- Dashed purple outline

## Known Issues (as of 2026-03-24)

- **Handle repositioning** may not be smooth during drag — known bug, fix pending
- **No reset button** yet — page refresh undoes all changes (destructive)
- **Ctrl+Z undo** not yet implemented — planned

## Planned Features

- Reset all changes button in status bar
- Per-element undo (Ctrl+Z)
- Color picker on selected elements
- Spacing adjusters (padding/margin drag handles)
- AI-driven restyling via quick input bar
- Export changes as code (Tailwind, CSS, React)
- Visual diff — before/after comparison

## Related skills
- `field-trip-pill` — the FT pill where prototype mode is activated
- `field-trip-annotation` — for persisting design notes on elements
