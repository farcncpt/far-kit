/**
 * Offscreen document script — maintains the WebSocket connection to ws-relay.mjs.
 * Forwards all commands to the background service worker for execution.
 *
 * Flow: CLI → ws-relay → this offscreen doc → chrome.runtime.sendMessage → background → content script
 */

var ws = null;
var reconnectTimer = null;
var port = 9333;
var commandCount = 0;

function log(msg, type) {
  console.log("[relay-offscreen] " + msg);
  chrome.runtime.sendMessage({ type: "RELAY_LOG", message: msg, logType: type || "info" }).catch(function(){});
}

function updateStatus(connected) {
  chrome.runtime.sendMessage({
    type: "RELAY_STATUS",
    connected: connected,
    commandCount: commandCount,
    port: port
  }).catch(function(){});
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket("ws://localhost:" + port);
  } catch (e) {
    log("Failed to create WebSocket: " + e.message, "error");
    scheduleReconnect();
    return;
  }

  ws.onopen = function() {
    log("Connected to relay server", "success");
    ws.send(JSON.stringify({ type: "register", role: "extension" }));
    updateStatus(true);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onclose = function() {
    log("Disconnected from relay server");
    updateStatus(false);
    scheduleReconnect();
  };

  ws.onerror = function() {
    log("WebSocket error — is ws-relay.mjs running?", "error");
  };

  ws.onmessage = function(event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch(e) { return; }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "command") {
      commandCount++;
      updateStatus(true);
      var action = msg.command && msg.command.action || "unknown";
      log("Command: " + action, "command");

      // Forward to background service worker for execution
      // Pass through the full command object including tabId for multi-tab targeting
      var command = msg.command || {};
      chrome.runtime.sendMessage({
        type: "RELAY_COMMAND",
        id: msg.id,
        command: {
          action: command.action,
          params: command.params || {},
          tabId: command.tabId || undefined
        }
      }, function(response) {
        if (chrome.runtime.lastError) {
          log("Background error: " + chrome.runtime.lastError.message, "error");
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id: msg.id, type: "result", error: chrome.runtime.lastError.message }));
          }
          return;
        }
        // Send result back to relay server
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: msg.id, type: "result", data: response ? response.data : null, error: response ? response.error : null }));
        }
        if (response && !response.error) {
          log("Result sent for: " + action, "success");
        }
      });
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function() {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// Listen for messages from popup and background
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === "RELAY_CONNECT") {
    port = msg.port || 9333;
    connect();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "RELAY_DISCONNECT") {
    if (ws) ws.close();
    ws = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    updateStatus(false);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "RELAY_GET_STATUS") {
    sendResponse({
      connected: ws ? ws.readyState === WebSocket.OPEN : false,
      commandCount: commandCount,
      port: port
    });
    return false;
  }
  return false;
});

// ─── Keep the service worker alive (mutual heartbeat) ───
// MV3 service workers evict after ~30s idle, and chrome.alarms is clamped to a
// 1-minute minimum — too slow to prevent eviction. A long-lived port pinged
// every 20s keeps the SW non-evictable, which in turn stops Chrome from reaping
// THIS offscreen document (and its relay WebSocket). The SW replies on the same
// port; if the port drops (SW cycled), the next tick re-establishes it.
var keepalivePort = null;

function startKeepalive() {
  try {
    keepalivePort = chrome.runtime.connect({ name: "relay-keepalive" });
    keepalivePort.onDisconnect.addListener(function() { keepalivePort = null; });
  } catch (e) {
    keepalivePort = null;
  }
}

setInterval(function() {
  if (!keepalivePort) startKeepalive();
  try {
    if (keepalivePort) keepalivePort.postMessage({ type: "ping" });
  } catch (e) {
    keepalivePort = null;
  }
}, 20000);

startKeepalive();

// Auto-connect on load
connect();
