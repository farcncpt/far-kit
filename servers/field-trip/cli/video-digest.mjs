#!/usr/bin/env node
/**
 * Video Digest — Extract structured requirements from video/audio files
 * using Gemini's 1M token context window.
 *
 * Uploads a video or audio recording (client meeting, walkthrough, etc.)
 * to the Gemini API and extracts a structured requirements specification.
 *
 * Usage:
 *   GEMINI_API_KEY=xxx node cli/video-digest.mjs <video-path> [--output spec.json] [--audio-only]
 *   node cli/video-digest.mjs meeting-recording.mp4
 *   node cli/video-digest.mjs call.mp3 --audio-only --output spec.json
 *
 * Environment:
 *   GEMINI_API_KEY — required, your Gemini API key
 *   GEMINI_MODEL  — optional, default: gemini-2.0-flash
 */

import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

// ─── Config ───

const GEMINI_BASE = "https://generativelanguage.googleapis.com"
const DEFAULT_MODEL = "gemini-2.0-flash"

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".avi", ".mov"])
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac"])

const MIME_MAP = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
}

// ─── Extraction prompt ───

const EXTRACTION_PROMPT = `You are a requirements analyst. You have been given a recording of a client meeting,
walkthrough, or project description. Your job is to extract a structured requirements specification.

Analyze the full recording carefully and extract the following into a JSON object:

{
  "project": {
    "name": "string — project name or best guess",
    "description": "string — 2-3 sentence summary of what the client wants built",
    "type": "string — e.g. 'marketing site', 'web app', 'e-commerce', 'portfolio', 'SaaS dashboard'"
  },
  "pages": [
    {
      "name": "string — page name (e.g. 'Home', 'About', 'Dashboard')",
      "path": "string — suggested URL path (e.g. '/', '/about')",
      "description": "string — what this page does",
      "sections": [
        {
          "name": "string — section name (e.g. 'Hero', 'Features Grid', 'Testimonials')",
          "description": "string — what this section contains",
          "components": ["string — component names needed (e.g. 'HeroWithCTA', 'FeatureCard', 'TestimonialSlider')"]
        }
      ]
    }
  ],
  "design": {
    "colors": {
      "primary": "string or null — hex color or description",
      "secondary": "string or null",
      "accent": "string or null",
      "background": "string or null",
      "text": "string or null",
      "notes": "string — any other color preferences mentioned"
    },
    "fonts": {
      "heading": "string or null — font family",
      "body": "string or null",
      "notes": "string — typography preferences"
    },
    "style": "string — overall style (e.g. 'modern minimal', 'bold and colorful', 'corporate clean')",
    "mood": "string — emotional tone (e.g. 'professional', 'playful', 'luxury', 'tech-forward')",
    "notes": "string — any other design preferences"
  },
  "features": [
    {
      "name": "string — feature name",
      "description": "string — what it does",
      "priority": "string — 'must-have', 'nice-to-have', or 'future'",
      "category": "string — e.g. 'auth', 'payments', 'cms', 'forms', 'social', 'analytics', 'email'"
    }
  ],
  "content": {
    "navigation": ["string — nav items mentioned"],
    "sitemap": "string — description of site structure",
    "cta_text": ["string — any call-to-action text mentioned"],
    "copy_notes": "string — tone, voice, messaging preferences"
  },
  "ui_elements": [
    {
      "element": "string — specific UI element mentioned",
      "description": "string — how it should look/behave",
      "page": "string — which page it belongs to"
    }
  ],
  "acceptance_criteria": [
    "string — specific success criteria or requirements mentioned"
  ],
  "brand_assets": [
    {
      "type": "string — 'logo', 'icon', 'image', 'video', 'font', 'color palette'",
      "description": "string — what was mentioned about it",
      "source": "string or null — where to find it"
    }
  ],
  "technical": {
    "requirements": ["string — technical requirements or constraints mentioned"],
    "integrations": ["string — third-party services mentioned (Stripe, Auth0, etc.)"],
    "hosting": "string or null — hosting preferences",
    "framework": "string or null — framework preferences mentioned"
  },
  "references": [
    {
      "url": "string or null — example website URL",
      "description": "string — what about it was referenced (layout, style, feature)",
      "aspect": "string — what specifically to look at"
    }
  ],
  "open_questions": [
    "string — things that were unclear or need follow-up"
  ]
}

IMPORTANT:
- Extract EVERYTHING mentioned, even if brief. Better to include too much than too little.
- If something isn't mentioned, use null or empty arrays — don't make things up.
- For colors/fonts, include exact values if shown on screen or mentioned, otherwise describe.
- The "open_questions" field is critical — flag anything ambiguous.
- Pay attention to what's shown on screen (if video), not just what's said.
- Return ONLY the JSON object, no markdown fences, no explanation.`

// ─── Progress logging ───

function progress(msg) {
  process.stderr.write(`\x1b[36m[video-digest]\x1b[0m ${msg}\n`)
}

function error(msg) {
  process.stderr.write(`\x1b[31m[video-digest] ERROR:\x1b[0m ${msg}\n`)
}

