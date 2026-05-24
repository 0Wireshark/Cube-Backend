const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const FormData = require("form-data");
const zlib = require("zlib");

const app = express.Router();
const { verifyToken } = require("../tokenManager/tokenVerify.js");
const User = require("../model/user.js");
const Profiles = require("../model/profiles.js");
const config = require("../Config/config.json");
const log = require("../structs/log.js");

const reportCooldowns = new Map();
const feedbackUploads = [];
const feedbackUploadFlushTimers = new Map();
const FEEDBACK_STORAGE_ROOT = path.join(__dirname, "..", "Saved", "Feedback");
const FEEDBACK_FILE_WINDOW_MS = 2 * 60 * 1000;
const BUG_REPORT_DISPATCH_DELAY_MS = 10000;
const STANDALONE_UPLOAD_DELAY_MS = 15000;
const DISCORD_ATTACHMENT_LIMIT_BYTES = 24 * 1024 * 1024;
const REPORT_DB_TIMEOUT_MS = 1500;
const WEBHOOK_SEND_GAP_MS = 1250;
const WEBHOOK_MAX_ATTEMPTS = 3;
const WEBHOOK_BASE_RETRY_MS = 1500;
const FEEDBACK_MAX_TRACKED_FILES = 300;
const webhookQueues = new Map();

const cooldownCleaner = setInterval(() => {
  const time = Date.now();
  for (const [key, expiresAt] of reportCooldowns) {
    if (expiresAt <= time) reportCooldowns.delete(key);
  }
}, 5 * 60 * 1000);
if (cooldownCleaner.unref) cooldownCleaner.unref();

function getReportConfig() {
  const reports = config.reports || {};
  return {
    enabled: reports.bEnableReports === true || config.bEnableReports === true,
    playerWebhookUrl: reports.playerWebhookUrl || config.bPlayerReportWebhookUrl || "",
    bugWebhookUrl: reports.bugWebhookUrl || config.bBugReportWebhookUrl || "",
    rateLimitSeconds: Math.max(0, Number(reports.rateLimitSeconds || config.bReportRateLimitSeconds || 60)),
    includePayload: reports.includePayload === true
  };
}

function isValidWebhookUrl(url) {
  return typeof url === "string" && /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(url.trim());
}

function truncate(value, max = 1024) {
  const text = String(value ?? "").trim();
  if (!text) return "Non fourni";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeLookupKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const REPORT_TEXT_VALUE_KEYS = [
  "value",
  "text",
  "description",
  "message",
  "comment",
  "comments",
  "details",
  "summary",
  "body",
  "content"
];

const ACCOUNT_ID_VALUE_KEYS = [
  "accountId",
  "account_id",
  "id",
  "playerId",
  "player_id",
  "userId",
  "user_id",
  "targetId",
  "target_id",
  "reportedPlayerId",
  "reported_player_id",
  "value",
  "text"
];

const DISPLAY_NAME_VALUE_KEYS = [
  "displayName",
  "display_name",
  "username",
  "userName",
  "name",
  "playerName",
  "player_name",
  "value",
  "text"
];

function valueToReportString(value, depth = 0, preferredKeys = REPORT_TEXT_VALUE_KEYS) {
  if (value === undefined || value === null || depth > 8) return "";

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return firstString(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = valueToReportString(item, depth + 1, preferredKeys);
      if (text) return text;
    }
    return "";
  }

  if (typeof value === "object") {
    for (const key of preferredKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const text = valueToReportString(value[key], depth + 1, preferredKeys);
      if (text) return text;
    }
  }

  return "";
}

function firstReportStringWithKeys(preferredKeys, ...values) {
  for (const value of values) {
    const text = valueToReportString(value, 0, preferredKeys);
    if (text) return text;
  }

  return "";
}

function firstReportString(...values) {
  return firstReportStringWithKeys(REPORT_TEXT_VALUE_KEYS, ...values);
}

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (timer.unref) timer.unref();
  });
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

function safeFileSegment(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);

  if (!cleaned || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

function decodeUrlPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFeedbackObjectPath(value) {
  const decoded = decodeUrlPath(String(value || "").split("?")[0])
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  const segments = decoded
    .split("/")
    .filter(Boolean)
    .filter(segment => segment !== "." && segment !== "..")
    .map(safeFileSegment);

  if (!segments.length || segments[0].toLowerCase() !== "client-feedback") {
    segments.unshift("client-feedback");
  }

  return segments.join("/");
}

function getFeedbackObjectPath(req) {
  const prefix = "/api/v1/access/fortnite/";
  const requestPath = String(req.originalUrl || "").split("?")[0];
  const rawObjectPath = requestPath.startsWith(prefix) ? requestPath.slice(prefix.length) : requestPath;
  return normalizeFeedbackObjectPath(rawObjectPath);
}

function parseFeedbackObjectPath(objectPath) {
  const segments = String(objectPath || "").split("/").filter(Boolean);
  return {
    accountId: segments[2] || "",
    mode: segments[3] || "",
    reportId: segments[4] || "",
    fileName: segments[segments.length - 1] || "feedback.bin"
  };
}

function getFeedbackStoragePath(objectPath) {
  const parts = normalizeFeedbackObjectPath(objectPath).split("/").map(safeFileSegment);
  const root = path.resolve(FEEDBACK_STORAGE_ROOT);
  const target = path.resolve(root, ...parts);

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return "";
  return target;
}

function getBaseUrl(req) {
  const proto = firstString(req.headers["x-forwarded-proto"], req.secure ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}

function getPublicAccessUrl(req) {
  const requestPath = String(req.originalUrl || "").split("?")[0];
  return `${getBaseUrl(req)}${requestPath}`;
}

function extensionFromContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  if (type.includes("gif")) return ".gif";
  if (type.includes("gzip")) return ".gz";
  if (type.includes("text/plain")) return ".txt";
  if (type.includes("json")) return ".json";
  return ".bin";
}

function detectContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return "image/webp";
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return "application/gzip";
  return "";
}

