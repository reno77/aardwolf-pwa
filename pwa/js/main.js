// main.js -- entry point.
//
// The client used to be one ~3170-line <script> block in index.html. It is now
// split by concern; this module wires the pieces together.
//
// Inline on* attributes in index.html cannot see module scope, so the handlers
// they reference are re-exposed on `window` below. Handlers get migrated to
// addEventListener module by module; anything already migrated is deliberately
// absent from this list.

import { initDb, exportDb } from './db.js';
import {
  appendOutput, clearOutput, setMaxLines, setTriggersEnabled, saveBufferSetting,
  togglePanel, hidePanel, importFile, updateChatBadge,
  renderAliases, newAlias, editAlias, saveAliasEdit, cancelAliasEdit, deleteAliasEdit, exportAliases,
  renderTriggers, newTrigger, editTrigger, saveTriggerEdit, cancelTriggerEdit, deleteTriggerEdit,
} from './ui.js';
import { sendCmd, submitCmd, cmdHistoryUp, cmdHistoryDown, doConnect,
         showLogin, doLogin, closeLogin } from './net.js';
import { renderRooms } from './nav.js';
import { clearChat, onUnreadChange, sendChat } from './chat.js';
import { showFullMap, hideFullMap } from './map.js';
import { xcpNext, refreshCampaign } from './snd.js';
import { dinvCommand, buildInventory, renderInventory } from './dinv.js';
import { initButtons } from './buttons.js';
import './joystick.js';

Object.assign(window, {
  // net
  sendCmd, submitCmd, cmdHistoryUp, cmdHistoryDown, doConnect,
  showLogin, doLogin, closeLogin,
  // ui / panels
  togglePanel, hidePanel, clearOutput, setMaxLines, setTriggersEnabled, saveBufferSetting,
  renderAliases, newAlias, editAlias, saveAliasEdit, cancelAliasEdit, deleteAliasEdit, exportAliases,
  renderTriggers, newTrigger, editTrigger, saveTriggerEdit, cancelTriggerEdit, deleteTriggerEdit,
  // rooms / map / campaign
  renderRooms, showFullMap, hideFullMap, xcpNext, refreshCampaign,
  // chat
  clearChat, sendChat,
  // inventory (dinv)
  dinvCommand, buildInventory, renderInventory,
  // db
  exportDb, importFile,
});

// =============================================================================
// INIT
// =============================================================================
// The chat button's unread count. Wired here rather than inside chat.js so that module
// stays about classifying lines and knows nothing about which button represents it.
onUnreadChange(()=>updateChatBadge());
{
  const box = document.getElementById('chat-input');
  if(box) box.addEventListener('keydown', e => { if(e.key === 'Enter') sendChat(); });
}

initDb().then(()=>{
  // Needs sqlDb, so it cannot run at module load.
  initButtons();
  appendOutput('AardClient Local (SQLite)\n','system');
  appendOutput('All data stored in browser.\n','system');
  appendOutput('Swipe: rooms → aliases → triggers\n','system');
  appendOutput('Shortcut row: tap to send, hold to edit, + to add\n','system');
  // Deliberately not a list of commands. The banner used to name a dozen of them
  // and had already fallen behind twice; /help is generated from the one table
  // check_wiring.mjs holds to the dispatcher, so it cannot go stale.
  appendOutput('Type /help for every command.\n','system');
});
