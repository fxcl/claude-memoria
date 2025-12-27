import * as fs from 'fs';
import {
  loadPlaybook,
  savePlaybook,
  loadTranscript,
  extractKeypoints,
  updatePlaybookData,
  clearSession,
} from './common.js';

async function main() {
  const stdinBuffer = fs.readFileSync(0, 'utf-8');
  if (!stdinBuffer) {
    process.exit(0);
  }

  let inputData;
  try {
    inputData = JSON.parse(stdinBuffer);
  } catch (e) {
    process.exit(0);
  }

  const transcriptPath = inputData.transcript_path;
  const messages = loadTranscript(transcriptPath);

  if (!messages || messages.length === 0) {
    process.exit(0);
  }

  let playbook = loadPlaybook();
  const extractionResult = await extractKeypoints(
    messages,
    playbook,
    'precompact_reflection'
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