function getPayloadContentType(req, buffer) {
  return firstString(detectContentType(buffer), req.headers["content-type"], "application/octet-stream");
}

function normalizeTextForSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getTextFromFeedbackBuffer(fileName, contentType, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return "";

  const name = String(fileName || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();

  try {
    if (name.endsWith(".gz") || type.includes("gzip")) {
      return zlib.gunzipSync(buffer).toString("utf8");
    }

    if (
      name.endsWith(".txt") ||
      name.endsWith(".log") ||
      name.endsWith(".json") ||
      type.includes("text") ||
      type.includes("json")
    ) {
      return buffer.toString("utf8");
    }
  } catch (err) {
    log.debug(`Failed to read feedback text ${fileName}: ${err.message}`);
  }

  return "";
}

function extractWindowsBuild(text) {
  if (!text) return 0;

  const patterns = [
    /(?:build|buildnumber|osbuild)\D{0,12}(\d{5})/i,
    /\b10\.0\.(\d{5})\b/i,
    /\bWindows(?:\s+\w+)*\s+\(?(?:10\.0\.)?(\d{5})\)?/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]) || 0;
  }

  return 0;
}

function getNormalizedWindowsVersion(rawVersion, text) {
  const raw = firstString(rawVersion);
  if (!raw) return "";

  const build = extractWindowsBuild(text);
  if (build >= 22000) return `Windows 11 (Build ${build})`;
  if (build >= 10240) return `Windows 10 (Build ${build})`;

  if (/windows\s+10/i.test(raw) && /release\s+2009/i.test(raw)) {
    return "Windows 10/11 (kernel 10.0, Release 2009 - build non fourni)";
  }

  return raw;
}

function normalizeHardwareSurveyText(text, extraText = "") {
  if (!text) return text;

  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const osLineIndex = lines.findIndex(line => /^OSVersion\s*:/i.test(line));
  if (osLineIndex === -1) return text;

  const rawVersionLine = lines.find(line => /^OSVersionRaw\s*:/i.test(line));
  const rawVersion = firstString(
    rawVersionLine?.split(":").slice(1).join(":").trim(),
    lines[osLineIndex].split(":").slice(1).join(":").trim()
  );
  const normalizedVersion = getNormalizedWindowsVersion(rawVersion, `${text}\n${extraText}`);
  if (!normalizedVersion || normalizedVersion === rawVersion) return text;

  lines[osLineIndex] = `OSVersion: ${normalizedVersion}`;
  if (!rawVersionLine) lines.splice(osLineIndex + 1, 0, `OSVersionRaw: ${rawVersion}`);
  return lines.join("\r\n");
}

function normalizeFeedbackFileBuffer(fileName, contentType, buffer) {
  const name = String(fileName || "").toLowerCase();
  if (!name.includes("hardwaresurvey")) return { buffer, contentType };

  const text = getTextFromFeedbackBuffer(fileName, contentType, buffer);
  if (!text) return { buffer, contentType };

  return {
    buffer: Buffer.from(normalizeHardwareSurveyText(text), "utf8"),
    contentType: "text/plain"
  };
}

function analyzeFeedbackFile(file, buffer) {
  const text = getTextFromFeedbackBuffer(file.name, file.contentType, buffer);
  if (!text) return {};

  const metadata = {};
  if (file.name.toLowerCase().includes("hardwaresurvey")) {
    const osVersionMatch = text.match(/^OSVersion\s*:\s*(.+)$/mi);
    const rawOsVersionMatch = text.match(/^OSVersionRaw\s*:\s*(.+)$/mi);
    metadata.osVersion = firstString(osVersionMatch?.[1], rawOsVersionMatch?.[1]);
  }

  return metadata;
}

function readSavedFeedbackText(file) {
  if (!file?.path || !fs.existsSync(file.path)) return "";
  return getTextFromFeedbackBuffer(file.name, file.contentType, fs.readFileSync(file.path));
}

function refreshHardwareSurveyForGroup(file) {
  if (!file?.groupKey) return;

  const groupFiles = feedbackUploads.filter(item => item.groupKey === file.groupKey);
  const combinedText = groupFiles.map(readSavedFeedbackText).filter(Boolean).join("\n");
  if (!combinedText) return;

  for (const item of groupFiles) {
    if (!item.name.toLowerCase().includes("hardwaresurvey") || !fs.existsSync(item.path)) continue;

    const currentText = fs.readFileSync(item.path, "utf8");
    const normalizedText = normalizeHardwareSurveyText(currentText, combinedText);
    if (normalizedText === currentText) continue;

    const nextBuffer = Buffer.from(normalizedText, "utf8");
    fs.writeFileSync(item.path, nextBuffer);
    item.size = nextBuffer.length;
    item.contentType = "text/plain";
    item.metadata = analyzeFeedbackFile(item, nextBuffer);
  }
}

function bufferLooksText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;

  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    if (byte >= 128) continue;
    suspicious += 1;
  }

  return suspicious / sample.length < 0.05;
}

function isBinaryPayload(req, buffer) {
  const detectedType = detectContentType(buffer);
  if (detectedType) return true;

  const contentType = firstString(req.headers["content-type"]).toLowerCase();
  if (contentType.startsWith("image/")) return true;
  if (contentType.includes("gzip")) return true;
  if (contentType.includes("octet-stream")) return !bufferLooksText(buffer);
  return false;
}

function pruneFeedbackUploads() {
  const keepAfter = Date.now() - 15 * 60 * 1000;
  for (let i = feedbackUploads.length - 1; i >= 0; i--) {
    if (feedbackUploads[i].createdAt < keepAfter) cleanupFeedbackFiles([feedbackUploads[i]]);
  }

  while (feedbackUploads.length > FEEDBACK_MAX_TRACKED_FILES) {
    const before = feedbackUploads.length;
    cleanupFeedbackFiles([feedbackUploads[0]]);
    if (feedbackUploads.length === before) feedbackUploads.shift();
  }
}

