---
name: Field Trip AI-Guided Tours & Conversational Spotlight
description: Natural language guided tours of any website. User types "show me around" and AI creates a live spotlight walkthrough. Spotlight IS the conversation — visual timeline with interrupt/resume and replay.
when_to_use: guided tour, show me around, walkthrough, spotlight tour, explain this page, conversational spotlight, AI narration, replay tour, interrupt tour, quick input, onboarding users to a site
source: joyride-web-extension/src/skills/field-trip-ai-tours.json v1.0.0
---

# Field Trip AI-Guided Tours & Conversational Spotlight

AI tours turn natural-language questions into live spotlight walkthroughs of any website. The spotlight system IS the chat — AI speaks through spotlights, user speaks through the quick input. Tours are interruptible, resumable, and replayable.

## Quick Input

- **Location:** Quick input bar above the FT pill
- **Activation:** Click chat bubble icon on pill
- **Placeholder:** "Ask about this page..."

### Example prompts
- "show me around"
- "how do I sign up?"
- "where are the settings?"
- "explain this page"
- "what can I do here?"
- "find the checkout flow"
- "show me the navigation"

## Conversational Spotlight Concept

The spotlight system IS the chat. AI doesn't speak in a sidebar — it speaks through the page itself via animated overlays and captions.

### Flow
1. User types question in quick input
2. AI scans page structure (`scan` command)
3. AI plans spotlight sequence (key sections in logical order)
4. Spotlights execute with captions explaining each element
5. User can interrupt mid-sequence to ask a follow-up
6. AI pauses queue, responds with new spotlight(s)
7. After answering, original queue resumes

### Interrupt mechanics

| Phase | Behavior |
|-------|----------|
| During tour | Quick input bar stays active — user types to interrupt |
| On interrupt | Current spotlight pauses, queue position preserved |
| After answer | Offers "Continue tour?" or auto-resumes |
| Escape | Cancels entire tour |

## History & Replay

Every tour entry is recorded for replay:

### Entry types
- `ai-spotlight` — a spotlight the AI triggered
- `user-question` — a user question typed into the input
- `ai-response` — the AI's natural-language answer
- `navigation` — page or route changes

### Entry data (per record)
- Selector
- Caption
- Element snapshot
- Screenshot region
- URL
- Scroll position

### Replay behavior

| Scenario | Behavior |
|----------|----------|
| Same page, element present | Scrolls to element, re-spotlights it |
| Different page | Shows link: "Go to [page] to replay" |
| Element gone | Shows "Element not found" with last screenshot |

### Sharing (future cloud feature)
Replay links: `fieldtrip.app/replay/abc123`

## Tour Planning

### Auto-discovery sources
The AI scans the page for these structural signals:
- Navigation menu structure
- Heading hierarchy (h1 → h2 → h3)
- Call-to-action buttons
- Forms and input areas
- Media sections (images, videos)
- Footer links and legal pages

### Logical order
`nav → hero/intro → main content → features → CTAs → footer`

### Adaptive depth
Short tour for simple pages, detailed for complex apps.

## Infrastructure

### Already built
- `scan` — reads page structure
- `spotlight` — highlights elements with animated overlay + caption
- `scroll` — navigates to off-screen sections
- `annotations` — persists tour state for future visits
- `SpotlightEngine` — supports step queuing with transitions

### Still needed
- AI tour planner (converts "show me around" to spotlight sequence)
- Queue interrupt/resume logic
- History recording and replay engine
- Quick input → AI → spotlight pipeline

## Revenue Model

| Tier | Features |
|------|----------|
| Free | 5 tours/month |
| Pro | Unlimited tours, save/share tours, replay links |
| Enterprise | Custom branded tours for client onboarding, analytics |

## Related skills
- `field-trip-pill` — the FT pill where tours are activated
- `field-trip-relay` — spotlight and scan commands used by the AI
- `field-trip-annotation` — persistent annotations that can seed tours
