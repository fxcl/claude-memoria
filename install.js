#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

// Color output helpers
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// Get paths
const homeDir = os.homedir();
const claudeDir = path.join(homeDir, '.claude');
const hooksDir = path.join(claudeDir, 'hooks');
const settingsPath = path.join(claudeDir, 'settings.json');
const sourceDir = path.join(__dirname, 'src');

// Ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Copy directory recursively (excluding settings.json)
function copyDir(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.name !== 'settings.json') {
      // Skip settings.json (handled separately)
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Merge settings.json
function mergeSettings(srcSettingsPath) {
  // Load source settings with placeholder replacement
  let srcSettings = {};
  if (fs.existsSync(srcSettingsPath)) {
    try {
      let content = fs.readFileSync(srcSettingsPath, 'utf-8');
      
      // Replace placeholders with actual hook commands
      const hooks = {
        'HOOK_COMMAND_USER_PROMPT_INJECT': 'user_prompt_inject.js',
        'HOOK_COMMAND_SESSION_END': 'session_end.js',
        'HOOK_COMMAND_PRECOMPACT': 'precompact.js'
      };
      
      for (const [placeholder, scriptName] of Object.entries(hooks)) {
        const command = `node "${path.join(hooksDir, scriptName)}"`;
        content = content.replace(
          new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g'),
          JSON.stringify(command).slice(1, -1)
        );
      }
      
      srcSettings = JSON.parse(content);
    } catch (e) {
      log(`⚠ Failed to parse source settings: ${e.message}`, 'yellow');
    }
  }

  // Load destination settings
  let destSettings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      destSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (e) {
      log(`⚠ Failed to parse destination settings: ${e.message}`, 'yellow');
    }
  }

  // Merge hooks
  if (srcSettings.hooks) {
    if (!destSettings.hooks) {
      destSettings.hooks = {};
    }

    for (const [eventName, eventHooks] of Object.entries(srcSettings.hooks)) {
      if (!destSettings.hooks[eventName]) {
        destSettings.hooks[eventName] = [];
      }

      // 1. Remove legacy Python hooks for this project
      const legacyScripts = [
        'user_prompt_inject.py',
        'session_end.py',
        'precompact.py'
      ];
      
      destSettings.hooks[eventName] = destSettings.hooks[eventName].filter(group => {
         // Keep group if none of its hooks are legacy python scripts for this project
         const hasLegacy = (group.hooks || []).some(h => 
            legacyScripts.some(script => h.command && h.command.includes(script))
         );
         return !hasLegacy;
      });

      // 2. Add new Node hooks
      for (const hookGroup of eventHooks) {
        const existingCommands = new Set(
          destSettings.hooks[eventName]
            .flatMap(g => g.hooks || [])
            .map(h => h.command)
        );
        
        const newHooks = (hookGroup.hooks || []).filter(
          h => !existingCommands.has(h.command)
        );
        
        if (newHooks.length > 0) {
          log(`Adding new hooks for ${eventName}`, 'green');
          destSettings.hooks[eventName].push({
            ...hookGroup,
            hooks: newHooks
          });
        } else {
             log(`No new hooks to add for ${eventName}`, 'yellow');
        }
      }
    }
  }

  // Merge other top-level properties
  for (const [key, value] of Object.entries(srcSettings)) {
    if (key !== 'hooks' && !(key in destSettings)) {
      destSettings[key] = value;
    }
  }

  return destSettings;
}

// Save settings.json
function saveSettings(settings) {
  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

// Main installation function
function install() {
  log('\n=== Claude Memoria Installation ===\n', 'blue');

  try {
    // Step 1: Check directories
    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(distDir)) {
      log('❌ Dist directory not found! Run "npm run build" first.', 'red');
      process.exit(1);
    }
    
    // Step 2: Copy hooks (from dist) and prompts (from src)
    log(`ℹ Copying files to ${claudeDir}...`, 'blue');
    
    // Copy compiled hooks
    const distHooksDir = path.join(distDir, 'hooks');
    if (fs.existsSync(distHooksDir)) {
      copyDir(distHooksDir, hooksDir);
    }

    // Copy prompts
    const srcPromptsDir = path.join(sourceDir, 'prompts');
    const destPromptsDir = path.join(claudeDir, 'prompts');
    if (fs.existsSync(srcPromptsDir)) {
      copyDir(srcPromptsDir, destPromptsDir);
    }

    log('✓ Files copied to ~/.claude/', 'green');

    // Step 3: Merge settings.json
    log('ℹ Merging settings.json...', 'blue');
    const srcSettingsPath = path.join(sourceDir, 'settings.json');
    if (fs.existsSync(srcSettingsPath)) {
      const mergedSettings = mergeSettings(srcSettingsPath);
      saveSettings(mergedSettings);
      log('✓ Settings merged successfully', 'green');
    } else {
      log('⚠ No settings.json found in source directory', 'yellow');
    }

    // Display installation results
    log('\n=== Installation Complete! ===\n', 'green');
    log('ℹ Hook files installed to:', 'blue');
    console.log(`  ${claudeDir}/hooks/`);
    console.log(`  ${claudeDir}/prompts/`);
    log('ℹ User settings updated at:', 'blue');
    console.log(`  ${settingsPath}\n`);
    log('📝 Next steps:', 'yellow');
    console.log('1. Restart Claude Code or start a new session');
    console.log('2. Hooks are now active at user level (work across all projects)');
    console.log('3. Check ~/.claude/settings.json to verify hook registration');

  } catch (err) {
    log(`❌ Installation failed: ${err.message}`, 'red');
    console.error(err);
    process.exit(1);
  }
}

// Run installation
install();