function isPathInFeedbackStorage(filePath) {
  const root = path.resolve(FEEDBACK_STORAGE_ROOT);
  const target = path.resolve(String(filePath || ""));
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function removeEmptyFeedbackDirs(startDir) {
  const root = path.resolve(FEEDBACK_STORAGE_ROOT);
  let current = path.resolve(startDir);

  while (current.startsWith(`${root}${path.sep}`)) {
    try {
      fs.rmdirSync(current);
    } catch {
      break;
    }

    current = path.dirname(current);
  }
}

function cleanupFeedbackFiles(files) {
  const paths = new Set();
  const groupKeys = new Set();

  for (const file of uniqueFiles(files || [])) {
    if (file?.path) paths.add(path.resolve(file.path));
    if (file?.groupKey) groupKeys.add(file.groupKey);
  }

  for (const groupKey of groupKeys) {
    const timer = feedbackUploadFlushTimers.get(groupKey);
    if (!timer) continue;

    clearTimeout(timer);
    feedbackUploadFlushTimers.delete(groupKey);
  }

  for (const filePath of paths) {
    if (!isPathInFeedbackStorage(filePath)) continue;

    try {
      fs.rmSync(filePath, { force: true });
      removeEmptyFeedbackDirs(path.dirname(filePath));
    } catch (err) {
      log.debug(`Failed to cleanup feedback file ${filePath}: ${err.message}`);
    }
  }

  for (let i = feedbackUploads.length - 1; i >= 0; i--) {
    const filePath = feedbackUploads[i]?.path ? path.resolve(feedbackUploads[i].path) : "";
    if (paths.has(filePath)) feedbackUploads.splice(i, 1);
  }
}

function getFeedbackGroupKey(file) {
  return `${file.accountId || "unknown"}:${file.reportId || path.dirname(file.objectPath)}`;
}

function saveFeedbackFile(objectPath, buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  const normalizedPath = normalizeFeedbackObjectPath(objectPath);
  const parsed = parseFeedbackObjectPath(normalizedPath);
  const normalizedFile = normalizeFeedbackFileBuffer(parsed.fileName, contentType, buffer);
  buffer = normalizedFile.buffer;
  contentType = normalizedFile.contentType;

  const storagePath = getFeedbackStoragePath(normalizedPath);
  if (!storagePath) return null;

  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, buffer);

  const file = {
    objectPath: normalizedPath,
    path: storagePath,
    name: safeFileSegment(parsed.fileName),
    size: buffer.length,
    contentType: firstString(contentType, "application/octet-stream"),
    accountId: parsed.accountId,
    reportId: parsed.reportId,
    metadata: {},
    createdAt: Date.now(),
    sent: false
  };
  file.metadata = analyzeFeedbackFile(file, buffer);
  file.groupKey = getFeedbackGroupKey(file);

  feedbackUploads.push(file);
  pruneFeedbackUploads();
  refreshHardwareSurveyForGroup(file);
  scheduleFeedbackUploadFlush(file);
  log.debug(`Saved feedback file ${normalizedPath} (${formatBytes(buffer.length)})`);

  return file;
}

function saveInlineFeedbackFile(req, reporterId, feedbackType) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return null;
  if (!isBinaryPayload(req, req.body)) return null;

  const contentType = getPayloadContentType(req, req.body);
  const extension = extensionFromContentType(contentType);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const accountId = safeFileSegment(reporterId || "unknown");
  const fileName = contentType.startsWith("image/") ? `Screenshot${extension}` : `payload${extension}`;
  const objectPath = `client-feedback/Fortnite/${accountId}/Athena/Inline-${feedbackType}-${timestamp}/${fileName}`;

  return saveFeedbackFile(objectPath, req.body, contentType);
}

