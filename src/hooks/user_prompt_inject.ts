import * as fs from 'fs';
import {
  loadPlaybook,
  formatPlaybook,
  isDiagnosticMode,
  saveDiagnostic,
  isFirstMessage,
  markSession,
} from './common.js';

function main() {
  const stdinBuffer = fs.readFileSync(0, 'utf-8');
  if (!stdinBuffer) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  let inputData;
  try {
    inputData = JSON.parse(stdinBuffer);
  } catch (e) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const sessionId = inputData.session_id || 'unknown';

  if (!isFirstMessage(sessionId)) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const playbook = loadPlaybook();
  const context = formatPlaybook(playbook);

  if (!context) {
    if (isDiagnosticMode()) {
      saveDiagnostic('No context keys to inject (playbook is empty or score too low).', 'user_prompt_inject_empty');
    }
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  if (isDiagnosticMode()) {
    saveDiagnostic(context, 'user_prompt_inject');
  }

  const response = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  };

  console.log(JSON.stringify(response));

  markSession(sessionId);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error}`);
  console.log(JSON.stringify({}));
  process.exit(1);
}
