import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Anthropic from '@anthropic-ai/sdk';

export function getProjectDir(): string {
  const projectDir = process.env['CLAUDE_PROJECT_DIR'];
  if (projectDir) {
    return projectDir;
  }
  return os.homedir();
}

export function getUserClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

export function isDiagnosticMode(): boolean {
  const flagFile = path.join(getUserClaudeDir(), 'diagnostic_mode');
  return fs.existsSync(flagFile);
}

export function saveDiagnostic(content: string, name: string): void {
  const diagnosticDir = path.join(getUserClaudeDir(), 'diagnostic');
  fs.mkdirSync(diagnosticDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS... format roughly
  // To match python's %Y%m%d_%H%M%S more precisely:
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const pyTimestamp = `${year}${month}${day}_${hour}${minute}${second}`;
  
  const filepath = path.join(diagnosticDir, `${pyTimestamp}_${name}.txt`);
  fs.writeFileSync(filepath, content, 'utf-8');
}

export function isFirstMessage(sessionId: string): boolean {
  const sessionFile = path.join(getProjectDir(), '.claude', 'last_session.txt');

  if (fs.existsSync(sessionFile)) {
    const lastSessionId = fs.readFileSync(sessionFile, 'utf-8').trim();
    return sessionId !== lastSessionId;
  }

  return true;
}

export function markSession(sessionId: string): void {
  const sessionFile = path.join(getProjectDir(), '.claude', 'last_session.txt');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, sessionId, 'utf-8');
}

export function clearSession(): void {
  const sessionFile = path.join(getProjectDir(), '.claude', 'last_session.txt');
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
  }
}

export function generateKeypointName(existingNames: Set<string>): string {
  let maxNum = 0;
  for (const name of existingNames) {
    if (name.startsWith('kpt_')) {
      try {
        const num = parseInt(name.split('_')[1], 10);
        if (!isNaN(num)) {
          maxNum = Math.max(maxNum, num);
        }
      } catch (e) {
        continue;
      }
    }
  }
  return `kpt_${String(maxNum + 1).padStart(3, '0')}`;
}

export interface Settings {
  playbook_update_on_exit: boolean;
  playbook_update_on_clear: boolean;
}

export function loadSettings(): Settings {
  const settingsPath = path.join(getUserClaudeDir(), 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    return { playbook_update_on_exit: false, playbook_update_on_clear: false };
  }

  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return data;
  } catch (e) {
    return { playbook_update_on_exit: false, playbook_update_on_clear: false };
  }
}

export interface KeyPoint {
  name: string;
  text: string;
  score: number;
}

export interface Playbook {
  version: string;
  last_updated: string | null;
  key_points: KeyPoint[];
}

export function loadPlaybook(): Playbook {
  const playbookPath = path.join(getProjectDir(), '.claude', 'playbook.json');

  if (!fs.existsSync(playbookPath)) {
    return { version: '1.0', last_updated: null, key_points: [] };
  }

  try {
    const data = JSON.parse(fs.readFileSync(playbookPath, 'utf-8'));

    if (!data.key_points) {
      data.key_points = [];
    }

    const keypoints: KeyPoint[] = [];
    const existingNames = new Set<string>();

    for (const item of data.key_points) {
      if (typeof item === 'string') {
        const name = generateKeypointName(existingNames);
        keypoints.push({ name, text: item, score: 0 });
        existingNames.add(name);
      } else if (typeof item === 'object') {
        if (!item.name) {
          item.name = generateKeypointName(existingNames);
        }
        if (!item.score) {
          item.score = 0;
        }
        existingNames.add(item.name);
        keypoints.push(item);
      }
    }

    data.key_points = keypoints;
    return data as Playbook;

  } catch (e) {
    return { version: '1.0', last_updated: null, key_points: [] };
  }
}

export function savePlaybook(playbook: Playbook): void {
  playbook.last_updated = new Date().toISOString();
  const playbookPath = path.join(getProjectDir(), '.claude', 'playbook.json');

  fs.mkdirSync(path.dirname(playbookPath), { recursive: true });
  fs.writeFileSync(playbookPath, JSON.stringify(playbook, null, 2), 'utf-8');
}

export function formatPlaybook(playbook: Playbook): string {
  const keyPoints = playbook.key_points || [];
  if (keyPoints.length === 0) {
    return '';
  }

  const keyPointsText = keyPoints.map(kp => `- ${kp.text}`).join('\n');
  const template = loadTemplate('playbook.txt');
  return template.replace('{key_points}', keyPointsText);
}

export interface ExtractionResult {
  new_key_points: string[];
  evaluations: { name: string; rating: string }[];
}