function uniqueFiles(files) {
  const seen = new Set();
  return files.filter(file => {
    if (!file?.path || seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function getRecentFeedbackFiles(accountId, currentFiles = []) {
  const now = Date.now();
  const matchingFiles = feedbackUploads
    .filter(file => !file.sent)
    .filter(file => now - file.createdAt <= FEEDBACK_FILE_WINDOW_MS)
    .filter(file => !accountId || file.accountId === accountId)
    .sort((a, b) => b.createdAt - a.createdAt);

  const groupKey = currentFiles.find(Boolean)?.groupKey || matchingFiles[0]?.groupKey;
  const groupFiles = groupKey ? matchingFiles.filter(file => file.groupKey === groupKey) : matchingFiles;

  return uniqueFiles([...currentFiles, ...groupFiles]);
}

function isImageFile(file) {
  const ext = path.extname(file.name || "").toLowerCase();
  return String(file.contentType || "").startsWith("image/") || [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext);
}

function getSafeAttachmentName(file, index) {
  const ext = path.extname(file.name || "");
  const base = safeFileSegment(path.basename(file.name || `feedback-${index}`, ext)).slice(0, 80) || `feedback-${index}`;
  return `${base}${index ? `-${index}` : ""}${ext || extensionFromContentType(file.contentType)}`;
}

function getAttachableFiles(files) {
  let totalSize = 0;
  const ordered = [...files].sort((a, b) => {
    if (isImageFile(a) && !isImageFile(b)) return -1;
    if (!isImageFile(a) && isImageFile(b)) return 1;
    return a.createdAt - b.createdAt;
  });

  return ordered.filter((file, index) => {
    if (!fs.existsSync(file.path)) return false;
    if (file.size > DISCORD_ATTACHMENT_LIMIT_BYTES) return false;
    if (totalSize + file.size > DISCORD_ATTACHMENT_LIMIT_BYTES) return false;

    totalSize += file.size;
    file.attachmentName = getSafeAttachmentName(file, index);
    return true;
  });
}

function formatFeedbackFileList(files) {
  return files
    .map(file => {
      const suffix = file.size > DISCORD_ATTACHMENT_LIMIT_BYTES ? " (non joint, trop lourd pour Discord)" : "";
      return `${file.name} - ${formatBytes(file.size)}${suffix}`;
    })
    .join("\n");
}

function getDetectedOsFromFiles(files) {
  for (const file of files) {
    const osVersion = firstString(file?.metadata?.osVersion);
    if (osVersion) return osVersion;
  }

  return "";
}

function addEmbedFieldOnce(embed, name, value, inline = false) {
  if (!value) return;
  embed.fields = embed.fields || [];

  const targetName = normalizeTextForSearch(name);
  if (embed.fields.some(item => normalizeTextForSearch(item.name) === targetName)) return;
  embed.fields.push(field(name, value, inline));
}

function applyFeedbackMetadata(embed, files) {
  const osVersion = getDetectedOsFromFiles(files);

  addEmbedFieldOnce(embed, "Systeme", osVersion, true);
}

function withFeedbackFiles(embed, files) {
  const nextEmbed = JSON.parse(JSON.stringify(embed));
  if (!files.length) return nextEmbed;

  applyFeedbackMetadata(nextEmbed, files);
  nextEmbed.fields = nextEmbed.fields || [];
  nextEmbed.fields.push(field("Fichiers feedback", formatFeedbackFileList(files), false));

  const attachableImage = files.find(file => file.attachmentName && isImageFile(file));
  if (attachableImage) {
    nextEmbed.image = { url: `attachment://${attachableImage.attachmentName}` };
  }

  return nextEmbed;
}

function markFilesSent(files) {
  for (const file of files) {
    file.sent = true;
  }

  cleanupFeedbackFiles(files);
}

function buildFeedbackFilesEmbed(files) {
  const firstFile = files[0] || {};
  return {
    title: "Fichiers feedback",
    color: 0x3498db,
    timestamp: new Date().toISOString(),
    fields: [
      field("Joueur", firstFile.accountId || "Non fourni", true),
      field("Dossier", firstFile.reportId || "Non fourni", true)
    ]
  };
}

function buildFileAccessResponse(req, objectPath) {
  const accessUrl = getPublicAccessUrl(req);
  const now = new Date().toISOString();

  return {
    files: {
      [objectPath]: {
        readLink: accessUrl,
        writeLink: accessUrl,
        hash: "",
        lastModified: now,
        size: 0,
        fileLocked: false
      }
    },
    url: accessUrl,
    uploadUrl: accessUrl,
    uploadURL: accessUrl,
    href: accessUrl,
    method: "PUT",
    headers: {},
    access: {
      url: accessUrl,
      method: "PUT",
      headers: {}
    },
    links: {
      upload: accessUrl,
      read: accessUrl,
      write: accessUrl
    },
    uploads: [{
      url: accessUrl,
      method: "PUT",
      headers: {}
    }],
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
}

function scheduleFeedbackUploadFlush(file) {
  if (!file?.groupKey || feedbackUploadFlushTimers.has(file.groupKey)) return;

  const timer = setTimeout(async () => {
    feedbackUploadFlushTimers.delete(file.groupKey);

    const files = feedbackUploads.filter(item => !item.sent && item.groupKey === file.groupKey);
    if (!files.length) return;

    const settings = getReportConfig();
    if (!settings.enabled) return;

    await dispatchWebhook(settings.bugWebhookUrl, buildFeedbackFilesEmbed(files), "feedback files", files);
  }, STANDALONE_UPLOAD_DELAY_MS);

  if (timer.unref) timer.unref();
  feedbackUploadFlushTimers.set(file.groupKey, timer);
}

function cancelFeedbackUploadFlush(files) {
  const groupKeys = new Set(files.map(file => file?.groupKey).filter(Boolean));

  for (const groupKey of groupKeys) {
    const timer = feedbackUploadFlushTimers.get(groupKey);
    if (!timer) continue;

    clearTimeout(timer);
    feedbackUploadFlushTimers.delete(groupKey);
  }
}

function scheduleWebhookDispatch(url, embedOrBuilder, label, getFiles) {
  const timer = setTimeout(async () => {
    const files = typeof getFiles === "function" ? getFiles() : [];
    const embed = typeof embedOrBuilder === "function" ? embedOrBuilder(files) : embedOrBuilder;
    await dispatchWebhook(url, embed, label, files);
  }, BUG_REPORT_DISPATCH_DELAY_MS);

  if (timer.unref) timer.unref();
}

function sendReportClientSuccess(res) {
  if (res.headersSent) return;
  return res.status(200).json({ success: true });
}

function parseUrlEncodedPayload(text) {
  const params = new URLSearchParams(text);
  const payload = {};

  for (const [key, value] of params.entries()) {
    if (!key) continue;
    if (payload[key] === undefined) {
      payload[key] = value;
      continue;
    }

    if (!Array.isArray(payload[key])) payload[key] = [payload[key]];
    payload[key].push(value);
  }

  return payload;
}

function parseTextPayload(text) {
  const trimmed = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    if (trimmed.includes("=")) {
      const payload = parseUrlEncodedPayload(trimmed);
      if (hasUsefulPayload(payload)) return payload;
    }

    return { raw: trimmed };
  }
}

function mergeQueryPayload(body, query) {
  if (!query || !Object.keys(query).length) return body;
  if (!body || typeof body !== "object") return query;
  if (Array.isArray(body)) return hasUsefulPayload(body) ? { payload: body, ...query } : query;
  return { ...query, ...body };
}

function getRequestPayload(req) {
  let body = req.body;

  if (Buffer.isBuffer(body)) {
    if (!isBinaryPayload(req, body) || bufferLooksText(body)) {
      body = parseTextPayload(body.toString("utf8"));
    } else {
      return mergeQueryPayload({
        rawBytes: body.length,
        contentType: getPayloadContentType(req, body)
      }, req.query);
    }
  } else if (typeof body === "string") {
    body = parseTextPayload(body);
  } else if (!body || typeof body !== "object") {
    body = {};
  }

  return mergeQueryPayload(body, req.query);
}

function field(name, value, inline = false) {
  return {
    name: truncate(name, 256),
    value: truncate(value, 1024),
    inline
  };
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req) {
  return firstString(
    headerValue(req.headers["cf-connecting-ip"]),
    headerValue(req.headers["x-forwarded-for"])?.split(",")[0],
    req.ip,
    req.socket?.remoteAddress
  );
}

function hasUsefulPayload(value) {
  if (!value || typeof value !== "object") return false;

  return Object.values(value).some(item => {
    if (item === undefined || item === null) return false;
    if (typeof item === "string") return item.trim().length > 0;
    if (Array.isArray(item)) return item.length > 0;
    if (typeof item === "object") return hasUsefulPayload(item);
    return true;
  });
}

function stringify(value, max = 1024) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return truncate(value, max);

  try {
    return truncate(JSON.stringify(value, null, 2), max);
  } catch {
    return truncate(String(value), max);
  }
}

function findValueByKeys(value, keys, depth = 0, normalizedKeys = null, preferredValueKeys = REPORT_TEXT_VALUE_KEYS) {
  if (!value || typeof value !== "object" || depth > 6) return "";

  const lookupKeys = normalizedKeys || new Set(keys.map(normalizeLookupKey));
  const pairKey = valueToReportString(
    value.key ?? value.field ?? value.fieldName ?? value.property ?? value.name ?? value.id,
    depth + 1,
    DISPLAY_NAME_VALUE_KEYS
  );
  const pairValue = value.value ?? value.text ?? value.stringValue ?? value.data;
  if (pairKey && lookupKeys.has(normalizeLookupKey(pairKey))) {
    const found = valueToReportString(pairValue, depth + 1, preferredValueKeys);
    if (found) return found;
  }

  for (const [key, item] of Object.entries(value)) {
    if (!lookupKeys.has(normalizeLookupKey(key))) continue;

    const found = valueToReportString(item, depth + 1, preferredValueKeys);
    if (found) return found;
  }

  for (const item of Object.values(value)) {
    if (!item || typeof item !== "object") continue;

    if (Array.isArray(item)) {
      for (const child of item) {
        const found = findValueByKeys(child, keys, depth + 1, lookupKeys, preferredValueKeys);
        if (found) return found;
      }
      continue;
    }

    const found = findValueByKeys(item, keys, depth + 1, lookupKeys, preferredValueKeys);
    if (found) return found;
  }

  return "";
}

function getFeedbackLabel(body) {
  return firstString(body.feedbackPath, body.feedbackType, body.reportType, body.type);
}

function getReason(body) {
  const reason = firstReportString(
    body.reason,
    body.reasonText,
    body.selectedReason,
    body.selectedReasonText,
    body.bugReason,
    body.bugReasonText,
    body.reportReason,
    body.reasonCode,
    body.reportCategory,
    body.feedbackReason,
    body.feedbackCategory,
    body.issue,
    body.issueType,
    body.category,
    body.subject,
    findValueByKeys(body, [
      "reason",
      "reasontext",
      "selectedreason",
      "selectedreasontext",
      "bugreason",
      "bugreasontext",
      "reportreason",
      "reasoncode",
      "reportcategory",
      "feedbackreason",
      "feedbackcategory",
      "issue",
      "issuetype",
      "category",
      "subject",
      "title"
    ])
  );

  return reason;
}

function getDetails(body) {
  return firstReportString(
    body.details,
    body.detail,
    body.description,
    body.descriptionText,
    body.reportDescription,
    body.reportText,
    body.bugDescription,
    body.bugDetails,
    body.additionalDetails,
    body.userDescription,
    body.message,
    body.comment,
    body.comments,
    body.feedback,
    body.feedbackText,
    body.summary,
    body.note,
    body.notes,
    body.body,
    body.content,
    body.text,
    body.raw,
    body.rawBytes ? `Payload binaire recu (${body.rawBytes} bytes)` : "",
    findValueByKeys(body, [
      "details",
      "detail",
      "description",
      "descriptiontext",
      "reportdescription",
      "reporttext",
      "bugdescription",
      "bugdetails",
      "additionaldetails",
      "userdescription",
      "message",
      "comment",
      "comments",
      "feedback",
      "feedbacktext",
      "summary",
      "note",
      "notes",
      "body",
      "content",
      "text"
    ]),
    body.feedbackPath ? "Le client Fortnite n'a pas transmis de texte descriptif. Les fichiers feedback sont joints si le client les upload correctement." : ""
  );
}

function getTarget(body) {
  const accountId = firstReportStringWithKeys(
    ACCOUNT_ID_VALUE_KEYS,
    body.reportedPlayer,
    body.reportedPlayerId,
    body.reportedAccountId,
    body.reportedPlayerAccountId,
    body.reportedUser,
    body.reportedUserId,
    body.reportedEpicAccountId,
    body.targetAccountId,
    body.targetEpicAccountId,
    body.targetId,
    body.playerId,
    findValueByKeys(body, [
      "reportedplayer",
      "reportedplayerid",
      "reportedaccountid",
      "reportedplayeraccountid",
      "reporteduser",
      "reporteduserid",
      "reportedepicaccountid",
      "targetaccountid",
      "targetepicaccountid",
      "targetid",
      "playerid"
    ], 0, null, ACCOUNT_ID_VALUE_KEYS)
  );

  const name = firstReportStringWithKeys(
    DISPLAY_NAME_VALUE_KEYS,
    body.reportedPlayerName,
    body.reportedPlayerDisplayName,
    body.reportedDisplayName,
    body.reportedUsername,
    body.targetName,
    body.targetDisplayName,
    body.targetUsername,
    body.playerName,
    body.displayName,
    body.username,
    findValueByKeys(body, [
      "reportedplayername",
      "reportedplayerdisplayname",
      "reporteddisplayname",
      "reportedusername",
      "targetname",
      "targetdisplayname",
      "targetusername",
      "playername",
      "displayname",
      "username"
    ], 0, null, DISPLAY_NAME_VALUE_KEYS)
  );

  return { accountId, name };
}

function getContext(body) {
  return {
    Playlist: firstReportString(body.playlist, body.playlistName, body.gameMode, findValueByKeys(body, ["playlist", "playlistname", "gamemode"])),
    Match: firstReportString(body.matchId, body.sessionId, body.gameSessionId, findValueByKeys(body, ["matchid", "sessionid", "gamesessionid"])),
    Plateforme: firstReportString(body.platform, body.platformName, findValueByKeys(body, ["platform", "platformname"])),
    Version: firstReportString(body.build, body.buildVersion, body.version, findValueByKeys(body, ["build", "buildversion", "version"]))
  };
}

function compactContext(context) {
  return Object.entries(context)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function getFeedbackType(req, body) {
  const pathType = decodeURIComponent(req.params[0] || "").toLowerCase();
  const bodyType = firstString(body.feedbackType, body.reportType, body.type, body.category).toLowerCase();
  const target = getTarget(body);

  if (pathType.includes("bug") || pathType.includes("crash") || bodyType.includes("bug") || bodyType.includes("crash")) return "bug";
  if (pathType.includes("toxicity") || pathType.includes("abuse")) return "player";
  if (bodyType.includes("toxicity") || bodyType.includes("abuse") || bodyType.includes("playerreport") || bodyType.includes("player_report")) return "player";
  if (target.accountId || target.name) return "player";

  return "bug";
}

function formatAccount(user, fallbackId = "") {
  const name = user?.username || "Inconnu";
  const accountId = user?.accountId || fallbackId || "Non fourni";
  return `${name}\n\`${accountId}\``;
}

function formatReportedAccount(user, target = {}, fallbackId = "") {
  if (user) return formatAccount(user, fallbackId || target.accountId);

  const targetName = firstString(target.name);
  const accountId = firstString(target.accountId, fallbackId);
  if (targetName || accountId) {
    return `${targetName || "Inconnu"}\n\`${accountId || "Non fourni"}\``;
  }

  return formatAccount(null, fallbackId);
}

function buildPlayerEmbed({ reporter, reported, reportedAccountId, target, body, previousReports, req }) {
  const fields = [
    field("Auteur du signalement", formatAccount(reporter), false),
    field("Joueur signale", formatReportedAccount(reported, target, reportedAccountId), false),
    field("Raison ecrite par le joueur", getReason(body) || "Non fourni", false),
    field("Details ecrits par le joueur", getDetails(body) || "Non fourni", false)
  ];

  const context = compactContext(getContext(body));
  if (context) fields.push(field("Contexte", context, false));
  if (!hasUsefulPayload(body)) fields.push(field("Donnees recues", "Payload vide", false));
  if (Number.isFinite(previousReports)) fields.push(field("Anciens signalements", String(previousReports), true));

  const settings = getReportConfig();
  if (settings.includePayload && hasUsefulPayload(body)) {
    fields.push(field("Donnees recues", stringify(body, 900), false));
  }

  return {
    title: "Signalement joueur",
    color: 0xff8c00,
    timestamp: new Date().toISOString(),
    fields,
    footer: { text: `Endpoint: ${req.originalUrl} | IP: ${getClientIp(req) || "unknown"}` }
  };
}

function buildBugEmbed({ reporter, body, req }) {
  const fields = [
    field("Report envoye par", formatAccount(reporter), false),
    field("Motif", getReason(body) || "Non fourni", false),
    field("Details ecrits par le joueur", getDetails(body) || "Non fourni", false)
  ];

  const feedbackLabel = getFeedbackLabel(body);
  if (feedbackLabel) fields.splice(1, 0, field("Type de retour", feedbackLabel, true));

  const context = compactContext(getContext(body));
  if (context) fields.push(field("Contexte", context, false));
  if (!hasUsefulPayload(body)) fields.push(field("Donnees recues", "Payload vide", false));

  const settings = getReportConfig();
  if (settings.includePayload && hasUsefulPayload(body)) {
    fields.push(field("Donnees recues", stringify(body, 900), false));
  }

  return {
    title: "Signalement bug",
    color: 0x3498db,
    timestamp: new Date().toISOString(),
    fields,
    footer: { text: `Endpoint: ${req.originalUrl} | IP: ${getClientIp(req) || "unknown"}` }
  };
}

async function sendWebhookNow(url, embed, files = []) {
  if (!isValidWebhookUrl(url)) return false;

  const attachableFiles = getAttachableFiles(files);
  const payload = {
    username: "CUBE Signalements",
    allowed_mentions: { parse: [] },
    embeds: [withFeedbackFiles(embed, files)]
  };

  if (!attachableFiles.length) {
    await axios.post(url.trim(), payload, {
      timeout: 5000,
      validateStatus: status => status >= 200 && status < 300
    });

    return true;
  }

  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));

  attachableFiles.forEach((file, index) => {
    form.append(`files[${index}]`, fs.createReadStream(file.path), {
      filename: file.attachmentName,
      contentType: file.contentType
    });
  });

  await axios.post(url.trim(), form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 15000,
    validateStatus: status => status >= 200 && status < 300
  });

  return true;
}

function getWebhookRetryDelay(err, attempt) {
  const response = err?.response;
  const retryAfter = Number(response?.data?.retry_after || response?.headers?.["retry-after"]);

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil((retryAfter < 50 ? retryAfter * 1000 : retryAfter) + 250);
  }

  return WEBHOOK_BASE_RETRY_MS * attempt;
}