function warn(msg) {
  process.stderr.write(`\x1b[33m[video-digest] WARN:\x1b[0m ${msg}\n`)
}

// ─── Gemini API helpers ───

async function uploadFile(apiKey, filePath, mimeType) {
  const fileSize = fs.statSync(filePath).size
  const sizeMB = (fileSize / (1024 * 1024)).toFixed(1)
  progress(`Uploading ${path.basename(filePath)} (${sizeMB} MB, ${mimeType})...`)

  // Step 1: Start resumable upload
  const startRes = await fetch(
    `${GEMINI_BASE}/upload/v1beta/files?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(fileSize),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      body: JSON.stringify({
        file: { displayName: path.basename(filePath) },
      }),
    }
  )

  if (!startRes.ok) {
    const text = await startRes.text()
    throw new Error(`Upload start failed (${startRes.status}): ${text}`)
  }

  const uploadUrl = startRes.headers.get("x-goog-upload-url")
  if (!uploadUrl) {
    throw new Error("No upload URL returned from Gemini API")
  }

  // Step 2: Upload file data
  progress(`Uploading file data...`)
  const fileData = fs.readFileSync(filePath)

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(fileSize),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: fileData,
  })

  if (!uploadRes.ok) {
    const text = await uploadRes.text()
    throw new Error(`Upload failed (${uploadRes.status}): ${text}`)
  }

  const uploadResult = await uploadRes.json()
  const fileUri = uploadResult.file?.uri
  const fileName = uploadResult.file?.name

  if (!fileUri) {
    throw new Error(`Upload succeeded but no file URI returned: ${JSON.stringify(uploadResult)}`)
  }

  progress(`Upload complete: ${fileName}`)
  return { uri: fileUri, name: fileName, mimeType }
}

async function waitForProcessing(apiKey, fileName) {
  progress("Waiting for Gemini to process the file...")
  const maxAttempts = 120 // 10 minutes max
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `${GEMINI_BASE}/v1beta/${fileName}?key=${apiKey}`
    )

    if (!res.ok) {
      if (res.status === 404) {
        // File not ready yet
        await sleep(5000)
        continue
      }
      const text = await res.text()
      throw new Error(`File status check failed (${res.status}): ${text}`)
    }

    const fileInfo = await res.json()
    const state = fileInfo.state

    if (state === "ACTIVE") {
      progress("File processed and ready.")
      return fileInfo
    } else if (state === "FAILED") {
      throw new Error(`File processing failed: ${fileInfo.error?.message || "unknown error"}`)
    }

    // Still PROCESSING
    if (i % 6 === 0 && i > 0) {
      progress(`Still processing... (${i * 5}s elapsed)`)
    }
    await sleep(5000)
  }

  throw new Error("File processing timed out after 10 minutes")
}

async function generateContent(apiKey, fileUri, mimeType, model, audioOnly) {
  progress(`Sending to ${model} for analysis...`)

  const contentParts = []

  if (audioOnly) {
    contentParts.push({
      fileData: { mimeType, fileUri },
    })
    contentParts.push({
      text: "This is an audio recording of a client meeting or project discussion.\n\n" + EXTRACTION_PROMPT,
    })
  } else {
    contentParts.push({
      fileData: { mimeType, fileUri },
    })
    contentParts.push({
      text:
        "This is a video recording of a client meeting, walkthrough, or project discussion. " +
        "Pay attention to both what is SAID and what is SHOWN on screen.\n\n" +
        EXTRACTION_PROMPT,
    })
  }

  const body = {
    contents: [{ parts: contentParts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  }

  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Generation failed (${res.status}): ${text}`)
  }

  const result = await res.json()

  // Check for blocked content
  if (result.promptFeedback?.blockReason) {
    throw new Error(`Content blocked: ${result.promptFeedback.blockReason}`)
  }

  const candidates = result.candidates
  if (!candidates || candidates.length === 0) {
    throw new Error(`No response generated. Raw response: ${JSON.stringify(result).slice(0, 500)}`)
  }

  const textContent = candidates[0]?.content?.parts
    ?.map((p) => p.text)
    .filter(Boolean)
    .join("")

  if (!textContent) {
    throw new Error("Empty response from Gemini")
  }

  return textContent
}

async function deleteFile(apiKey, fileName) {
  try {
    await fetch(`${GEMINI_BASE}/v1beta/${fileName}?key=${apiKey}`, {
      method: "DELETE",
    })
    progress("Cleaned up uploaded file.")
  } catch {
    warn("Could not delete uploaded file (non-critical).")
  }
}

// ─── Utilities ───

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function parseJsonResponse(text) {
  // Try direct parse first
  try {
    return JSON.parse(text)
  } catch {
    // ignore
  }

  // Try extracting from markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1])
    } catch {
      // ignore
    }
  }

  // Try finding first { to last }
  const firstBrace = text.indexOf("{")
  const lastBrace = text.lastIndexOf("}")
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1))
    } catch {
      // ignore
    }
  }

  throw new Error("Could not parse Gemini response as JSON. Raw output:\n" + text.slice(0, 2000))
}

// ─── Main ───

