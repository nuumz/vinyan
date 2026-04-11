/**
 * Direct Tool Resolver — deterministic, platform-aware command resolution.
 *
 * Classifies user goals into direct-tool categories (app launch, URL open, etc.)
 * and resolves them to platform-correct shell commands without LLM involvement.
 *
 * A3 compliant: fully deterministic, same input → same output.
 */

// ---------------------------------------------------------------------------
// Classification types
// ---------------------------------------------------------------------------

export type DirectToolType = 'app_launch' | 'url_open' | 'file_open';

export interface DirectToolClassification {
  type: DirectToolType;
  target: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// App name normalization — maps natural language to platform executables
// ---------------------------------------------------------------------------

interface PlatformApp {
  darwin: string;
  linux: string;
  win32: string;
}

const APP_MAP = new Map<string, PlatformApp>([
  // Browsers
  ['google chrome', { darwin: 'Google Chrome', linux: 'google-chrome', win32: 'chrome' }],
  ['chrome', { darwin: 'Google Chrome', linux: 'google-chrome', win32: 'chrome' }],
  ['firefox', { darwin: 'Firefox', linux: 'firefox', win32: 'firefox' }],
  ['safari', { darwin: 'Safari', linux: 'safari', win32: 'safari' }],
  ['brave', { darwin: 'Brave Browser', linux: 'brave-browser', win32: 'brave' }],
  ['edge', { darwin: 'Microsoft Edge', linux: 'microsoft-edge', win32: 'msedge' }],
  ['opera', { darwin: 'Opera', linux: 'opera', win32: 'opera' }],
  ['arc', { darwin: 'Arc', linux: 'arc', win32: 'arc' }],

  // Dev tools
  ['vscode', { darwin: 'Visual Studio Code', linux: 'code', win32: 'code' }],
  ['visual studio code', { darwin: 'Visual Studio Code', linux: 'code', win32: 'code' }],
  ['code', { darwin: 'Visual Studio Code', linux: 'code', win32: 'code' }],
  ['cursor', { darwin: 'Cursor', linux: 'cursor', win32: 'cursor' }],
  ['iterm', { darwin: 'iTerm', linux: 'xterm', win32: 'cmd' }],
  ['iterm2', { darwin: 'iTerm', linux: 'xterm', win32: 'cmd' }],
  ['terminal', { darwin: 'Terminal', linux: 'gnome-terminal', win32: 'cmd' }],
  ['warp', { darwin: 'Warp', linux: 'warp-terminal', win32: 'warp' }],
  ['postman', { darwin: 'Postman', linux: 'postman', win32: 'postman' }],
  ['insomnia', { darwin: 'Insomnia', linux: 'insomnia', win32: 'insomnia' }],
  ['docker', { darwin: 'Docker', linux: 'docker', win32: 'docker' }],
  ['docker desktop', { darwin: 'Docker', linux: 'docker', win32: 'Docker Desktop' }],

  // Communication
  ['slack', { darwin: 'Slack', linux: 'slack', win32: 'slack' }],
  ['discord', { darwin: 'Discord', linux: 'discord', win32: 'discord' }],
  ['teams', { darwin: 'Microsoft Teams', linux: 'teams', win32: 'teams' }],
  ['microsoft teams', { darwin: 'Microsoft Teams', linux: 'teams', win32: 'teams' }],
  ['zoom', { darwin: 'zoom.us', linux: 'zoom', win32: 'zoom' }],
  ['line', { darwin: 'LINE', linux: 'line', win32: 'line' }],
  ['telegram', { darwin: 'Telegram', linux: 'telegram-desktop', win32: 'telegram' }],

  // Productivity
  ['notion', { darwin: 'Notion', linux: 'notion', win32: 'notion' }],
  ['obsidian', { darwin: 'Obsidian', linux: 'obsidian', win32: 'obsidian' }],
  ['figma', { darwin: 'Figma', linux: 'figma', win32: 'figma' }],
  ['spotify', { darwin: 'Spotify', linux: 'spotify', win32: 'spotify' }],

  // Microsoft Office
  ['outlook', { darwin: 'Microsoft Outlook', linux: 'outlook', win32: 'outlook' }],
  ['microsoft outlook', { darwin: 'Microsoft Outlook', linux: 'outlook', win32: 'outlook' }],
  ['word', { darwin: 'Microsoft Word', linux: 'libreoffice --writer', win32: 'winword' }],
  ['microsoft word', { darwin: 'Microsoft Word', linux: 'libreoffice --writer', win32: 'winword' }],
  ['excel', { darwin: 'Microsoft Excel', linux: 'libreoffice --calc', win32: 'excel' }],
  ['microsoft excel', { darwin: 'Microsoft Excel', linux: 'libreoffice --calc', win32: 'excel' }],
  ['powerpoint', { darwin: 'Microsoft PowerPoint', linux: 'libreoffice --impress', win32: 'powerpnt' }],
  ['onenote', { darwin: 'Microsoft OneNote', linux: 'onenote', win32: 'onenote' }],

  // System
  ['finder', { darwin: 'Finder', linux: 'nautilus', win32: 'explorer' }],
  ['activity monitor', { darwin: 'Activity Monitor', linux: 'gnome-system-monitor', win32: 'taskmgr' }],
  ['calculator', { darwin: 'Calculator', linux: 'gnome-calculator', win32: 'calc' }],
  ['notes', { darwin: 'Notes', linux: 'gedit', win32: 'notepad' }],
  ['preview', { darwin: 'Preview', linux: 'eog', win32: 'mspaint' }],

  // Media
  ['vlc', { darwin: 'VLC', linux: 'vlc', win32: 'vlc' }],
  ['quicktime', { darwin: 'QuickTime Player', linux: 'vlc', win32: 'wmplayer' }],
]);

// Thai app name aliases
const THAI_APP_ALIASES = new Map<string, string>([
  ['กูเกิลโครม', 'google chrome'],
  ['โครม', 'chrome'],
  ['ไฟร์ฟอกซ์', 'firefox'],
  ['ซาฟารี', 'safari'],
  ['เทอร์มินัล', 'terminal'],
  ['ไลน์', 'line'],
  ['เทเลแกรม', 'telegram'],
  ['สแล็ค', 'slack'],
  ['ดิสคอร์ด', 'discord'],
  ['ซูม', 'zoom'],
  ['โน้ชั่น', 'notion'],
  ['สปอติฟาย', 'spotify'],
  ['ไฟน์เดอร์', 'finder'],
  ['เครื่องคิดเลข', 'calculator'],
]);

// ---------------------------------------------------------------------------
// Goal classification patterns
// ---------------------------------------------------------------------------

/** Thai trailing particles to strip from captured app names.
 * Order matters: longer compounds first, then singles. */
const THAI_PARTICLES = /(?:\s+(?:ให้เลย|ให้หน่อย|ให้ที|ให้ด้วย|ให้นะ|ให้สิ|ให้ครับ|ให้ค่ะ|ให้|ด้วย|หน่อย|ที|เลย|ครับ|ค่ะ|นะ|สิ))+$/;

/** Thai patterns for app launch. */
const THAI_APP_LAUNCH = /(?:อยาก(?:ให้)?)?(?:ช่วย)?(?:เปิด(?:แอพ|แอป|โปรแกรม|แอปพลิเคชัน)?|รัน|launch|open|start)\s+(.+)/i;

/** English patterns for app launch. */
const EN_APP_LAUNCH = /(?:open|launch|start|run)\s+(?:app\s+|application\s+)?(.+)/i;

/** URL pattern. */
const URL_PATTERN = /(?:เปิด|open|go\s+to|navigate\s+to|browse)\s+(https?:\/\/\S+)/i;

/** File open pattern. */
const FILE_OPEN_PATTERN = /(?:เปิด(?:ไฟล์)?|open(?:\s+file)?)\s+([^\s]+\.\w{1,10})/i;

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Classify a user goal as a direct-tool invocation.
 * Returns null if the goal doesn't match any direct-tool pattern.
 */
export function classifyDirectTool(goal: string): DirectToolClassification | null {
  const trimmed = goal.trim();

  // 1. URL open — highest confidence
  const urlMatch = trimmed.match(URL_PATTERN);
  if (urlMatch?.[1]) {
    return { type: 'url_open', target: urlMatch[1], confidence: 0.95 };
  }

  // 2. File open
  const fileMatch = trimmed.match(FILE_OPEN_PATTERN);
  if (fileMatch?.[1]) {
    return { type: 'file_open', target: fileMatch[1], confidence: 0.9 };
  }

  // 3. App launch — Thai
  const thaiMatch = trimmed.match(THAI_APP_LAUNCH);
  if (thaiMatch?.[1]) {
    const raw = thaiMatch[1].replace(THAI_PARTICLES, '').trim();
    const appName = normalizeAppName(raw);
    if (appName && APP_MAP.has(appName)) {
      return { type: 'app_launch', target: appName, confidence: 0.9 };
    }
    if (appName) {
      return { type: 'app_launch', target: appName, confidence: 0.7 };
    }
  }

  // 4. App launch — English
  const enMatch = trimmed.match(EN_APP_LAUNCH);
  if (enMatch?.[1]) {
    const appName = normalizeAppName(enMatch[1].trim());
    if (appName && APP_MAP.has(appName)) {
      return { type: 'app_launch', target: appName, confidence: 0.9 };
    }
    if (appName) {
      return { type: 'app_launch', target: appName, confidence: 0.7 };
    }
  }

  return null;
}

/**
 * Resolve a classification to a platform-correct shell command.
 * Returns null if the command cannot be resolved for this platform.
 */
export function resolveCommand(
  classification: DirectToolClassification,
  platform: string = process.platform,
): string | null {
  switch (classification.type) {
    case 'url_open':
      return resolveOpenCommand(classification.target, platform);

    case 'file_open':
      return resolveOpenCommand(classification.target, platform);

    case 'app_launch': {
      const app = APP_MAP.get(classification.target);
      if (app) {
        return resolveAppLaunch(app, platform);
      }
      // Unknown app — try platform open command with raw name
      return resolveAppLaunch(
        { darwin: classification.target, linux: classification.target, win32: classification.target },
        platform,
      );
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalize app name: lowercase, resolve Thai aliases, strip noise. */
function normalizeAppName(raw: string): string {
  let name = raw.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/['"]/g, '');

  // Resolve Thai aliases
  const thaiAlias = THAI_APP_ALIASES.get(name);
  if (thaiAlias) return thaiAlias;

  // Strip common prefixes
  name = name
    .replace(/^(?:app|application|แอพ|แอป|โปรแกรม)\s+/i, '');

  return name;
}

/** Generate open command for URLs and files. */
function resolveOpenCommand(target: string, platform: string): string {
  switch (platform) {
    case 'darwin':
      return `open ${quoteArg(target)}`;
    case 'linux':
      return `xdg-open ${quoteArg(target)}`;
    case 'win32':
      return `start "" ${quoteArg(target)}`;
    default:
      return `open ${quoteArg(target)}`;
  }
}

/** Generate app launch command for a specific platform. */
function resolveAppLaunch(app: PlatformApp, platform: string): string {
  switch (platform) {
    case 'darwin':
      return `open -a ${quoteArg(app.darwin)}`;
    case 'linux':
      return app.linux;
    case 'win32':
      return `start "" ${quoteArg(app.win32)}`;
    default:
      return `open -a ${quoteArg(app.darwin)}`;
  }
}

/** Shell-safe quoting: wrap in double quotes, escape internal double quotes. */
function quoteArg(s: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// App Discovery — search installed apps on the system
// ---------------------------------------------------------------------------

/** Cache of discovered apps: app directory listing → Set of app names (without .app). */
let discoveryCache: string[] | null = null;

/**
 * Discover an installed app by fuzzy-matching against /Applications/.
 * Returns the app name (e.g., "Microsoft Outlook") or null if not found.
 *
 * macOS only — returns null on other platforms.
 * Results are cached per process lifetime.
 */
export async function discoverApp(searchName: string, platform: string = process.platform): Promise<string | null> {
  if (platform !== 'darwin') return null;

  try {
    // Lazy-load and cache the app list
    if (!discoveryCache) {
      const proc = Bun.spawn(['ls', '/Applications/'], { stdout: 'pipe', stderr: 'pipe' });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      discoveryCache = stdout
        .split('\n')
        .filter((name) => name.endsWith('.app'))
        .map((name) => name.replace(/\.app$/, ''));
    }

    const needle = searchName.toLowerCase();

    // 1. Exact match (case-insensitive)
    const exact = discoveryCache.find((app) => app.toLowerCase() === needle);
    if (exact) return exact;

    // 2. Contains match — e.g., "outlook" matches "Microsoft Outlook"
    const contains = discoveryCache.filter((app) => app.toLowerCase().includes(needle));
    if (contains.length === 1) return contains[0];

    // 3. Multiple matches — prefer shortest name (most specific)
    if (contains.length > 1) {
      contains.sort((a, b) => a.length - b.length);
      return contains[0];
    }

    return null;
  } catch {
    return null;
  }
}

/** Clear the discovery cache (useful for testing). */
export function clearDiscoveryCache(): void {
  discoveryCache = null;
}