function isRetryableWebhookError(err) {
  const status = Number(err?.response?.status);
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return !err?.response;
}

async function sendWebhookWithRetry(url, embed, files = [], label = "webhook") {
  let lastError;

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      return await sendWebhookNow(url, embed, files);
    } catch (err) {
      lastError = err;
      if (attempt >= WEBHOOK_MAX_ATTEMPTS || !isRetryableWebhookError(err)) break;

      const delay = getWebhookRetryDelay(err, attempt);
      log.debug(`Retrying ${label} webhook in ${delay}ms after ${err.response?.status || err.code || err.message}`);
      await sleep(delay);
    }
  }

  throw lastError;
}

function enqueueWebhookSend(url, embed, files = [], label = "webhook") {
  if (!isValidWebhookUrl(url)) return sendWebhookWithRetry(url, embed, files, label);

  const key = url.trim();
  const previous = webhookQueues.get(key) || Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => sendWebhookWithRetry(url, embed, files, label));
  const queued = run
    .catch(() => undefined)
    .then(() => sleep(WEBHOOK_SEND_GAP_MS));

  webhookQueues.set(key, queued);
  queued.finally(() => {
    if (webhookQueues.get(key) === queued) webhookQueues.delete(key);
  });

  return run;
}

async function incrementPlayerReports(accountId) {
  if (!accountId) return 0;

  const profile = await Profiles.findOne({ accountId }).lean();
  const previousReports = Number(profile?.profiles?.totalReports) || 0;

  if (profile) {
    await Profiles.updateOne(
      { accountId },
      { $inc: { "profiles.totalReports": 1 } }
    );
  }

  return previousReports;
}

