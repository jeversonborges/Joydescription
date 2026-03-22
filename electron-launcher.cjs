// Launcher que remove ELECTRON_RUN_AS_NODE antes de spawnar o Electron
// Necessário porque o VS Code seta essa variável automaticamente
const { spawn } = require("child_process")
const path      = require("path")

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const electronExe = path.join(__dirname, "node_modules", "electron", "dist", "electron.exe")

const child = spawn(electronExe, ["."], {
  env,
  stdio:       "inherit",
  windowsHide: false,
})

child.on("close", (code) => process.exit(code ?? 0))
