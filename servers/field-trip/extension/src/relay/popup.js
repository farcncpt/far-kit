/**
 * Popup script — lightweight UI that talks to the offscreen relay doc.
 * This popup can be closed anytime without affecting the relay connection.
 */

var dotRelay = document.getElementById("dot-relay");
var statusRelay = document.getElementById("status-relay");
var statusCmds = document.getElementById("status-cmds");
var dotCmds = document.getElementById("dot-cmds");
var btnConnect = document.getElementById("btn-connect");
var btnDisconnect = document.getElementById("btn-disconnect");
var portInput = document.getElementById("port-input");
var logContainer = document.getElementById("log");

function addLog(msg, type) {
  var entry = document.createElement("div");
  entry.className = "log-entry " + (type || "info");
  var time = new Date().toLocaleTimeString("en-US", { hour12: false });
  entry.textContent = "[" + time + "] " + msg;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function updateUI(status) {
  if (status.connected) {
    dotRelay.className = "dot green";
    statusRelay.textContent = "Connected (:" + status.port + ")";
    btnConnect.style.display = "none";
    btnDisconnect.style.display = "";
    portInput.disabled = true;
  } else {
    dotRelay.className = "dot red";
    statusRelay.textContent = "Disconnected";
    btnConnect.style.display = "";
    btnDisconnect.style.display = "none";
    portInput.disabled = false;
  }
  statusCmds.textContent = String(status.commandCount || 0);
  if (status.commandCount > 0) dotCmds.style.background = "#3fb950";
  if (status.port) portInput.value = status.port;
}

// Get initial status from offscreen doc
chrome.runtime.sendMessage({ type: "RELAY_GET_STATUS" }, function (response) {
  if (response) {
    updateUI(response);
    if (response.connected) addLog("Relay is active", "success");
  } else {
    addLog("Offscreen relay not initialized yet", "info");
  }
});

// Listen for live updates from offscreen doc
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg.type === "RELAY_STATUS") updateUI(msg);
  if (msg.type === "RELAY_LOG") addLog(msg.message, msg.logType);
});

btnConnect.addEventListener("click", function () {
  var relayPort = parseInt(portInput.value) || 9333;
  addLog("Connecting to port " + relayPort + "...");

  // Ensure offscreen document exists first
  chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).then(function (contexts) {
    if (contexts.length === 0) {
      addLog("Creating offscreen relay...");
      return chrome.offscreen.createDocument({
        url: "src/relay/offscreen.html",
        reasons: ["WORKERS"],
        justification: "WebSocket relay connection to CLI tools",
      }).then(function () {
        addLog("Offscreen document created", "success");
        return new Promise(function (r) { setTimeout(r, 1000); });
      });
    }
  }).then(function () {
    chrome.runtime.sendMessage({ type: "RELAY_CONNECT", port: relayPort }, function (r) {
      if (r && r.ok) addLog("Connect signal sent", "success");
      else addLog("Waiting for offscreen doc...", "info");
    });
  }).catch(function (e) {
    addLog("Error: " + e.message, "error");
  });
});

btnDisconnect.addEventListener("click", function () {
  addLog("Disconnecting...");
  chrome.runtime.sendMessage({ type: "RELAY_DISCONNECT" }, function (r) {
    if (r && r.ok) addLog("Disconnected", "info");
  });
});

document.getElementById("btn-sidepanel").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs[0] && tabs[0].id) chrome.sidePanel.open({ tabId: tabs[0].id });
  });
});