async function resolveUserFromToken(req) {
  if (req.user) return req.user;

  const auth = req.headers.authorization || "";
  if (!auth.toLowerCase().startsWith("bearer eg1~")) return null;

  const token = auth.slice("bearer eg1~".length);
  const storedToken = global.accessTokens?.find(i => i.token === `eg1~${token}`);
  if (!storedToken) return null;

  const decoded = jwt.decode(token);
  if (!decoded?.sub) return null;

  return User.findOne({ accountId: decoded.sub }).lean();
}

function getAccountIdFromToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.toLowerCase().startsWith("bearer eg1~")) return "";

  const token = auth.slice("bearer eg1~".length);
  const decoded = jwt.decode(token);
  return firstString(decoded?.sub);
}

async function resolveReporter(req, body) {
  const tokenUser = await resolveUserFromToken(req);
  if (tokenUser) return tokenUser;

  const accountId = firstReportStringWithKeys(
    ACCOUNT_ID_VALUE_KEYS,
    body.reporterAccountId,
    body.reporterId,
    body.reporter,
    body.submitterAccountId,
    body.submitterId,
    body.authorAccountId,
    body.authorId,
    body.userId,
    body.accountId,
    findValueByKeys(body, [
      "reporteraccountid",
      "reporterid",
      "reporter",
      "submitteraccountid",
      "submitterid",
      "authoraccountid",
      "authorid",
      "userid",
      "accountid"
    ], 0, null, ACCOUNT_ID_VALUE_KEYS)
  );

  if (!accountId) return null;
  return User.findOne({ accountId }).lean();
}