export function updatePlaybookData(playbook: Playbook, extractionResult: ExtractionResult): Playbook {
  const newKeyPoints = extractionResult.new_key_points || [];
  const evaluations = extractionResult.evaluations || [];

  const existingNames = new Set(playbook.key_points.map(kp => kp.name));
  const existingTexts = new Set(playbook.key_points.map(kp => kp.text));

  for (const text of newKeyPoints) {
    if (text && !existingTexts.has(text)) {
      const name = generateKeypointName(existingNames);
      playbook.key_points.push({ name, text, score: 0 });
      existingNames.add(name);
    }
  }

  const ratingDelta: Record<string, number> = { 'helpful': 1, 'harmful': -3, 'neutral': -1 };
  const nameToKp = new Map(playbook.key_points.map(kp => [kp.name, kp]));

  for (const evalItem of evaluations) {
    const name = evalItem.name || '';
    const rating = evalItem.rating || 'neutral';

    if (nameToKp.has(name)) {
      const kp = nameToKp.get(name)!;
      kp.score += (ratingDelta[rating] || 0);
    }
  }

  playbook.key_points = playbook.key_points.filter(kp => (kp.score || 0) > -5);

  return playbook;
}

export function loadTranscript(transcriptPath: string): any[] {
  const conversations: any[] = [];

  try {
    const fileContent = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = fileContent.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        if (entry.isMeta || entry.isVisibleInTranscriptOnly) continue;

        const message = entry.message || {};
        const role = message.role;
        const content = message.content || '';

        if (!role || !content) continue;

        if (typeof content === 'string' && (content.includes('<command-name>') || content.includes('<local-command-stdout>'))) {
          continue;
        }

        if (Array.isArray(content)) {
          const textParts = content
            .filter((item: any) => typeof item === 'object' && item.type === 'text')
            .map((item: any) => item.text || '');
          
          if (textParts.length > 0) {
            conversations.push({ role, content: textParts.join('\n') });
          }
        } else {
          conversations.push({ role, content });
        }

      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    return [];
  }

  return conversations;
}

export function loadTemplate(templateName: string): string {
  const templatePath = path.join(getUserClaudeDir(), 'prompts', templateName);
  try {
    return fs.readFileSync(templatePath, 'utf-8');
  } catch (e) {
    return '';
  }
}

export async function extractKeypoints(
  messages: any[],
  playbook: Playbook,
  diagnosticName: string = 'reflection'
): Promise<ExtractionResult> {
  // Check for Anthropic API key/setup
  const apiKey = process.env['AGENTIC_CONTEXT_API_KEY'] || 
                 process.env['ANTHROPIC_AUTH_TOKEN'] || 
                 process.env['ANTHROPIC_API_KEY'];
  
  if (!apiKey) {
    if (isDiagnosticMode()) {
      saveDiagnostic('Missing API Key (AGENTIC_CONTEXT_API_KEY, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY). Extraction skipped.', `${diagnosticName}_error`);
    }
    return { new_key_points: [], evaluations: [] };
  }

  const model = process.env['AGENTIC_CONTEXT_MODEL'] || 
                process.env['ANTHROPIC_MODEL'] || 
                process.env['ANTHROPIC_DEFAULT_SONNET_MODEL'] || 
                'claude-sonnet-4-5-20250929';
  
  const baseUrl = process.env['AGENTIC_CONTEXT_BASE_URL'] || process.env['ANTHROPIC_BASE_URL'];

  const template = loadTemplate('reflection.txt');
  
  const playbookDict: Record<string, string> = {};
  if (playbook.key_points) {
    playbook.key_points.forEach(kp => {
      playbookDict[kp.name] = kp.text;
    });
  }

  // Rudimentary replacement for Python's format. 
  // Since template likely contains {trajectories} and {playbook}, we restart replace logic
  // Be careful if template format is strictly Python-style ({key}). JS uses variable names but here we must string replace.
  let prompt = template;
  // NOTE: This assumes the template specifically uses {trajectories} and {playbook} which simple .replace handles if they appear once.
  // If they appear multiple times, need .replace with global regex or replaceAll.
  // Also, Python's .format() handles generic {}, need to be careful.
  // But standard prompts usually just have these two placeholders.
  
  prompt = prompt.split('{trajectories}').join(JSON.stringify(messages, null, 2));
  prompt = prompt.split('{playbook}').join(JSON.stringify(playbookDict, null, 2));

  try {
    const client = new Anthropic({
      apiKey: apiKey,
      baseURL: baseUrl, // SDK uses baseURL not base_url
    });

    const response = await client.messages.create({
      model: model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseTextParts = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text);
    
    const responseText = responseTextParts.join('');

    if (isDiagnosticMode()) {
      saveDiagnostic(
        `# PROMPT\n${prompt}\n\n${'='.repeat(80)}\n\n# RESPONSE\n${responseText}\n`,
        diagnosticName
      );
    }

    if (!responseText) {
      return { new_key_points: [], evaluations: [] };
    }

    let jsonText = responseText.trim();
    if (jsonText.includes('```json')) {
      const start = jsonText.indexOf('```json') + 7;
      const end = jsonText.indexOf('```', start);
      if (end !== -1) {
        jsonText = jsonText.substring(start, end).trim();
      }
    } else if (jsonText.includes('```')) {
        const start = jsonText.indexOf('```') + 3;
        const end = jsonText.indexOf('```', start);
        if (end !== -1) {
          jsonText = jsonText.substring(start, end).trim();
        }
    }

    try {
      const result = JSON.parse(jsonText);
      return {
        new_key_points: result.new_key_points || [],
        evaluations: result.evaluations || [],
      };
    } catch (e) {
      return { new_key_points: [], evaluations: [] };
    }

  } catch (e) {
    return { new_key_points: [], evaluations: [] };
  }
}
