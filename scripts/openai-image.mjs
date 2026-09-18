#!/usr/bin/env node
/**
 * Generate one ad background image through the OpenAI Images API.
 *
 * Usage: node scripts/openai-image.mjs --prompt-file p.txt --out bg.png [--size 1024x1536] [--model gpt-image-2] [--input photo.jpg]
 *
 * With --input the script calls the images/edits endpoint instead: the input
 * photo is the reference and the prompt describes the full variation.
 *
 * The API key arrives ONLY via the OPENAI_API_KEY environment variable; the
 * orchestrator reads it from the macOS Keychain and runs this script itself.
 * Agents never see the key. The prompt must describe an image with no text in
 * it; Hebrew typography is composed afterwards with scripts/compose-ad.py.
 */
import fs from "node:fs/promises";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const promptFile = arg("--prompt-file");
const outFile = arg("--out");
const size = arg("--size", "1024x1536");
const model = arg("--model", process.env.CREATIVE_IMAGE_MODEL || "gpt-image-2");
const inputFile = arg("--input");

if (!promptFile || !outFile) {
  console.error("usage: openai-image.mjs --prompt-file <file> --out <file> [--size WxH] [--model m]");
  process.exit(2);
}
if (!/^(1024x1024|1024x1536|1536x1024)$/.test(size)) {
  console.error(`unsupported size: ${size}`);
  process.exit(2);
}
const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error("OPENAI_API_KEY is not set");
  process.exit(3);
}

const prompt = (await fs.readFile(promptFile, "utf8")).trim();
if (!prompt) {
  console.error("empty prompt");
  process.exit(2);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240_000);
let response;
try {
  if (inputFile) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", "high");
    form.append("n", "1");
    const bytes = await fs.readFile(inputFile);
    // בלי MIME מפורש undici שולח application/octet-stream וה-API דוחה את הקובץ.
    const ext = (inputFile.split(".").pop() || "").toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    form.append("image", new Blob([bytes], { type: mime }), `reference.${ext === "png" || ext === "webp" ? ext : "jpg"}`);
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, prompt, size, quality: "high", n: 1 }),
    });
  }
} finally {
  clearTimeout(timer);
}
if (!response.ok) {
  const body = await response.text().catch(() => "");
  console.error(`OpenAI images API returned HTTP ${response.status}: ${body.slice(0, 400)}`);
  process.exit(1);
}
const payload = await response.json();
const b64 = payload?.data?.[0]?.b64_json;
if (!b64) {
  console.error("OpenAI response carried no image data");
  process.exit(1);
}
await fs.writeFile(outFile, Buffer.from(b64, "base64"));
console.log(outFile);