function getReporterAccountId(req, body) {
  return firstReportStringWithKeys(
    ACCOUNT_ID_VALUE_KEYS,
    getAccountIdFromToken(req),
    body.reporterAccountId,
    body.reporterId,
    body.reporter,
    body.submitterAccountId,
    body.submitterId,
    body.authorAccountId,
    body.authorId,
    body.userId,
    body.accountId,
    findValueByKeys(body, [
      "reporteraccountid",
      "reporterid",
      "reporter",
      "submitteraccountid",
      "submitterid",
      "authoraccountid",
      "authorid",
      "userid",
      "accountid"
    ], 0, null, ACCOUNT_ID_VALUE_KEYS)
  );
}

function getReporterId(req, body) {
  return firstString(
    getReporterAccountId(req, body),
    getClientIp(req)
  );
}

function checkCooldown(key, seconds) {
  if (!seconds) return false;

  const time = Date.now();
  const expiresAt = reportCooldowns.get(key);
  if (expiresAt && expiresAt > time) return true;

  reportCooldowns.set(key, time + seconds * 1000);
  return false;
}

function withTimeout(promise, timeoutMs, fallbackValue = null) {
  let timer;

  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
    if (timer.unref) timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function dispatchWebhook(url, embed, label, files = []) {
  try {
    const sent = await enqueueWebhookSend(url, embed, files, label);
    if (!sent) log.debug(`${label} webhook is not configured.`);
    if (sent) markFilesSent(files);
  } catch (err) {
    if (files.length && err.response?.status === 413) {
      log.error(`Failed to send ${label} webhook files: payload too large`);
      try {
        const sent = await enqueueWebhookSend(url, embed, [], `${label} fallback`);
        if (sent) markFilesSent(files);
      } catch (fallbackErr) {
        log.error(`Failed to send ${label} webhook fallback: ${fallbackErr.message}`);
      }
      return;
    }

    log.error(`Failed to send ${label} webhook: ${err.message}`);
  }
}

function getFilesForReport(accountId, currentFiles = []) {
  const files = getRecentFeedbackFiles(accountId, currentFiles);
  if (files.length || accountId) return files;
  return getRecentFeedbackFiles("", currentFiles);
}

async function processFeedbackReport({ settings, req, body, feedbackType }) {
  if (!settings.enabled) return;

  const reporterAccountId = getReporterAccountId(req, body);
  const reporterId = firstString(reporterAccountId, getClientIp(req), "unknown");
  const inlineFile = saveInlineFeedbackFile(req, reporterId, feedbackType);
  const currentFiles = inlineFile ? [inlineFile] : [];
  let reportFiles = getFilesForReport(reporterAccountId, currentFiles);
  const fallbackReporter = reporterAccountId ? { username: "Inconnu", accountId: reporterAccountId } : null;

  if (feedbackType !== "player") {
    const reporter = await withTimeout(
      resolveReporter(req, body).catch(err => {
        log.debug(`Failed to resolve bug feedback reporter: ${err.message}`);
        return null;
      }),
      REPORT_DB_TIMEOUT_MS,
      null
    );
    const effectiveAccountId = firstString(reporter?.accountId, reporterAccountId);
    const reporterInfo = reporter || (effectiveAccountId ? { username: "Inconnu", accountId: effectiveAccountId } : fallbackReporter);

    if (effectiveAccountId && effectiveAccountId !== reporterAccountId) {
      reportFiles = getFilesForReport(effectiveAccountId, reportFiles);
    }

    cancelFeedbackUploadFlush(reportFiles);

    scheduleWebhookDispatch(
      settings.bugWebhookUrl,
      files => {
        const fileReporterId = firstString(files.find(file => file?.accountId)?.accountId);
        const webhookReporter = reporterInfo || (fileReporterId ? { username: "Inconnu", accountId: fileReporterId } : null);
        return buildBugEmbed({ reporter: webhookReporter, body, req });
      },
      "bug report",
      () => getFilesForReport(effectiveAccountId || reporterAccountId, reportFiles)
    );
    return;
  }

  const reporter = await withTimeout(
    resolveReporter(req, body).catch(err => {
      log.debug(`Failed to resolve feedback reporter: ${err.message}`);
      return null;
    }),
    REPORT_DB_TIMEOUT_MS,
    null
  );

  const effectiveAccountId = firstString(reporter?.accountId, reporterAccountId);
  const reporterInfo = reporter || (effectiveAccountId ? { username: "Inconnu", accountId: effectiveAccountId } : null);

  if (effectiveAccountId && effectiveAccountId !== reporterAccountId) {
    reportFiles = getFilesForReport(effectiveAccountId, reportFiles);
  }

  const target = getTarget(body);
  const cooldownKey = `${feedbackType}:${reporterId}:${target.accountId || target.name}:${getReason(body)}:${getDetails(body)}`;
  if (checkCooldown(cooldownKey, settings.rateLimitSeconds)) return;

  cancelFeedbackUploadFlush(reportFiles);

  const reported = target.accountId
    ? await withTimeout(User.findOne({ accountId: target.accountId }).lean(), REPORT_DB_TIMEOUT_MS, null)
    : null;
  const previousReports = target.accountId
    ? await withTimeout(incrementPlayerReports(target.accountId), REPORT_DB_TIMEOUT_MS, undefined).catch(err => {
      log.error(`Failed to update report counter for ${target.accountId}: ${err.message}`);
      return undefined;
    })
    : undefined;

  const embed = buildPlayerEmbed({
    reporter: reporterInfo,
    reported,
    reportedAccountId: target.accountId,
    target,
    body,
    previousReports,
    req
  });

  scheduleWebhookDispatch(
    settings.playerWebhookUrl,
    embed,
    "player report",
    () => getFilesForReport(effectiveAccountId, reportFiles)
  );
}

async function processToxicityReport({ settings, req, body, reporter, reportedAccountId }) {
  if (!settings.enabled) return;

  const cooldownKey = `player:${reporter.accountId}:${reportedAccountId}`;
  if (checkCooldown(cooldownKey, settings.rateLimitSeconds)) return;

  const reported = await withTimeout(User.findOne({ accountId: reportedAccountId }).lean(), REPORT_DB_TIMEOUT_MS, null);
  const previousReports = await withTimeout(incrementPlayerReports(reportedAccountId), REPORT_DB_TIMEOUT_MS, undefined).catch(err => {
    log.error(`Failed to update report counter for ${reportedAccountId}: ${err.message}`);
    return undefined;
  });

  const embed = buildPlayerEmbed({
    reporter,
    reported,
    reportedAccountId,
    target: {},
    body,
    previousReports,
    req
  });

  await dispatchWebhook(settings.playerWebhookUrl, embed, "player report");
}

app.get("/api/v1/access/fortnite/client-feedback*", (req, res) => {
  const objectPath = getFeedbackObjectPath(req);

  log.debug(`GET /api/v1/access/fortnite/${objectPath} called`);
  res.setHeader("Cache-Control", "no-store");
  return res.json(buildFileAccessResponse(req, objectPath));
});

function handleFeedbackFileUpload(req, res) {
  const objectPath = getFeedbackObjectPath(req);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  log.debug(`${req.method} /api/v1/access/fortnite/${objectPath} called`);
  if (!body.length) return res.status(204).end();

  const file = saveFeedbackFile(objectPath, body, getPayloadContentType(req, body));
  if (!file) return res.status(400).json({ error: "Invalid feedback upload" });

  return res.status(204).end();
}

app.put("/api/v1/access/fortnite/client-feedback*", handleFeedbackFileUpload);
app.post("/api/v1/access/fortnite/client-feedback*", handleFeedbackFileUpload);
app.patch("/api/v1/access/fortnite/client-feedback*", handleFeedbackFileUpload);
app.head("/api/v1/access/fortnite/client-feedback*", (_req, res) => res.status(204).end());
app.options("/api/v1/access/fortnite/client-feedback*", (_req, res) => {
  res.setHeader("Allow", "GET,HEAD,OPTIONS,PUT,POST,PATCH");
  return res.status(204).end();
});

app.post("/fortnite/api/game/v2/toxicity/account/:unsafeReporter/report/:reportedPlayer", verifyToken, (req, res) => {
  const settings = getReportConfig();
  const body = getRequestPayload(req);
  const reporter = req.user;
  const reportedAccountId = req.params.reportedPlayer;

  log.debug(`POST /fortnite/api/game/v2/toxicity/account/${req.params.unsafeReporter}/report/${reportedAccountId} called`);

  sendReportClientSuccess(res);

  setImmediate(() => {
    processToxicityReport({ settings, req, body, reporter, reportedAccountId }).catch(err => {
      log.error(`Failed to process player report: ${err.message}`);
    });
  });
});

app.post("/fortnite/api/feedback/*", (req, res) => {
  const settings = getReportConfig();
  let body = getRequestPayload(req);
  if (Array.isArray(body)) body = body.length ? { payload: body } : {};
  const feedbackPath = firstString(req.params[0]);
  if (body && typeof body === "object") {
    body.feedbackPath = feedbackPath;
    body.feedbackType = body.feedbackType || feedbackPath;
  }
  const feedbackType = getFeedbackType(req, body);

  log.debug(`POST /fortnite/api/feedback/${feedbackPath || ""} called`);

  sendReportClientSuccess(res);

  setImmediate(() => {
    processFeedbackReport({ settings, req, body, feedbackType }).catch(err => {
      log.error(`Failed to process ${feedbackType} feedback: ${err.message}`);
    });
  });
});

module.exports = app;