function printUsage() {
  console.error(`
Video Digest — Extract requirements from video/audio recordings via Gemini

Usage:
  node cli/video-digest.mjs <file-path> [options]

Options:
  --output, -o <path>   Write spec JSON to file (default: stdout)
  --audio-only          Treat input as audio even if it has a video extension
  --model <name>        Gemini model to use (default: ${DEFAULT_MODEL})
  --keep-file           Don't delete the uploaded file from Gemini after processing
  --help, -h            Show this help

Supported formats:
  Video: ${[...VIDEO_EXTENSIONS].join(", ")}
  Audio: ${[...AUDIO_EXTENSIONS].join(", ")}

Environment:
  GEMINI_API_KEY        Required — your Gemini API key
  GEMINI_MODEL          Optional — override default model

Examples:
  GEMINI_API_KEY=xxx node cli/video-digest.mjs meeting.mp4
  node cli/video-digest.mjs call.mp3 --audio-only -o spec.json
  node cli/video-digest.mjs walkthrough.webm --model gemini-2.0-flash
`)
}

async function main() {
  // Parse arguments
  let args
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        "audio-only": { type: "boolean", default: false },
        model: { type: "string" },
        "keep-file": { type: "boolean", default: false },
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

  const filePath = path.resolve(args.positionals[0])
  const outputPath = args.values.output ? path.resolve(args.values.output) : null
  const audioOnly = args.values["audio-only"]
  const keepFile = args.values["keep-file"]
  const model = args.values.model || process.env.GEMINI_MODEL || DEFAULT_MODEL

  // Validate API key
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    error("GEMINI_API_KEY environment variable is required.")
    error("Get one at: https://aistudio.google.com/apikey")
    process.exit(1)
  }

  // Validate file
  if (!fs.existsSync(filePath)) {
    error(`File not found: ${filePath}`)
    process.exit(1)
  }

  const ext = path.extname(filePath).toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.has(ext)
  const isAudio = AUDIO_EXTENSIONS.has(ext)

  if (!isVideo && !isAudio) {
    error(`Unsupported file type: ${ext}`)
    error(`Supported: ${[...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].join(", ")}`)
    process.exit(1)
  }

  const mimeType = MIME_MAP[ext]
  if (!mimeType) {
    error(`No MIME type mapping for ${ext}`)
    process.exit(1)
  }

  // Check file size
  const stats = fs.statSync(filePath)
  const sizeMB = stats.size / (1024 * 1024)
  if (sizeMB > 2000) {
    error(`File is ${sizeMB.toFixed(0)} MB — Gemini supports up to ~2 GB.`)
    error("Consider compressing the file or extracting audio only.")
    process.exit(1)
  }

  const effectiveAudioOnly = audioOnly || isAudio

  progress(`File: ${path.basename(filePath)} (${sizeMB.toFixed(1)} MB)`)
  progress(`Mode: ${effectiveAudioOnly ? "audio-only" : "video+audio"}`)
  progress(`Model: ${model}`)
  progress("")

  let uploadedFileName = null

  try {
    // Step 1: Upload
    const uploaded = await uploadFile(apiKey, filePath, mimeType)
    uploadedFileName = uploaded.name

    // Step 2: Wait for processing
    await waitForProcessing(apiKey, uploaded.name)

    // Step 3: Generate content
    const rawResponse = await generateContent(
      apiKey,
      uploaded.uri,
      mimeType,
      model,
      effectiveAudioOnly
    )

    // Step 4: Parse JSON
    progress("Parsing response...")
    const spec = parseJsonResponse(rawResponse)

    // Add metadata
    spec._meta = {
      source_file: path.basename(filePath),
      source_size_mb: parseFloat(sizeMB.toFixed(1)),
      model,
      mode: effectiveAudioOnly ? "audio-only" : "video+audio",
      extracted_at: new Date().toISOString(),
      tool: "video-digest",
      version: "1.0.0",
    }

    // Step 5: Output
    const jsonOutput = JSON.stringify(spec, null, 2)

    if (outputPath) {
      fs.writeFileSync(outputPath, jsonOutput + "\n")
      progress(`Spec written to: ${outputPath}`)

      // Also print summary to stderr
      const pageCount = spec.pages?.length || 0
      const featureCount = spec.features?.length || 0
      const questionCount = spec.open_questions?.length || 0
      progress("")
      progress(`Summary:`)
      progress(`  Project: ${spec.project?.name || "(unnamed)"}`)
      progress(`  Type: ${spec.project?.type || "(unknown)"}`)
      progress(`  Pages: ${pageCount}`)
      progress(`  Features: ${featureCount}`)
      progress(`  Open questions: ${questionCount}`)
      if (spec.design?.style) progress(`  Style: ${spec.design.style}`)
    } else {
      // Write JSON to stdout
      process.stdout.write(jsonOutput + "\n")
    }

    progress("")
    progress("Done.")
  } catch (e) {
    error(e.message)
    if (e.cause) error(`Cause: ${e.cause}`)
    process.exit(1)
  } finally {
    // Clean up uploaded file
    if (uploadedFileName && !keepFile) {
      await deleteFile(apiKey, uploadedFileName)
    }
  }
}

main()
