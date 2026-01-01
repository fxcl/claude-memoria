import * as fs from 'fs';
import {
  loadPlaybook,
  savePlaybook,
  loadTranscript,
  extractKeypoints,
  updatePlaybookData,
  clearSession,
  loadSettings,
} from './common.js';

async function main() {
  let stdinBuffer: string;
  try {
    stdinBuffer = fs.readFileSync(0, 'utf-8');
  } catch (e) {
    console.error('Error reading stdin:', e);
    process.exit(1);
    return;
  }

  if (!stdinBuffer) {
    process.exit(0);
    return;
  }

  let inputData;
  try {
    inputData = JSON.parse(stdinBuffer);
  } catch (e) {
    console.error('Error parsing JSON input:', e);
    process.exit(1);
    return;
  }

  const transcriptPath = inputData.transcript_path;
  if (!transcriptPath) {
    console.error('Missing transcript_path in input');
    process.exit(1);
    return;
  }

  const messages = loadTranscript(transcriptPath);

  if (!messages || messages.length === 0) {
    process.exit(0);
    return;
  }

  const settings = loadSettings();
  const updateOnExit = settings.playbook_update_on_exit || false;
  const updateOnClear = settings.playbook_update_on_clear || false;

  const reason = inputData.reason || '';

  // Skip playbook update for /exit command when setting is disabled
  if (!updateOnExit && reason === 'prompt_input_exit') {
    process.exit(0);
  }

  // Skip playbook update for /clear command when setting is disabled
  if (!updateOnClear && reason === 'clear') {
    process.exit(0);
  }

  let playbook = loadPlaybook();
  const extractionResult = await extractKeypoints(
    messages,
    playbook,
    'session_end_reflection'
  );

  playbook = updatePlaybookData(playbook, extractionResult);
  savePlaybook(playbook);

  clearSession();
}

main().catch((error) => {
  console.error(`Error: ${error}`);
  console.error(error.stack);
  process.exit(1);
});
