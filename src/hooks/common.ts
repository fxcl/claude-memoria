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

  // Extended Thinking budget (default: 16000 tokens, set to 0 to disable)
  const thinkingBudget = parseInt(process.env['AGENTIC_CONTEXT_THINKING_BUDGET'] || '16000', 10);

  // Multi-round reflection (default: 1 for backward compatibility)
  const maxRounds = parseInt(process.env['AGENTIC_CONTEXT_MAX_ROUNDS'] || '1', 10);
  const minRounds = Math.max(1, maxRounds);

  const template = loadTemplate('reflection.txt');

  const playbookDict: Record<string, string> = {};
  if (playbook.key_points) {
    playbook.key_points.forEach(kp => {
      playbookDict[kp.name] = kp.text;
    });
  }

  // Prompt caching: enable by default, disable with "false" string
  const useCache = process.env['AGENTIC_CONTEXT_USE_CACHE'] !== 'false';

  // Helper: Build API parameters with optional features
  function buildApiParams(prompt: string, includePlaybookInSystem: boolean): any {
    const apiParams: any = {
      model: model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    };

    // Add system messages with caching when enabled
    if (includePlaybookInSystem && useCache) {
      const playbookText = JSON.stringify(playbookDict, null, 2);
      apiParams.system = [{
        type: 'text',
        text: `# Current Playbook\n${playbookText}\n\nAnalyze the following reasoning trajectories in context of this playbook.`,
        cache_control: { type: 'ephemeral' }
      }];
    }

    // Add extended thinking if budget > 0
    if (thinkingBudget > 0) {
      apiParams.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };
    }

    return apiParams;
  }

  // Helper: Parse reflection response
  function parseReflectionResponse(response: any): any {
    const responseTextParts = response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text);

    const responseText = responseTextParts.join('');

    if (!responseText) {
      return { new_key_points: [], evaluations: [] };
    }

    let jsonText = responseText.trim();
    // Extract JSON from code blocks
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
      return JSON.parse(jsonText);
    } catch (e) {
      return { new_key_points: [], evaluations: [] };
    }
  }

  // Multi-round reflection loop
  let previousInsights: string[] = [];
  let finalResult: ExtractionResult = { new_key_points: [], evaluations: [] };

  for (let round = 0; round < minRounds; round++) {
    // Build round-specific prompt
    let roundPrompt = template;

    // Handle template placeholders
    if (useCache) {
      // Remove {playbook} placeholder (handled in system message)
      roundPrompt = roundPrompt.split('{playbook}').join('');
    } else {
      // Include playbook in prompt when not caching
      roundPrompt = roundPrompt.split('{playbook}').join(JSON.stringify(playbookDict, null, 2));
    }

    // Replace trajectories placeholder
    roundPrompt = roundPrompt.split('{trajectories}').join(JSON.stringify(messages, null, 2));

    // Add previous round insights if not first round
    if (round > 0 && previousInsights.length > 0) {
      roundPrompt += `\n\n# Previous Round Insights\n${previousInsights.join('\n')}\n\nBased on the previous insights, refine your analysis. Look for:\n- Deeper causal relationships\n- Patterns you may have missed\n- Contradictions in your earlier analysis\n`;
    }

    try {
      const client = new Anthropic({
        apiKey: apiKey,
        baseURL: baseUrl, // SDK uses baseURL not base_url
      });

      // Build API parameters (playbook in system only for first round or when caching)
      const includePlaybookInSystem = (round === 0) || useCache;
      const apiParams = buildApiParams(roundPrompt, includePlaybookInSystem);

      const response = await client.messages.create(apiParams);

      // Parse response
      const result = parseReflectionResponse(response);

      // Check for convergence
      const converged = result.found_root_cause ||
                        result.no_new_insights ||
                        (round > 0 && result.insights_depth === 'sufficient');

      // Accumulate insights
      if (result.insights) {
        previousInsights.push(...result.insights);
      }

      // Update final result (last round takes precedence for structured output)
      finalResult = {
        new_key_points: result.new_key_points || finalResult.new_key_points,
        evaluations: result.evaluations || finalResult.evaluations,
      };

      // Diagnostic output
      if (isDiagnosticMode()) {
        let diagnosticContent = `# ROUND ${round + 1}/${minRounds}\n`;
        if (useCache && includePlaybookInSystem) {
          diagnosticContent += `(Playbook cached in system message)\n`;
        }
        diagnosticContent += `# USER PROMPT\n${roundPrompt}\n\n${'='.repeat(80)}\n\n# RESPONSE\n${JSON.stringify(result, null, 2)}\n`;
        saveDiagnostic(diagnosticContent, diagnosticName);
      }

      // Stop if converged
      if (converged && round > 0) {
        if (isDiagnosticMode()) {
          saveDiagnostic(`Converged at round ${round + 1}`, `${diagnosticName}_convergence`);
        }
        break;
      }

    } catch (e) {
      // On error, log and continue with next round or return what we have
      if (isDiagnosticMode()) {
        saveDiagnostic(`Error in round ${round + 1}: ${e}`, `${diagnosticName}_error`);
      }
      // If first round fails, return empty; otherwise continue with accumulated results
      if (round === 0) {
        return { new_key_points: [], evaluations: [] };
      }
      break;
    }
  }

  return finalResult;
}
