// ═══════════════════════════════════════════════════════════════
//  JoyDesc — Electron Main Process (CommonJS)
// ═══════════════════════════════════════════════════════════════

"use strict"

const { app, BrowserWindow, dialog, shell } = require("electron")
const path = require("path")
const http = require("http")

let mainWindow = null

// ── Aguarda o servidor Express subir ──────────────────────────
function aguardarServidor(tentativas) {
  tentativas = tentativas === undefined ? 30 : tentativas
  return new Promise(function(resolve, reject) {
    function tentar(n) {
      var req = http.get("http://localhost:3000", function() { resolve() })
      req.on("error", function() {
        if (n <= 0) return reject(new Error("Servidor não respondeu"))
        setTimeout(function() { tentar(n - 1) }, 500)
      })
    }
    tentar(tentativas)
  })
}

// ── Verifica se Ollama está disponível ─────────────────────────
function checarOllama() {
  return new Promise(function(resolve) {
    var req = http.get("http://localhost:11434", function() { resolve(true) })
    req.on("error", function() { resolve(false) })
  })
}

// ── Cria a janela principal ────────────────────────────────────
function criarJanela() {
  mainWindow = new BrowserWindow({
    width:     1366,
    height:    768,
    minWidth:  900,
    minHeight: 600,
    title: "JoyDesc",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
    autoHideMenuBar: true,
  })

  mainWindow.loadURL("http://localhost:3000")
  mainWindow.once("ready-to-show", function() { mainWindow.show() })
  mainWindow.on("closed", function() { mainWindow = null })

  mainWindow.webContents.setWindowOpenHandler(function(details) {
    shell.openExternal(details.url)
    return { action: "deny" }
  })
}

// ── Inicialização ──────────────────────────────────────────────
app.whenReady().then(function() {
  return Promise.resolve().then(async function() {

    // Banco em AppData — persiste entre atualizações
    process.env.JOY_DB_PATH = path.join(app.getPath("userData"), "joydescription.db")

    // Importa e inicia o servidor Express (ESM via import dinâmico)
    try {
      await import("./server.mjs")
    } catch (e) {
      dialog.showErrorBox("JoyDesc — Erro", "Falha ao iniciar servidor:\n" + e.message)
      app.quit()
      return
    }

    // Aguarda o servidor responder
    try {
      await aguardarServidor()
    } catch (e) {
      dialog.showErrorBox("JoyDesc — Erro", "O servidor não respondeu. Verifique se a porta 3000 está livre.")
      app.quit()
      return
    }

    criarJanela()

    // Avisa sobre Ollama (não bloqueia o startup)
    var ollamaOk = await checarOllama()
    if (!ollamaOk && mainWindow) {
      var result = await dialog.showMessageBox(mainWindow, {
        type:      "warning",
        title:     "Ollama não encontrado",
        message:   "O Ollama não está rodando.\n\nPara usar o modelo local, instale o Ollama e baixe o modelo qwen2.5:14b.\n\nVocê pode usar o Groq normalmente enquanto isso.",
        buttons:   ["Baixar Ollama", "Continuar sem Ollama"],
        defaultId: 1,
      })
      if (result.response === 0) shell.openExternal("https://ollama.ai/download")
    }

    app.on("activate", function() {
      if (BrowserWindow.getAllWindows().length === 0) criarJanela()
    })
  })
})

app.on("window-all-closed", function() {
  if (process.platform !== "darwin") app.quit()
})
