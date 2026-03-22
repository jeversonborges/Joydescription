// ═══════════════════════════════════════════════════════════════
//  JoyDescription — Script do Frontend (script.js)
//  Responsável por: autocomplete via API, geração com streaming,
//  renderização do resultado em markdown, copiar e baixar texto
// ═══════════════════════════════════════════════════════════════


// ── Modal de confirmação customizado ───────────────────────────
function confirmar(msg, { titulo = "Confirmar ação", tipo = "perigo", labelOk = "Confirmar", labelCancel = "Cancelar" } = {}) {
  return new Promise(resolve => {
    const overlay  = document.getElementById("modal-confirmar")
    const iconEl   = document.getElementById("confirmar-icon")
    const tituloEl = document.getElementById("confirmar-titulo")
    const msgEl    = document.getElementById("confirmar-msg")
    const okBtn    = document.getElementById("confirmar-ok")
    const cancelBtn= document.getElementById("confirmar-cancel")

    const icones = { perigo: "uil-trash-alt", aviso: "uil-exclamation-triangle", info: "uil-info-circle" }
    iconEl.className = `confirmar-icon ${tipo}`
    iconEl.innerHTML = `<i class="uil ${icones[tipo] || icones.perigo}"></i>`
    okBtn.className  = `confirmar-btn-ok${tipo === "info" ? " azul" : tipo === "aviso" ? " amarelo" : ""}`
    tituloEl.textContent = titulo
    msgEl.innerHTML  = msg.replace(/\n/g, "<br>")
    okBtn.textContent    = labelOk
    cancelBtn.textContent= labelCancel
    overlay.style.display = "flex"

    function fechar(res) {
      overlay.style.display = "none"
      okBtn.removeEventListener("click", onOk)
      cancelBtn.removeEventListener("click", onCancel)
      overlay.removeEventListener("click", onOverlay)
      resolve(res)
    }
    function onOk()      { fechar(true)  }
    function onCancel()  { fechar(false) }
    function onOverlay(e){ if (e.target === overlay) fechar(false) }

    okBtn.addEventListener("click", onOk)
    cancelBtn.addEventListener("click", onCancel)
    overlay.addEventListener("click", onOverlay)
  })
}

// ── Estado global ──────────────────────────────────────────────
let textoGerado        = ""
let textoGen           = ""
let textoDet           = ""
let isGenerating       = false
let areasData          = []
let areaEditando       = null
let cargosData         = []
let cargoEditando      = null
let conhecimentoData   = []
let artigoEditando     = null
let niveisData         = []
let nivelEditando      = null
let abaAtiva           = "descricao"
let usuarioAtual       = null
let empresaAtual       = null
let usuariosData       = []

// ── Referências DOM ────────────────────────────────────────────
const cargoInput  = document.getElementById("cargoInput")
const listaCargos = document.getElementById("listaCargos")
const placeholder = document.getElementById("resultado_placeholder")
const loadingEl   = document.getElementById("loading_state")
const statusDot   = document.getElementById("status_dot")
const cboBadge    = document.getElementById("cbo_badge")
const cboBadgeText= document.getElementById("cbo_badge_text")
const btnGerar    = document.getElementById("btn_gerar")
const selectArea  = document.getElementById("area")

// ── Tipo de atuação ────────────────────────────────────────────
let tipoAtual = "Operacional"

// ── Modo de descrição ──────────────────────────────────────────
let modoAtual = "generica"

function setModo(btn) {
  document.querySelectorAll("[data-modo]").forEach(b => b.classList.remove("active"))
  btn.classList.add("active")
  modoAtual = btn.dataset.modo
}

// ── Provedor de IA ─────────────────────────────────────────────
let provedorAtual = "groq"

const IA_INFO = {
  groq: {
    ico:  "uil-cloud",
    nome: "Groq · llama-3.3-70b",
    desc: "Nuvem · 70B parâmetros · ~500 tok/s"
  },
  together: {
    ico:  "uil-cloud",
    nome: "Together AI · Llama 3.3",
    desc: "Nuvem · fallback automático"
  }
}

function setProvedor(prov, silent = false) {
  provedorAtual = prov
  const info = IA_INFO[prov] || IA_INFO.groq
  document.getElementById("prov-label").textContent   = prov === "together" ? "Together AI" : "Groq"
  document.getElementById("ia-card-ico").className    = `uil ${info.ico}`
  document.getElementById("ia-card-name").textContent = info.nome
  document.getElementById("ia-card-desc").textContent = info.desc
  setIAStatus("ready")
}

function setIAStatus(st) {
  const el  = document.getElementById("ia-card-status")
  const txt = document.getElementById("ia-status-txt")
  const card = document.getElementById("ia-card")
  if (!el) return
  el.className = `ia-card-status st-${st}`
  txt.textContent = st === "ready" ? "pronto" : st === "busy" ? "processando..." : "concluído"
  card.classList.toggle("generating", st === "busy")
}

function setTipo(btn) {
  document.querySelectorAll(".tipo-btn").forEach(b => b.classList.remove("active"))
  btn.classList.add("active")
  tipoAtual = btn.dataset.tipo
}

// ── Tema ───────────────────────────────────────────────────────
function setTheme(tema) {
  document.body.classList.toggle("dark", tema === "dark")
  document.getElementById("btn-light").classList.toggle("active", tema === "light")
  document.getElementById("btn-dark").classList.toggle("active",  tema === "dark")
  localStorage.setItem("joy-theme", tema)
}

// Aplica tema salvo ao carregar
setTheme(localStorage.getItem("joy-theme") || "light")

// ── Carrega áreas do servidor ao iniciar ───────────────────────
async function inicializarAreas() {
  try {
    const res  = await fetch("/areas")
    if (!res.ok) return
    areasData  = await res.json()
    popularSelectArea()
  } catch {
    showToast("Não foi possível carregar as áreas.", "error")
  }
}

function popularSelectArea() {
  const valorAtual = selectArea.value
  selectArea.innerHTML = ""
  areasData.forEach(a => {
    const opt = document.createElement("option")
    opt.value       = a.key
    opt.textContent = a.label
    if (a.key === valorAtual) opt.selected = true
    selectArea.appendChild(opt)
  })
}

// ── Carrega cargos salvos ──────────────────────────────────────
async function inicializarCargos() {
  try {
    const res  = await fetch("/cargos")
    if (!res.ok) return
    cargosData = await res.json()
    atualizarContadorCargos()
  } catch { /* silencioso */ }
}

function atualizarContadorCargos() {
  const el = document.getElementById("cargos-count")
  if (el) el.textContent = cargosData.length
}

// ── Carrega base de conhecimento ───────────────────────────────
async function inicializarConhecimento() {
  try {
    const res        = await fetch("/conhecimento")
    if (!res.ok) return
    conhecimentoData = await res.json()
  } catch { /* silencioso */ }
}

// ── Carrega hierarquia de níveis ───────────────────────────────
async function inicializarNiveis() {
  try {
    const res  = await fetch("/niveis")
    if (!res.ok) return
    niveisData = await res.json()
    popularSelectNivel()
    renderizarListaNiveis()
  } catch { /* silencioso */ }
}

function popularSelectNivel() {
  const selectNivel = document.getElementById("nivel")
  const valorAtual  = selectNivel.value
  selectNivel.innerHTML = ""
  niveisData.forEach(n => {
    const opt = document.createElement("option")
    opt.value       = n.label
    opt.textContent = n.label
    if (n.label === valorAtual) opt.selected = true
    selectNivel.appendChild(opt)
  })
  if (!selectNivel.value && niveisData.length > 0) {
    const pleno = niveisData.find(n => n.label === "Pleno") || niveisData[0]
    if (pleno) selectNivel.value = pleno.label
  }
}

function renderizarListaNiveis() {
  const lista = document.getElementById("niveis-list")
  if (!lista) return
  lista.innerHTML = ""
  niveisData.forEach(n => {
    const li = document.createElement("li")
    li.className = "areas-list-item" + (nivelEditando?.label === n.label ? " active" : "")
    li.onclick = () => selecionarNivel(n)
    li.innerHTML = `
      <span class="ali-label">${n.label}</span>
      <span class="ali-sub">${n.eh_lideranca ? "Liderança" : "Técnico/Operacional"}</span>`
    lista.appendChild(li)
  })
}

function selecionarNivel(n) {
  nivelEditando = n
  document.getElementById("niveis-empty").style.display = "none"
  document.getElementById("niveis-form").style.display  = "flex"
  document.getElementById("niveis-btn-deletar").style.display = ""
  document.getElementById("nivel-label").value      = n.label
  document.getElementById("nivel-ordem").value      = n.ordem
  document.getElementById("nivel-lideranca").checked = n.eh_lideranca === 1
  document.getElementById("nivel-curto").value      = n.descricao_curta
  document.getElementById("nivel-descricao").value  = n.descricao
  renderizarListaNiveis()
}

function novoNivel() {
  nivelEditando = null
  document.getElementById("niveis-empty").style.display = "none"
  document.getElementById("niveis-form").style.display  = "flex"
  document.getElementById("niveis-btn-deletar").style.display = "none"
  document.getElementById("nivel-label").value      = ""
  document.getElementById("nivel-ordem").value      = (niveisData.length + 1)
  document.getElementById("nivel-lideranca").checked = false
  document.getElementById("nivel-curto").value      = ""
  document.getElementById("nivel-descricao").value  = ""
  document.getElementById("nivel-label").focus()
  renderizarListaNiveis()
}

async function salvarNivel() {
  const label         = document.getElementById("nivel-label").value.trim()
  const ordem         = parseInt(document.getElementById("nivel-ordem").value) || 0
  const eh_lideranca  = document.getElementById("nivel-lideranca").checked ? 1 : 0
  const descricao     = document.getElementById("nivel-descricao").value.trim()
  const descricao_curta = document.getElementById("nivel-curto").value.trim()

  if (!label) return showToast("Informe o nome do nível.", "error")

  const body    = { label, ordem, eh_lideranca, descricao, descricao_curta }
  const isNovo  = !nivelEditando
  const url     = isNovo ? "/niveis" : `/niveis/${encodeURIComponent(nivelEditando.label)}`
  const method  = isNovo ? "POST" : "PUT"

  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    if (!res.ok) { const e = await res.json(); return showToast(e.erro || "Erro ao salvar.", "error") }
    showToast(isNovo ? "Nível criado!" : "Nível atualizado!", "success")
    await inicializarNiveis()
    const updated = niveisData.find(n => n.label === label)
    if (updated) selecionarNivel(updated)
  } catch { showToast("Erro ao salvar nível.", "error") }
}

async function deletarNivel() {
  if (!nivelEditando) return
  if (!await confirmar(`Deletar o nível <strong>${nivelEditando.label}</strong>?`, { titulo: "Deletar nível" })) return
  try {
    const res = await fetch(`/niveis/${encodeURIComponent(nivelEditando.label)}`, { method: "DELETE" })
    if (!res.ok) { const e = await res.json(); return showToast(e.erro || "Erro ao deletar.", "error") }
    showToast("Nível deletado.", "success")
    nivelEditando = null
    document.getElementById("niveis-empty").style.display = ""
    document.getElementById("niveis-form").style.display  = "none"
    await inicializarNiveis()
  } catch { showToast("Erro ao deletar nível.", "error") }
}

function cancelarNivel() {
  nivelEditando = null
  document.getElementById("niveis-empty").style.display = ""
  document.getElementById("niveis-form").style.display  = "none"
  renderizarListaNiveis()
}

// ═══════════════════════════════════════════════════════════════
//  AUTENTICAÇÃO
// ═══════════════════════════════════════════════════════════════

function mostrarLogin() {
  document.getElementById("login-overlay").style.display = "flex"
  document.getElementById("app-content").style.display   = "none"
}

async function esconderLogin() {
  const loginEl = document.getElementById("login-overlay")
  const splash  = document.getElementById("splash")

  if (splash) {
    // Ainda no contexto do splash: fade out ambos juntos
    loginEl.style.transition = "opacity 0.6s ease"
    splash.style.transition  = "opacity 0.6s ease"
    loginEl.style.opacity    = "0"
    splash.style.opacity     = "0"
    await new Promise(r => setTimeout(r, 650))
    splash.remove()
    loginEl.style.display    = "none"
    loginEl.style.opacity    = ""
    loginEl.style.background = ""
    loginEl.style.transition = ""
  } else {
    loginEl.style.display = "none"
  }
  document.getElementById("app-content").style.display = ""
}

async function verificarAuth() {
  try {
    const r = await fetch("/auth/me")
    if (!r.ok) { mostrarLogin(); return }
    const { user, empresa } = await r.json()
    usuarioAtual = user
    empresaAtual = empresa
    esconderLogin()
    atualizarBarraTitulo()
    await inicializarApp()
  } catch { mostrarLogin() }
}

function atualizarBarraTitulo() {
  const el = document.getElementById("user-info-bar")
  if (!el || !usuarioAtual) return
  document.getElementById("tb-empresa-nome").textContent = empresaAtual?.nome || ""
  document.getElementById("tb-usuario-nome").textContent = usuarioAtual.nome || ""
  el.style.display = "flex"
  // Mostrar aba usuários apenas para admin
  const isAdmin = usuarioAtual.papel === "admin"
  const tabUsuarios = document.getElementById("tab-usuarios")
  if (tabUsuarios) tabUsuarios.style.display = isAdmin ? "" : "none"
  const tabBackup = document.getElementById("tab-backup")
  if (tabBackup) tabBackup.style.display = isAdmin ? "" : "none"
  const tabSeg = document.getElementById("tab-seguranca")
  if (tabSeg) tabSeg.style.display = isAdmin ? "" : "none"
  const menuBackup = document.getElementById("menu-backup-item")
  if (menuBackup) menuBackup.style.display = isAdmin ? "" : "none"
  const menuSeg = document.getElementById("menu-seguranca-item")
  if (menuSeg) menuSeg.style.display = isAdmin ? "" : "none"
  const menuAudit = document.getElementById("menu-auditoria-item")
  if (menuAudit) menuAudit.style.display = isAdmin ? "" : "none"
}

async function inicializarApp() {
  await Promise.all([
    inicializarAreas(),
    inicializarCargos(),
    inicializarConhecimento(),
    inicializarNiveis()
  ])
}

function trocarAbaLogin(aba) {
  document.getElementById("login-tab-entrar").classList.toggle("active", aba === "entrar")
  document.getElementById("login-tab-criar").classList.toggle("active", aba === "criar")
  document.getElementById("login-form-entrar").style.display = aba === "entrar" ? "flex" : "none"
  document.getElementById("login-form-criar").style.display  = aba === "criar"  ? "flex" : "none"
  document.getElementById("login-erro").textContent = ""
}

async function fazerLogin() {
  const email = document.getElementById("login-email").value.trim()
  const senha = document.getElementById("login-senha").value
  const erroEl = document.getElementById("login-erro")
  erroEl.textContent = ""

  if (!email || !senha) { erroEl.textContent = "Preencha e-mail e senha."; return }

  const btn = document.getElementById("login-btn-entrar")
  btn.disabled = true
  btn.textContent = "Entrando..."

  try {
    const res  = await fetch("/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, senha })
    })
    const data = await res.json()
    if (!res.ok) { erroEl.textContent = data.erro || "Erro ao entrar."; return }

    usuarioAtual = data.user
    empresaAtual = data.empresa
    esconderLogin()
    atualizarBarraTitulo()
    await inicializarApp()
    showToast(`Bem-vindo, ${data.user.nome}!`, "success")
  } catch { erroEl.textContent = "Falha de conexão. Tente novamente." }
  finally { btn.disabled = false; btn.textContent = "Entrar" }
}

async function fazerRegistro() {
  const empresa = document.getElementById("reg-empresa").value.trim()
  const nome    = document.getElementById("reg-nome").value.trim()
  const email   = document.getElementById("reg-email").value.trim()
  const senha   = document.getElementById("reg-senha").value
  const senha2  = document.getElementById("reg-senha2").value
  const erroEl  = document.getElementById("login-erro")
  erroEl.textContent = ""

  if (!empresa || !nome || !email || !senha) { erroEl.textContent = "Preencha todos os campos."; return }
  if (senha.length < 8) { erroEl.textContent = "A senha deve ter ao menos 8 caracteres."; return }
  if (senha !== senha2) { erroEl.textContent = "As senhas não coincidem."; return }

  const btn = document.getElementById("reg-btn-criar")
  btn.disabled = true
  btn.textContent = "Criando conta..."

  try {
    const res  = await fetch("/auth/registrar", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ empresa, nome, email, senha })
    })
    const data = await res.json()
    if (!res.ok) { erroEl.textContent = data.erro || "Erro ao criar conta."; return }

    usuarioAtual = data.user
    empresaAtual = data.empresa
    esconderLogin()
    atualizarBarraTitulo()
    await inicializarApp()
    showToast(`Conta criada! Bem-vindo, ${data.user.nome}!`, "success")
  } catch { erroEl.textContent = "Falha de conexão. Tente novamente." }
  finally { btn.disabled = false; btn.textContent = "Criar conta" }
}

async function fazerLogout() {
  try { await fetch("/auth/logout", { method: "POST" }) } catch { /* silencioso */ }
  usuarioAtual = null
  empresaAtual = null
  areasData = []; cargosData = []; conhecimentoData = []; niveisData = []
  mostrarLogin()
}

// ── Atalho: Enter nos campos de login/registro ─────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    const overlay = document.getElementById("login-overlay")
    if (!overlay || overlay.style.display === "none") return
    const formEntrar = document.getElementById("login-form-entrar")
    const formCriar  = document.getElementById("login-form-criar")
    if (formEntrar && formEntrar.style.display !== "none") fazerLogin()
    else if (formCriar && formCriar.style.display !== "none") fazerRegistro()
  }
})

// ═══════════════════════════════════════════════════════════════
//  GERENCIAMENTO DE USUÁRIOS (admin only)
// ═══════════════════════════════════════════════════════════════

async function carregarUsuarios() {
  try {
    const res = await fetch("/usuarios")
    if (!res.ok) return
    usuariosData = await res.json()
    renderizarUsuarios()
  } catch { showToast("Erro ao carregar usuários.", "error") }
}

function renderizarUsuarios() {
  const lista = document.getElementById("usuarios-list")
  if (!lista) return
  lista.innerHTML = ""
  if (!usuariosData.length) {
    lista.innerHTML = `<li style="pointer-events:none;opacity:0.5;padding:12px 14px">Nenhum usuário cadastrado</li>`
    return
  }
  usuariosData.forEach(u => {
    const li = document.createElement("li")
    li.className = "areas-list-item"
    const ativo  = u.ativo ? "" : ' <span style="color:var(--error);font-size:10px">(inativo)</span>'
    const papelBadge = u.papel === "admin"
      ? `<span style="font-size:10px;background:var(--accent-dim);color:var(--accent);padding:1px 6px;border-radius:4px">admin</span>`
      : `<span style="font-size:10px;background:var(--bg-hover);color:var(--text-muted);padding:1px 6px;border-radius:4px">membro</span>`
    li.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex:1">
        <div>
          <div style="font-size:12px;font-weight:600">${u.nome}${ativo} ${papelBadge}</div>
          <div style="font-size:11px;color:var(--text-muted)">${u.email}</div>
        </div>
      </div>
      <div style="display:flex;gap:4px">
        ${u.id !== usuarioAtual?.id ? `
          <button class="btn-salvar-area" style="padding:3px 8px;font-size:11px" onclick="alternarPapel('${u.id}','${u.papel}')">
            ${u.papel === "admin" ? "Tornar membro" : "Tornar admin"}
          </button>
          ${u.ativo ? `<button class="btn-deletar-area" style="padding:3px 8px;font-size:11px" onclick="desativarUsuario('${u.id}')">Desativar</button>` : ""}
          <button class="btn-deletar-area" style="padding:3px 8px;font-size:11px;opacity:0.6" onclick="excluirUsuario('${u.id}','${u.nome}')"><i class="uil uil-trash-alt"></i></button>
        ` : `<span style="font-size:11px;color:var(--text-sub)">(você)</span>`}
      </div>`
    lista.appendChild(li)
  })
}

async function criarUsuario() {
  const nome  = document.getElementById("novo-usuario-nome").value.trim()
  const email = document.getElementById("novo-usuario-email").value.trim()
  const senha = document.getElementById("novo-usuario-senha").value
  const papel = document.getElementById("novo-usuario-papel").value

  if (!nome || !email || !senha) { showToast("Preencha todos os campos.", "error"); return }
  if (senha.length < 8) { showToast("Senha mínima: 8 caracteres.", "error"); return }

  try {
    const res = await fetch("/usuarios", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ nome, email, senha, papel })
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.erro || "Erro ao criar usuário.", "error"); return }
    showToast("Usuário criado com sucesso!", "success")
    document.getElementById("novo-usuario-nome").value  = ""
    document.getElementById("novo-usuario-email").value = ""
    document.getElementById("novo-usuario-senha").value = ""
    await carregarUsuarios()
  } catch { showToast("Erro ao criar usuário.", "error") }
}

async function alternarPapel(id, papelAtual) {
  const novoPapel = papelAtual === "admin" ? "membro" : "admin"
  try {
    const res = await fetch(`/usuarios/${id}`, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ papel: novoPapel })
    })
    if (!res.ok) { const d = await res.json(); showToast(d.erro || "Erro.", "error"); return }
    showToast("Papel atualizado.", "success")
    await carregarUsuarios()
  } catch { showToast("Erro ao atualizar papel.", "error") }
}

async function desativarUsuario(id) {
  if (!await confirmar("Ele não conseguirá mais fazer login.", { titulo: "Desativar usuário?", tipo: "aviso", labelOk: "Desativar" })) return
  try {
    const res = await fetch(`/usuarios/${id}`, { method: "DELETE" })
    if (!res.ok) { const d = await res.json(); showToast(d.erro || "Erro.", "error"); return }
    showToast("Usuário desativado.", "info")
    await carregarUsuarios()
  } catch { showToast("Erro ao desativar usuário.", "error") }
}

async function excluirUsuario(id, nome) {
  if (!await confirmar(`Excluir <strong>${nome}</strong> permanentemente?\nEsta ação não pode ser desfeita.`, { titulo: "Excluir usuário", labelOk: "Excluir" })) return
  try {
    const res = await fetch(`/usuarios/${id}/excluir`, { method: "DELETE" })
    if (!res.ok) { const d = await res.json(); showToast(d.erro || "Erro.", "error"); return }
    showToast("Usuário excluído.", "info")
    await carregarUsuarios()
  } catch { showToast("Erro ao excluir usuário.", "error") }
}

async function abrirBackup() {
  document.getElementById("modal-backup").style.display = "flex"
  await Promise.all([carregarStatusBackup(), carregarHistoricoBackup(), carregarConfigBackup()])
}

async function carregarConfigBackup() {
  try {
    const res = await fetch("/backup/config")
    if (!res.ok) return
    const d = await res.json()
    const toggle = document.getElementById("bk-auto-toggle")
    const label  = document.getElementById("bk-auto-label")
    const sel    = document.getElementById("bk-auto-horas")
    const intDiv = document.getElementById("bk-auto-interval")
    const status = document.getElementById("bk-auto-status")
    toggle.checked = !!d.ativo
    label.textContent = d.ativo ? "Ativado" : "Desativado"
    intDiv.style.display = d.ativo ? "flex" : "none"
    if (d.intervalo_horas) sel.value = String(d.intervalo_horas)
    if (d.proximo_em) {
      const dt = new Date(d.proximo_em).toLocaleString("pt-BR")
      status.textContent = `Próximo backup automático: ${dt}`
    } else if (d.ativo) {
      status.textContent = "Aguardando o primeiro ciclo..."
    } else {
      status.textContent = ""
    }
  } catch {}
}

async function salvarConfigBackup() {
  const toggle = document.getElementById("bk-auto-toggle")
  const label  = document.getElementById("bk-auto-label")
  const sel    = document.getElementById("bk-auto-horas")
  const intDiv = document.getElementById("bk-auto-interval")
  const status = document.getElementById("bk-auto-status")
  const ativo  = toggle.checked
  label.textContent = ativo ? "Ativado" : "Desativado"
  intDiv.style.display = ativo ? "flex" : "none"
  if (!ativo) status.textContent = ""
  try {
    const res = await fetch("/backup/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ativo, intervalo_horas: parseInt(sel.value) })
    })
    if (!res.ok) { showToast("Erro ao salvar configuração.", "error"); return }
    const d = await res.json()
    if (ativo && d.proximo_em) {
      const dt = new Date(d.proximo_em).toLocaleString("pt-BR")
      status.textContent = `Próximo backup automático: ${dt}`
    }
    showToast(ativo ? "Backup automático ativado." : "Backup automático desativado.", "success")
  } catch { showToast("Erro ao salvar configuração.", "error") }
}

function fecharModalBackup(e) {
  if (e && e.target !== document.getElementById("modal-backup")) return
  document.getElementById("modal-backup").style.display = "none"
}

// ── Auditoria ──────────────────────────────────────────────────
let audPagina = 0
const AUD_LIMIT = 50

const audAcaoCor = {
  "auth":        "auth",
  "cargo":       "cargo",
  "area":        "area",
  "conhecimento":"conhec",
  "nivel":       "nivel",
  "usuario":     "usuario",
  "backup":      "backup",
}

const audAcaoLabel = {
  "auth.login":          "Login",
  "auth.login_falhou":   "Login falhou",
  "auth.logout":         "Logout",
  "cargo.criar":         "Cargo criado",
  "cargo.editar":        "Cargo editado",
  "cargo.deletar":       "Cargo deletado",
  "area.criar":          "Área criada",
  "area.editar":         "Área editada",
  "area.deletar":        "Área deletada",
  "conhecimento.criar":  "Conhec. criado",
  "conhecimento.editar": "Conhec. editado",
  "conhecimento.deletar":"Conhec. deletado",
  "nivel.criar":         "Nível criado",
  "nivel.editar":        "Nível editado",
  "nivel.deletar":       "Nível deletado",
  "usuario.criar":       "Usuário criado",
  "usuario.editar":      "Usuário editado",
  "usuario.desativar":   "Usuário desativado",
  "usuario.excluir":     "Usuário excluído",
  "backup.download":     "Backup baixado",
  "backup.restaurar":    "Backup restaurado",
  "backup.config":       "Config. backup",
}

function audCorBadge(acao) {
  for (const [k,v] of Object.entries(audAcaoCor)) {
    if (acao.startsWith(k)) return v
  }
  return "backup"
}

async function abrirAuditoria() {
  document.getElementById("modal-auditoria").style.display = "flex"
  audPagina = 0
  await carregarAuditoria()
}

function fecharModalAuditoria(e) {
  if (e && e.target !== document.getElementById("modal-auditoria")) return
  document.getElementById("modal-auditoria").style.display = "none"
}

async function carregarAuditoria() {
  const usuario = document.getElementById("aud-busca-usuario").value.trim()
  const acao    = document.getElementById("aud-busca-acao").value
  const params  = new URLSearchParams({ limit: AUD_LIMIT, offset: audPagina * AUD_LIMIT })
  if (usuario) params.set("usuario", usuario)
  if (acao)    params.set("acao", acao)
  try {
    const res = await fetch(`/auditoria?${params}`)
    if (!res.ok) return
    const { rows, total } = await res.json()
    renderAuditoria(rows, total)
  } catch {}
}

function renderAuditoria(rows, total) {
  const tbody = document.getElementById("aud-tbody")
  const totalEl = document.getElementById("aud-total")
  const pgInfo  = document.getElementById("aud-pg-info")
  const pgAnt   = document.getElementById("aud-pg-ant")
  const pgProx  = document.getElementById("aud-pg-prox")

  totalEl.textContent = `${total} registro${total !== 1 ? "s" : ""}`

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="aud-vazio">Nenhum registro encontrado.</td></tr>'
    pgInfo.textContent = ""
    pgAnt.disabled = true
    pgProx.disabled = true
    return
  }

  tbody.innerHTML = rows.map(r => {
    const dt   = new Date(r.criado_em).toLocaleString("pt-BR")
    const label = audAcaoLabel[r.acao] || r.acao
    const cor   = audCorBadge(r.acao)
    const isErro = r.acao.includes("falhou") || r.acao.includes("erro")
    return `<tr>
      <td class="aud-data">${dt}</td>
      <td>${r.usuario_nome || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td><span class="aud-badge ${isErro ? "erro" : cor}">${label}</span></td>
      <td><div class="aud-alvo" title="${r.alvo || ""}">${r.alvo || '<span style="color:var(--text-muted)">—</span>'}</div></td>
      <td class="aud-ip">${r.ip || "—"}</td>
    </tr>`
  }).join("")

  const inicio = audPagina * AUD_LIMIT + 1
  const fim    = Math.min(inicio + rows.length - 1, total)
  pgInfo.textContent = `${inicio}–${fim} de ${total}`
  pgAnt.disabled  = audPagina === 0
  pgProx.disabled = fim >= total
}

function filtrarAuditoria() {
  audPagina = 0
  carregarAuditoria()
}

async function paginaAuditoria(dir) {
  audPagina = Math.max(0, audPagina + dir)
  await carregarAuditoria()
}

function exportarAuditoria() {
  window.location.href = "/auditoria/exportar"
}

async function abrirSeguranca() {
  document.getElementById("modal-seguranca").style.display = "flex"
  await abrirSegurancaData()
}

function fecharModalSeguranca(e) {
  if (e && e.target !== document.getElementById("modal-seguranca")) return
  document.getElementById("modal-seguranca").style.display = "none"
}

async function abrirSegurancaData() {
  try {
    const [resStatus, resCfg] = await Promise.all([
      fetch("/backup/status"),
      fetch("/backup/config")
    ])
    if (!resStatus.ok) return
    const d   = await resStatus.json()
    const cfg = resCfg.ok ? await resCfg.json() : { ativo: false }

    // Último backup
    const el = document.getElementById("sec-ultimo-backup")
    if (el) {
      if (d.ultimoBackup) {
        const dt = new Date(d.ultimoBackup.criado_em).toLocaleString("pt-BR")
        el.textContent = `Último backup realizado em ${dt} por ${d.ultimoBackup.usuario_nome}. Recomendado: semanal.`
        el.style.color = ""
      } else {
        el.textContent = "Nenhum backup realizado ainda. Acesse o menu Backup e faça o primeiro agora."
        el.style.color = "var(--error)"
      }
    }

    // Item backup automático
    const itemEl  = document.getElementById("sec-item-backup-auto")
    const descEl  = document.getElementById("sec-desc-backup-auto")
    const badgeEl = document.getElementById("sec-badge-backup-auto")
    if (itemEl && descEl && badgeEl) {
      if (cfg.ativo) {
        itemEl.className  = "sec-item sec-ok"
        badgeEl.className = "sec-badge sec-badge-ok"
        badgeEl.textContent = "Ativo"
        const prox = cfg.proximo_em ? new Date(cfg.proximo_em).toLocaleString("pt-BR") : "—"
        descEl.textContent = `Backup automático a cada ${cfg.intervalo_horas}h. Próximo: ${prox}.`
      } else {
        itemEl.className  = "sec-item sec-warn"
        badgeEl.className = "sec-badge sec-badge-warn"
        badgeEl.textContent = "Manual"
        descEl.textContent = "Não configurado. Faça backup manual regularmente para evitar perda de dados."
      }
    }

    // Score dinâmico
    const scoreEl = document.getElementById("sec-score-num")
    const subEl   = document.getElementById("sec-score-sub")
    const tipEl   = document.getElementById("sec-score-tip")
    if (scoreEl) {
      if (cfg.ativo) {
        scoreEl.innerHTML = '100<span>%</span>'
        if (subEl) subEl.textContent = "11 de 11 proteções ativas"
        if (tipEl) tipEl.style.display = "none"
        const ring = document.querySelector("#modal-seguranca .sec-score-ring circle:last-child")
        if (ring) ring.setAttribute("stroke-dashoffset", "0")
      } else {
        scoreEl.innerHTML = '90<span>%</span>'
        if (subEl) subEl.textContent = "10 de 11 proteções ativas"
        if (tipEl) { tipEl.style.display = ""; tipEl.innerHTML = '<i class="uil uil-info-circle"></i> Backup automático elevaria para 100%' }
        const ring = document.querySelector("#modal-seguranca .sec-score-ring circle:last-child")
        if (ring) ring.setAttribute("stroke-dashoffset", "26")
      }
    }
  } catch {}
}

async function carregarStatusBackup() {
  try {
    const res = await fetch("/backup/status")
    if (!res.ok) return
    const d = await res.json()
    const kb = (d.tamanho / 1024).toFixed(0)
    const mb = d.tamanho >= 1048576 ? ` (${(d.tamanho/1048576).toFixed(1)} MB)` : ""
    document.getElementById("bk-tamanho").textContent  = kb + " KB" + mb
    document.getElementById("bk-cargos").textContent   = d.cargos
    document.getElementById("bk-areas").textContent    = d.areas
    document.getElementById("bk-conhec").textContent   = d.conhec
    document.getElementById("bk-versoes").textContent  = d.versoes
    document.getElementById("bk-usuarios").textContent = d.usuarios
    const ub = document.getElementById("bk-ultimo-backup")
    if (d.ultimoBackup) {
      const dt = new Date(d.ultimoBackup.criado_em).toLocaleString("pt-BR")
      ub.textContent = `Último backup: ${dt} por ${d.ultimoBackup.usuario_nome}`
      ub.style.color = "var(--accent)"
    } else {
      ub.textContent = "Nenhum backup realizado ainda."
      ub.style.color = "var(--error)"
    }
  } catch {}
}

async function carregarHistoricoBackup() {
  try {
    const res = await fetch("/backup/historico")
    if (!res.ok) return
    const rows = await res.json()
    const ul = document.getElementById("bk-historico")
    if (!rows.length) { ul.innerHTML = '<li class="bk-historico-vazio">Nenhum backup realizado ainda.</li>'; return }
    ul.innerHTML = rows.map(r => {
      const dt = new Date(r.criado_em).toLocaleString("pt-BR")
      const kb = (r.tamanho_bytes / 1024).toFixed(0)
      return `<li class="bk-historico-item">
        <div class="bk-hist-info">
          <span class="bk-hist-data">${dt}</span>
          <span class="bk-hist-user">${r.usuario_nome} — ${r.tamanho_bytes ? kb + " KB" : "?"}</span>
        </div>
        <i class="uil uil-check-circle" style="color:var(--accent);flex-shrink:0"></i>
      </li>`
    }).join("")
  } catch {}
}

function baixarBackup() {
  window.location.href = "/backup/download"
  setTimeout(() => Promise.all([carregarStatusBackup(), carregarHistoricoBackup()]), 2000)
}

async function restaurarBackup(input) {
  const file = input.files[0]
  if (!file) return
  if (!await confirmar(`Restaurar <strong>${file.name}</strong>?\n\nTodos os dados inseridos após esse backup serão perdidos. O sistema vai reiniciar automaticamente.`, { titulo: "Restaurar backup", tipo: "aviso", labelOk: "Restaurar" })) {
    input.value = ""; return
  }
  try {
    showToast("Enviando e restaurando...", "info")
    const buf = await file.arrayBuffer()
    const res = await fetch("/backup/restaurar", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.erro || "Erro ao restaurar.", "error"); return }
    showToast("Restaurado com sucesso! Reconectando em 5s...", "success")
    setTimeout(() => location.reload(), 5000)
  } catch { showToast("Erro ao enviar o arquivo.", "error") }
  input.value = ""
}

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════

// debounce — evita chamadas excessivas enquanto o usuário digita
function debounce(fn, delay) {
  let timer
  return function(...args) {
    clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), delay)
  }
}

// showToast — exibe uma notificação temporária no canto da tela
function showToast(msg, tipo = "info") {
  const el = document.getElementById("toast")
  el.textContent = msg
  el.className   = `toast ${tipo} show`
  setTimeout(() => { el.className = "toast" }, 3000)
}

// setStatus — atualiza o indicador de ponto colorido no header do resultado
function setStatus(estado) {
  statusDot.className = `status_dot ${estado}`
}


// ═══════════════════════════════════════════════════════════════
//  AUTOCOMPLETE — sugestões de cargo via endpoint /sugestoes
//  Consulta o servidor (que tem a CBO em memória) em vez de
//  carregar o CSV inteiro no navegador — muito mais eficiente
// ═══════════════════════════════════════════════════════════════

const buscarSugestoes = debounce(async function() {
  const valor = cargoInput.value.trim()

  listaCargos.innerHTML = ""

  if (valor.length < 2) {
    listaCargos.style.display = "none"
    return
  }

  try {
    const res  = await fetch(`/sugestoes?q=${encodeURIComponent(valor)}`)
    const data = await res.json()

    if (!data.length) {
      listaCargos.style.display = "none"
      return
    }

    // Cria um <li> para cada sugestão retornada pela API
    data.forEach(item => {
      const li = document.createElement("li")
      li.innerHTML = `
        <span class="item_codigo">${item.codigo}</span>
        <span>${item.cargo}</span>
      `
      li.addEventListener("click", () => {
        cargoInput.value          = item.cargo
        listaCargos.style.display = "none"
      })
      listaCargos.appendChild(li)
    })

    listaCargos.style.display = "block"

  } catch {
    listaCargos.style.display = "none"
  }
}, 220)

cargoInput.addEventListener("input", buscarSugestoes)

// Fecha o dropdown ao clicar fora do campo de cargo
document.addEventListener("click", e => {
  if (!e.target.closest(".autocomplete_wrapper")) {
    listaCargos.style.display = "none"
  }
})


// ═══════════════════════════════════════════════════════════════
//  RENDERIZADOR MARKDOWN SIMPLES
//  Converte a resposta estruturada do modelo em HTML legível.
//  Executado somente após o streaming terminar — não durante.
// ═══════════════════════════════════════════════════════════════

// Títulos dos três blocos que a IA gera
const BLOCOS_TITULOS = [
  "DESCRICAO DO CARGO",
  "FUNCOES, TAREFAS E RESPONSABILIDADES",
  "INDICACAO DE CBOs"
]

// Cabeçalhos de seção gerados pelo modelo — removidos do output visual
const CABECALHOS_SECAO = [
  /^DESCRICAO DO CARGO\s*$/i,
  /^FUNCOES,?\s*TAREFAS\s*(E\s*RESPONSABILIDADES)?\s*$/i,
  /^FUNCOES\s*$/i,
  /^INDICACAO\s*(DE\s*)?CBOS?\s*$/i,
  /^MISSAO\s*(DO\s*CARGO)?\s*$/i,
  /^ATRIBUICOES\s*$/i,
  /^COMPETENCIAS\s*TECNICAS\s*$/i,
  /^COMPETENCIAS\s*COMPORTAMENTAIS\s*$/i,
  /^REQUISITOS\s*(MINIMOS)?\s*$/i,
  /^CBO\s*$/i,
  // Linhas tipo "Label: valor" — metadados que o modelo não deveria gerar
  /^(Nome|Cargo|Título|Titulo|Área|Area|Setor|Nível|Nivel|Tipo|Departamento|Empresa|Data|Versão|Versao|Autor|Referência|Referencia)\s*:/i,
]

function renderMarkdown(texto) {
  // 1. Escapa HTML
  let t = texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

  // 2. Remove asteriscos de negrito/itálico que o modelo ainda insere
  t = t.replace(/\*\*(.+?)\*\*/g, "$1")
  t = t.replace(/\*(.+?)\*/g, "$1")

  // 3. Processa linha a linha
  const linhas  = t.split("\n")
  const saida   = []
  let listAberta = false

  linhas.forEach(linha => {
    const trim = linha.trim()

    // Remove cabeçalhos de seção do modelo (não exibir ao usuário)
    if (CABECALHOS_SECAO.some(r => r.test(trim))) {
      if (listAberta) { saida.push("</ul>"); listAberta = false }
      return
    }

    // Título de bloco (ALL CAPS reconhecidos)
    if (BLOCOS_TITULOS.some(b => trim.toUpperCase() === b.toUpperCase()) || /^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s,]{8,}$/.test(trim) && trim.length < 60) {
      if (listAberta) { saida.push("</ul>"); listAberta = false }
      saida.push(`<div class="bloco-titulo">${trim}</div>`)
      return
    }

    // Item de lista: linha que começa com - ou •
    if (/^[-•]\s+/.test(trim)) {
      if (!listAberta) { saida.push('<ul class="desc-list">'); listAberta = true }
      saida.push(`<li>${trim.replace(/^[-•]\s+/, "")}</li>`)
      return
    }

    // Linha de CBO: "1234-56 – Nome – Justificativa" ou "1234-56 - Nome - ..."
    if (/^\d{4}-\d{2}/.test(trim) || /^\d{4}/.test(trim)) {
      if (listAberta) { saida.push("</ul>"); listAberta = false }
      const partes = trim.split(/\s*[–-]\s*/)
      if (partes.length >= 3) {
        saida.push(`<div class="cbo-linha"><span class="cbo-cod">${partes[0].trim()}</span><span class="cbo-nome">${partes[1].trim()}</span><span class="cbo-just">${partes.slice(2).join(" – ")}</span></div>`)
      } else {
        saida.push(`<div class="cbo-linha">${trim}</div>`)
      }
      return
    }

    // Linha em branco
    if (!trim) {
      if (listAberta) { saida.push("</ul>"); listAberta = false }
      saida.push('<div class="desc-gap"></div>')
      return
    }

    // Parágrafo normal
    if (listAberta) { saida.push("</ul>"); listAberta = false }
    saida.push(`<p class="desc-p">${trim}</p>`)
  })

  if (listAberta) saida.push("</ul>")
  return saida.join("")
}


// ═══════════════════════════════════════════════════════════════
//  GERAR DESCRIÇÃO — chamada principal com streaming SSE via POST
//
//  Fluxo:
//  1. Valida o formulário
//  2. Envia POST para /gerar
//  3. Lê a resposta como ReadableStream (SSE)
//  4. Exibe cada fragmento de texto em tempo real
//  5. Ao finalizar, renderiza o markdown completo
// ═══════════════════════════════════════════════════════════════

async function gerarDescricao() {
  if (isGenerating) return

  const cargo = cargoInput.value.trim()
  const area  = document.getElementById("area").value
  const nivel = document.getElementById("nivel").value

  if (!cargo) {
    showToast("Digite o nome do cargo primeiro.", "error")
    cargoInput.focus()
    return
  }

  // ── Prepara a tela ───────────────────────────────────────────
  isGenerating = true
  document.getElementById("dots-anim").classList.add("generating")
  setIAStatus("busy")
  textoGerado = textoGen = textoDet = ""
  analiseAtual = null
  document.getElementById("analise-badge").style.display = "none"
  btnGerar.disabled = true
  cboBadge.style.display = "none"
  loadingEl.style.display = "flex"
  listaCargos.style.display = "none"
  placeholder.style.display = "none"
  document.getElementById("resultado-wrap").style.display = "none"
  document.getElementById("resultado-gen").textContent = ""
  document.getElementById("resultado-det").textContent = ""
  secaoVisivelAtual = "gen"
  document.getElementById("resultado-gen").style.display = "block"
  document.getElementById("resultado-det").style.display = "none"
  document.getElementById("res-tab-gen").classList.add("active")
  document.getElementById("res-tab-det").classList.remove("active")
  setStatus("loading")

  let secaoAtual = "gen"
  const elGen = document.getElementById("resultado-gen")
  const elDet = document.getElementById("resultado-det")

  try {
    const response = await fetch("/gerar", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ cargo, area, nivel, tipo: tipoAtual, provedor: provedorAtual })
    })

    if (!response.ok) throw new Error(`Servidor retornou ${response.status}`)

    const reader  = response.body.getReader()
    const decoder = new TextDecoder()
    let   buffer  = ""
    let   primeiroToken = true

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const linhas = buffer.split("\n")
      buffer = linhas.pop()

      for (const linha of linhas) {
        if (!linha.startsWith("data: ")) continue
        let data
        try { data = JSON.parse(linha.slice(6)) } catch { continue }

        if (data.tipo === "secao") {
          secaoAtual = data.nome === "detalhada" ? "det" : "gen"
          if (secaoAtual === "det") {
            elGen.innerHTML = renderMarkdown(textoGen)
            elGen.className = "resultado_content res-content"
          }
          continue
        }

        if (data.tipo === "pensando") continue

        if (data.tipo === "failover") {
          setProvedor(data.para, true)
          showToast("Groq indisponível — usando Together AI como fallback", "info")
          continue
        }

        if (data.texto) {
          if (primeiroToken) {
            loadingEl.style.display = "none"
            document.getElementById("resultado-wrap").style.display = "flex"
            setStatus("streaming")
            primeiroToken = false
          }
          if (secaoAtual === "gen") {
            textoGen += data.texto
            elGen.textContent = textoGen
            elGen.scrollTop   = elGen.scrollHeight
          } else {
            textoDet += data.texto
            elDet.textContent = textoDet
            elDet.scrollTop   = elDet.scrollHeight
          }
        }

        if (data.erro) throw new Error(data.erro)

        if (data.fim) {
          elGen.innerHTML = renderMarkdown(textoGen)
          elGen.className = "resultado_content res-content"
          elDet.innerHTML = renderMarkdown(textoDet)
          elDet.className = "resultado_content res-content"
          textoGerado = textoGen
          setStatus("done")
          setIAStatus("done")
          showToast("Descrições geradas com sucesso!", "success")
          autoSalvarCargo(cargo, area, nivel, textoGen + "\n\n---\n\n" + textoDet)
          analisarJuridico(cargo, nivel, textoGen + "\n\n" + textoDet, provedorAtual)
        }
      }
    }

  } catch (err) {
    console.error("Erro:", err)
    setStatus("error")
    loadingEl.style.display = "none"
    document.getElementById("resultado-wrap").style.display = "flex"
    elGen.textContent = `Erro: ${err.message}`
    showToast("Erro ao gerar descrição.", "error")

  } finally {
    isGenerating      = false
    document.getElementById("dots-anim").classList.remove("generating")
    btnGerar.disabled = false
    if (document.getElementById("ia-card-status")?.className !== "ia-card-status st-done")
      setIAStatus("ready")
  }
}


// ═══════════════════════════════════════════════════════════════
//  COPIAR TEXTO — copia o conteúdo bruto para a área de transferência
// ═══════════════════════════════════════════════════════════════
//  ANÁLISE JURÍDICA
// ═══════════════════════════════════════════════════════════════

let analiseAtual = null

async function analisarJuridico(cargo, nivel, texto, provedor) {
  const badge = document.getElementById("analise-badge")
  badge.style.display = ""
  badge.className = "analise-badge ab-loading"
  badge.innerHTML = `<i class="uil uil-gavel"></i> Analisando...`
  analiseAtual = null

  try {
    const res = await fetch("/analisar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cargo, nivel, texto, provedor })
    })
    if (!res.ok) throw new Error("Falha na análise")
    const data = await res.json()
    analiseAtual = data

    let cls, label
    if (data.aprovado) {
      cls = "ab-ok"; label = "Aprovado juridicamente"
    } else if (data.score >= 50) {
      const n = data.alertas?.length || 0
      cls = "ab-warn"; label = `${n} alerta${n !== 1 ? "s" : ""} jurídico${n !== 1 ? "s" : ""}`
    } else {
      cls = "ab-fail"; label = "Não aprovado"
    }
    // Re-dispara animação removendo e readicionando a classe
    badge.className = "analise-badge"
    badge.innerHTML = `<i class="uil uil-gavel"></i> ${label}`
    void badge.offsetWidth  // força reflow para reiniciar animação CSS
    badge.className = `analise-badge ${cls}`
  } catch {
    badge.className = "analise-badge"
    badge.innerHTML = `<i class="uil uil-gavel"></i> Análise indisponível`
    void badge.offsetWidth
    badge.className = "analise-badge ab-warn"
  }
}

function abrirModalAnalise() {
  const modal = document.getElementById("modal-analise")
  const body  = document.getElementById("modal-analise-body")
  if (!analiseAtual) return
  const d = analiseAtual

  const scoreClass = d.aprovado ? "ok" : d.score >= 50 ? "warn" : "fail"
  const scoreLabel = d.aprovado ? "Aprovado" : d.score >= 50 ? "Com ressalvas" : "Não aprovado"

  const alertasHTML = (d.alertas?.length)
    ? d.alertas.map((a, i) => {
        const descricao = typeof a === "string" ? a : a.descricao
        const sugestao  = typeof a === "string" ? "" : (a.sugestao || "")
        const grav      = typeof a === "string" ? "moderado" : (a.gravidade || "moderado")
        const sid       = `sugestao-${i}`
        return `<div class="analise-item alerta-item" id="alerta-${i}">
          <span class="grav-dot grav-${grav}"></span>
          <div class="alerta-corpo">
            <span>${descricao}</span>
            ${sugestao ? `<div class="alerta-sugestao" id="${sid}" style="display:none">
              <span class="alerta-sugestao-label">Sugestão:</span> ${sugestao}
            </div>` : ""}
            <div class="alerta-acoes">
              ${sugestao ? `<button class="btn-alerta btn-modificar" onclick="corrigirAlerta(${i})">Corrigir no texto</button>` : ""}
              <button class="btn-alerta btn-ignorar" onclick="ignorarAlerta(${i})">Ignorar</button>
            </div>
          </div>
        </div>`
      }).join("")
    : `<div class="analise-item"><span class="analise-icon">✓</span><span>Nenhum alerta identificado.</span></div>`

  const okHTML = (d.pontos_ok?.length)
    ? d.pontos_ok.map(p => `<div class="analise-item"><span class="analise-icon">✓</span><span>${p}</span></div>`).join("")
    : ""

  body.innerHTML = `
    <div class="analise-score">
      <div class="analise-score-num ${scoreClass}">${d.score}</div>
      <div>
        <div style="font-weight:600">${scoreLabel}</div>
        <div class="analise-score-label">Pontuação jurídica (0–100)</div>
      </div>
    </div>
    ${d.alertas?.length ? `<div class="analise-section">
      <div class="analise-section-title">Alertas</div>
      ${alertasHTML}
    </div>` : ""}
    ${d.pontos_ok?.length ? `<div class="analise-section">
      <div class="analise-section-title">Pontos positivos</div>
      ${okHTML}
    </div>` : ""}
  `
  modal.style.display = "flex"
}

function fecharModalAnalise(e) {
  if (!e || e.target === document.getElementById("modal-analise") || e.currentTarget?.classList?.contains("modal-close"))
    document.getElementById("modal-analise").style.display = "none"
}

async function corrigirAlerta(i) {
  if (!analiseAtual?.alertas?.[i]) return
  const alerta = analiseAtual.alertas[i]
  if (typeof alerta === "string" || !alerta.sugestao) return

  const cargo = cargoInput.value.trim()
  const nivel = document.getElementById("nivel").value

  // Fecha modal, garante que painel descricao e aba gen estão visíveis
  document.getElementById("modal-analise").style.display = "none"
  if (abaAtiva !== "descricao") trocarAba("descricao")
  verSecao("gen")

  const elGen = document.getElementById("resultado-gen")
  elGen.classList.add("corrigindo")
  elGen.scrollTop = 0

  let textoCorrigido = ""

  try {
    const res = await fetch("/corrigir", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ cargo, nivel, texto: textoGen, alerta, provedor: provedorAtual })
    })
    if (!res.ok) throw new Error("Falha na correção")

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let   buffer  = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const linhas = buffer.split("\n")
      buffer = linhas.pop()

      for (const linha of linhas) {
        if (!linha.startsWith("data: ")) continue
        let data
        try { data = JSON.parse(linha.slice(6)) } catch { continue }
        if (data.erro) throw new Error(data.erro)
        if (data.texto) {
          textoCorrigido += data.texto
          elGen.textContent = textoCorrigido
          elGen.scrollTop   = elGen.scrollHeight
        }
        if (data.fim) {
          textoGen    = textoCorrigido
          textoGerado = textoCorrigido
          elGen.innerHTML  = renderMarkdown(textoGen)
          elGen.className  = "resultado_content res-content"
          analiseAtual = null
          document.getElementById("analise-badge").style.display = "none"
          analisarJuridico(cargo, nivel, textoGen + "\n\n" + textoDet, provedorAtual)
          return
        }
      }
    }
  } catch (err) {
    elGen.classList.remove("corrigindo")
    showToast("Erro ao corrigir: " + err.message, "error")
  }
}

function ignorarAlerta(i) {
  const item = document.getElementById(`alerta-${i}`)
  if (!item) return
  item.classList.toggle("alerta-ignorado")
  const btn = item.querySelector(".btn-ignorar")
  if (btn) btn.textContent = item.classList.contains("alerta-ignorado") ? "Restaurar" : "Ignorar"
}

// ═══════════════════════════════════════════════════════════════

async function copiarTexto() {
  if (!textoGerado) {
    showToast("Nenhum texto gerado ainda.", "error")
    return
  }
  try {
    await navigator.clipboard.writeText(textoGerado)
    showToast("Texto copiado!", "success")
  } catch {
    showToast("Não foi possível copiar.", "error")
  }
}


// ═══════════════════════════════════════════════════════════════
//  BAIXAR TEXTO — faz download do conteúdo como arquivo .txt
// ═══════════════════════════════════════════════════════════════

function baixarTexto() {
  if (!textoGerado) {
    showToast("Nenhum texto gerado ainda.", "error")
    return
  }

  const cargo    = cargoInput.value.trim() || "cargo"
  const nivel    = document.getElementById("nivel").value
  const fileName = `descricao_${cargo.replace(/\s+/g, "_").toLowerCase()}_${nivel}.txt`

  const blob = new Blob([textoGerado], { type: "text/plain;charset=utf-8" })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement("a"), { href: url, download: fileName })

  a.click()
  URL.revokeObjectURL(url)
  showToast("Arquivo baixado!", "success")
}


// ═══════════════════════════════════════════════════════════════
//  LIMPAR RESULTADO
// ═══════════════════════════════════════════════════════════════

function limparResultado() {
  textoGerado = ""
  textoGen    = ""
  textoDet    = ""
  document.getElementById("resultado-wrap").style.display = "none"
  document.getElementById("resultado-gen").innerHTML = ""
  document.getElementById("resultado-det").innerHTML = ""
  placeholder.style.display = "flex"
  cboBadge.style.display    = "none"
  setStatus("idle")
  document.getElementById("charCount").textContent = "0 caracteres"
}


// ═══════════════════════════════════════════════════════════════
//  ABAS
// ═══════════════════════════════════════════════════════════════

function trocarAba(aba) {
  abaAtiva = aba
  ;["descricao","cargos","areas","conhecimento","niveis","usuarios"].forEach(id => {
    const tabEl    = document.getElementById("tab-"    + id)
    const painelEl = document.getElementById("painel-" + id)
    if (tabEl)    tabEl.classList.toggle("active", aba === id)
    if (painelEl) painelEl.style.display = aba === id ? "flex" : "none"
  })
  if (aba === "areas")        renderizarListaAreas()
  if (aba === "cargos")       renderizarListaCargos()
  if (aba === "conhecimento") renderizarListaConhecimento()
  if (aba === "niveis")       renderizarListaNiveis()
  if (aba === "usuarios")     carregarUsuarios()
}


// ═══════════════════════════════════════════════════════════════
//  GERENCIAR CARGOS
// ═══════════════════════════════════════════════════════════════

let cargoIdAtual = null  // id do cargo salvo mais recentemente (para histórico)

async function autoSalvarCargo(cargo, area, nivel, texto) {
  try {
    const res  = await fetch("/cargos", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ cargo, area, nivel, texto })
    })
    if (res.ok) {
      const data = await res.json()
      cargoIdAtual = data.id || null
      document.getElementById("historico-btn").style.display = cargoIdAtual ? "" : "none"
      await inicializarCargos()
      showToast("Cargo salvo automaticamente.", "info")
    }
  } catch { /* silencioso */ }
}

async function abrirHistorico() {
  if (!cargoIdAtual) return
  const modal = document.getElementById("modal-historico")
  const body  = document.getElementById("modal-historico-body")
  body.innerHTML = `<div style="padding:16px;opacity:.6">Carregando...</div>`
  modal.style.display = "flex"

  try {
    const res  = await fetch(`/versoes/${cargoIdAtual}`)
    const rows = await res.json()

    if (!rows.length) {
      body.innerHTML = `<div style="padding:16px;opacity:.6">Nenhuma versão encontrada.</div>`
      return
    }

    body.innerHTML = rows.map((v, i) => {
      const data    = new Date(v.criado_em).toLocaleString("pt-BR")
      const hashCur = v.hash.slice(0, 8)
      const hashPrev = v.hash_prev ? v.hash_prev.slice(0, 8) : "—"
      const label   = i === 0 ? '<span class="versao-atual">atual</span>' : ""
      return `<div class="versao-item" onclick="verVersao('${v.id}', this)">
        <div class="versao-meta">
          <span class="versao-data">${data}</span>${label}
        </div>
        <div class="versao-hash">
          <span title="hash desta versão"># ${hashCur}</span>
          <span class="versao-hash-chain" title="encadeado de">&larr; ${hashPrev}</span>
        </div>
        <div class="versao-texto-preview" id="vtxt-${v.id}" style="display:none"></div>
      </div>`
    }).join("")
  } catch {
    body.innerHTML = `<div style="padding:16px;opacity:.6">Erro ao carregar histórico.</div>`
  }
}

async function verVersao(versaoId) {
  const preview = document.getElementById(`vtxt-${versaoId}`)
  if (!preview) return
  if (preview.style.display !== "none") {
    preview.style.display = "none"
    return
  }
  if (!preview.dataset.carregado) {
    preview.textContent = "Carregando..."
    preview.style.display = ""
    try {
      const res  = await fetch(`/versoes/${cargoIdAtual}/${versaoId}/texto`)
      const data = await res.json()
      preview.textContent = data.texto
      preview.dataset.carregado = "1"
    } catch {
      preview.textContent = "Erro ao carregar."
    }
  } else {
    preview.style.display = ""
  }
}

// ── Strip markdown para textarea ───────────────────────────────
function stripMarkdown(txt) {
  return (txt || "")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/\*(.+?)\*/gs,     "$1")
    .replace(/__(.+?)__/gs,     "$1")
    .replace(/_(.+?)_/gs,       "$1")
    .replace(/`(.+?)`/g,        "$1")
    .replace(/^#{1,6}\s+/gm,    "")
    .trim()
}

// ── Copiar conteúdo de textarea ────────────────────────────────
function copiarTextarea(id) {
  const val = document.getElementById(id)?.value || ""
  if (!val.trim()) return showToast("Nada para copiar.", "error")
  navigator.clipboard.writeText(val)
    .then(() => showToast("Copiado!", "success"))
    .catch(() => showToast("Erro ao copiar.", "error"))
}

// ── Histórico geral de mudanças ────────────────────────────────
let historicoGeralData = []

async function abrirHistoricoGeral() {
  const modal = document.getElementById("modal-historico-geral")
  const body  = document.getElementById("modal-historico-geral-body")
  body.innerHTML = `<div style="padding:16px;opacity:.6">Carregando...</div>`
  modal.style.display = "flex"
  document.getElementById("hist-filtro").value = ""

  try {
    const res = await fetch("/changelog")
    historicoGeralData = await res.json()
    renderHistoricoGeral(historicoGeralData)
  } catch {
    body.innerHTML = `<div style="padding:16px;opacity:.6">Erro ao carregar histórico.</div>`
  }
}

function filtrarHistorico(q) {
  const filtrado = q.trim()
    ? historicoGeralData.filter(v => v.cargo.toLowerCase().includes(q.toLowerCase()))
    : historicoGeralData
  renderHistoricoGeral(filtrado)
}

function renderHistoricoGeral(rows) {
  const body = document.getElementById("modal-historico-geral-body")
  if (!rows.length) {
    body.innerHTML = `<div style="padding:16px;opacity:.6">Nenhuma alteração encontrada.</div>`
    return
  }

  // Agrupa por data (dia)
  const grupos = {}
  rows.forEach(v => {
    const dia = new Date(v.criado_em).toLocaleDateString("pt-BR", { weekday:"long", day:"2-digit", month:"long", year:"numeric" })
    if (!grupos[dia]) grupos[dia] = []
    grupos[dia].push(v)
  })

  body.innerHTML = Object.entries(grupos).map(([dia, vers]) => `
    <div class="hg-grupo">
      <div class="hg-dia">${dia}</div>
      ${vers.map(v => {
        const hora  = new Date(v.criado_em).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" })
        const hash  = v.hash.slice(0, 8)
        const nivel = v.nivel ? `<span class="hg-nivel">${v.nivel}</span>` : ""
        const area  = v.area  ? `<span class="hg-area">${v.area}</span>`   : ""
        return `<div class="hg-item">
          <div class="hg-hora">${hora}</div>
          <div class="hg-info">
            <span class="hg-cargo">${v.cargo}</span>
            ${nivel}${area}
          </div>
          <code class="hg-hash">${hash}</code>
        </div>`
      }).join("")}
    </div>
  `).join("")
}

function fecharHistoricoGeral(e) {
  if (!e || e.target === document.getElementById("modal-historico-geral") || e.currentTarget?.classList?.contains("modal-close"))
    document.getElementById("modal-historico-geral").style.display = "none"
}

function fecharHistorico(e) {
  if (!e || e.target === document.getElementById("modal-historico") || e.currentTarget?.classList?.contains("modal-close"))
    document.getElementById("modal-historico").style.display = "none"
}

// ── Calendário de Mudanças ─────────────────────────────────────
let calData     = []   // todos os registros de versoes
let calAno      = new Date().getFullYear()
let calMes      = new Date().getMonth()  // 0-11
let calDiaSel   = null

const MESES_PT = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
                  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"]

async function abrirCalendario() {
  document.getElementById("modal-calendario").style.display = "flex"
  calAno = new Date().getFullYear()
  calMes = new Date().getMonth()
  calDiaSel = null
  mudarAbaCalendario("cal")
  try {
    const r = await fetch("/changelog")
    calData = await r.json()
  } catch { calData = [] }
  renderCalendario()
}

function fecharCalendario(e) {
  const el = document.getElementById("modal-calendario")
  if (!e || e.target === el || e.currentTarget?.classList?.contains("modal-close"))
    el.style.display = "none"
}

function mudarAbaCalendario(aba) {
  ["cal","exp","sobre"].forEach(a => {
    document.getElementById("cal-pane-" + a).style.display = a === aba ? "flex" : "none"
    document.getElementById("cal-tab-"  + a).classList.toggle("active", a === aba)
  })
  if (aba === "cal") renderCalendario()
}

function navegarMes(delta) {
  calMes += delta
  if (calMes > 11) { calMes = 0;  calAno++ }
  if (calMes < 0)  { calMes = 11; calAno-- }
  calDiaSel = null
  renderCalendario()
}

function renderCalendario() {
  const grid    = document.getElementById("cal-grid")
  const label   = document.getElementById("cal-mes-label")
  const summary = document.getElementById("cal-summary")
  if (!grid) return

  label.textContent = `${MESES_PT[calMes]} ${calAno}`

  // agrupar por dia YYYY-MM-DD
  const byDay = {}
  calData.forEach(v => {
    const d = v.criado_em?.slice(0, 10)
    if (!d) return
    if (!byDay[d]) byDay[d] = []
    byDay[d].push(v)
  })

  // contar para o mês corrente
  const prefixo = `${calAno}-${String(calMes + 1).padStart(2, "0")}`
  const totalMes = Object.entries(byDay)
    .filter(([d]) => d.startsWith(prefixo))
    .reduce((s, [, vs]) => s + vs.length, 0)

  summary.textContent = totalMes
    ? `${totalMes} modificação${totalMes > 1 ? "ões" : ""} neste mês`
    : "Sem modificações neste mês"

  // calcular heat máximo para normalização
  const counts = Object.values(byDay).map(a => a.length)
  const maxCount = Math.max(1, ...counts)

  // construir o grid
  const primeiroDia = new Date(calAno, calMes, 1).getDay()  // 0=Dom
  const diasNoMes   = new Date(calAno, calMes + 1, 0).getDate()
  const hoje = new Date().toISOString().slice(0, 10)

  let html = ""

  // células do mês anterior (padding)
  const mesAntes  = calMes === 0 ? 11 : calMes - 1
  const anoAntes  = calMes === 0 ? calAno - 1 : calAno
  const diasAntes = new Date(anoAntes, mesAntes + 1, 0).getDate()
  for (let i = primeiroDia - 1; i >= 0; i--) {
    html += `<div class="cal-cell cal-outro-mes">${diasAntes - i}</div>`
  }

  // células do mês atual
  for (let d = 1; d <= diasNoMes; d++) {
    const key    = `${calAno}-${String(calMes + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`
    const items  = byDay[key] || []
    const count  = items.length
    const isHoje = key === hoje
    const isSel  = key === calDiaSel

    let cls = "cal-cell"
    if (isHoje)  cls += " cal-hoje"
    if (isSel)   cls += " cal-selecionado"
    if (count)   cls += " cal-tem-dado"

    // heat map: 1-4 classes
    if (count && !isSel) {
      const ratio = count / maxCount
      const heat  = ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4
      cls += ` cal-heat-${heat}`
    }

    const badge = count ? `<span class="cal-badge">${count}</span>` : ""
    html += `<div class="${cls}" onclick="selecionarDia('${key}')">${d}${badge}</div>`
  }

  // células do mês seguinte (padding)
  const total = primeiroDia + diasNoMes
  const resto = total % 7 === 0 ? 0 : 7 - (total % 7)
  for (let i = 1; i <= resto; i++) {
    html += `<div class="cal-cell cal-outro-mes">${i}</div>`
  }

  grid.innerHTML = html

  // se havia dia selecionado, renderiza detalhes
  if (calDiaSel && byDay[calDiaSel]) renderDiaDetalhe(calDiaSel, byDay[calDiaSel])
}

function selecionarDia(key) {
  calDiaSel = key
  renderCalendario()

  // agrupar para encontrar itens daquele dia
  const items = calData.filter(v => v.criado_em?.slice(0, 10) === key)
  renderDiaDetalhe(key, items)
}

function renderDiaDetalhe(key, items) {
  const header = document.getElementById("cal-day-header")
  const list   = document.getElementById("cal-day-list")

  const [ano, mes, dia] = key.split("-")
  header.textContent = `${parseInt(dia)} de ${MESES_PT[parseInt(mes) - 1]} de ${ano} — ${items.length} modificação${items.length !== 1 ? "ões" : ""}`

  if (!items.length) {
    list.innerHTML = `<p class="cal-empty">Sem modificações neste dia</p>`
    return
  }

  list.innerHTML = items.map(v => {
    const hora  = v.criado_em?.slice(11, 16) || ""
    const tags  = [v.nivel, v.area].filter(Boolean)
    const hash6 = v.hash?.slice(0, 12) || ""
    return `
      <div class="cal-item">
        <div class="cal-item-top">
          <span class="cal-item-cargo">${v.cargo}</span>
          <span class="cal-item-hora">${hora}</span>
        </div>
        <div class="cal-item-meta">
          ${tags.map(t => `<span class="cal-item-tag">${t}</span>`).join("")}
        </div>
        <div class="cal-item-hash">#${hash6}…</div>
      </div>`
  }).join("")
}

function expQueryString() {
  const de  = document.getElementById("exp-de").value
  const ate = document.getElementById("exp-ate").value
  const p   = []
  if (de)  p.push("de="  + de)
  if (ate) p.push("ate=" + ate)
  return p.length ? "?" + p.join("&") : ""
}

async function baixarExport() {
  const url = "/exportar" + expQueryString()
  const btn = document.querySelector(".btn-exportar")
  btn.disabled = true
  btn.innerHTML = `<i class="uil uil-spinner-alt"></i> Gerando...`
  try {
    const r    = await fetch(url)
    const blob = await r.blob()
    const a    = document.createElement("a")
    a.href     = URL.createObjectURL(blob)
    a.download = `joydesc-export-${new Date().toISOString().slice(0,10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  } catch (e) {
    alert("Erro ao exportar: " + e.message)
  } finally {
    btn.disabled = false
    btn.innerHTML = `<i class="uil uil-brackets-curly"></i> Baixar JSON assinado`
  }
}

function exportarPDF() {
  const url = "/exportar/pdf" + expQueryString()
  window.open(url, "_blank")
}

function renderizarListaCargos() {
  const ul = document.getElementById("cargos-list")
  ul.innerHTML = ""
  if (!cargosData.length) {
    ul.innerHTML = `<li style="pointer-events:none;opacity:0.5;flex-direction:column;align-items:flex-start;padding:12px 14px"><span class="cargo-titulo">Nenhum cargo salvo</span></li>`
    return
  }
  cargosData.forEach(c => {
    const li = document.createElement("li")
    li.className = cargoEditando === c.id ? "selected" : ""
    const data = new Date(c.criadoEm).toLocaleDateString("pt-BR")
    li.innerHTML = `
      <span class="cargo-titulo">${c.cargo}</span>
      <span class="cargo-meta">${c.area} · ${c.nivel} · ${data}</span>
    `
    li.onclick = () => abrirEdicaoCargo(c.id)
    ul.appendChild(li)
  })
}

function abrirEdicaoCargo(id) {
  const c = cargosData.find(x => x.id === id)
  if (!c) return

  cargoEditando = id
  document.getElementById("cargos-empty").style.display = "none"
  document.getElementById("cargos-form").style.display  = "flex"
  document.getElementById("cargos-form-titulo").textContent = c.cargo
  const data = new Date(c.criadoEm).toLocaleDateString("pt-BR", { day:"2-digit", month:"short", year:"numeric" })
  document.getElementById("cargos-form-meta").textContent = `${c.area} · ${c.nivel} · Criado em ${data}`
  document.getElementById("cargo-nome").value  = c.cargo
  document.getElementById("cargo-area").value  = c.area
  document.getElementById("cargo-nivel").value = c.nivel
  document.getElementById("cargo-texto").value = stripMarkdown(c.texto)

  renderizarListaCargos()
}

async function salvarEdicaoCargo() {
  if (!cargoEditando) return
  const cargo = document.getElementById("cargo-nome").value.trim()
  const area  = document.getElementById("cargo-area").value.trim()
  const nivel = document.getElementById("cargo-nivel").value.trim()
  const texto = document.getElementById("cargo-texto").value.trim()

  if (!cargo || !texto) { showToast("Cargo e descrição são obrigatórios.", "error"); return }

  try {
    const res  = await fetch(`/cargos/${cargoEditando}`, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ cargo, area, nivel, texto })
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.erro || "Erro ao salvar.", "error"); return }

    showToast("Cargo atualizado!", "success")
    await inicializarCargos()
    renderizarListaCargos()
    document.getElementById("cargos-form-titulo").textContent = cargo

  } catch { showToast("Erro ao salvar cargo.", "error") }
}

async function deletarCargo() {
  if (!cargoEditando) return
  const c = cargosData.find(x => x.id === cargoEditando)
  if (!await confirmar(`Deletar <strong>${c?.cargo}</strong>?\nEsta ação não pode ser desfeita.`, { titulo: "Deletar cargo", labelOk: "Deletar" })) return

  try {
    const res = await fetch(`/cargos/${cargoEditando}`, { method: "DELETE" })
    if (!res.ok) { const d = await res.json(); showToast(d?.erro || "Erro.", "error"); return }

    showToast("Cargo deletado.", "info")
    cancelarCargo()
    await inicializarCargos()
    renderizarListaCargos()

  } catch { showToast("Erro ao deletar cargo.", "error") }
}

function cancelarCargo() {
  cargoEditando = null
  document.getElementById("cargos-form").style.display  = "none"
  document.getElementById("cargos-empty").style.display = "flex"
  document.querySelectorAll(".cargos-list li").forEach(li => li.classList.remove("selected"))
}

let secaoVisivelAtual = "gen"

function verSecao(qual) {
  secaoVisivelAtual = qual
  document.getElementById("resultado-gen").style.display = qual === "gen" ? "block" : "none"
  document.getElementById("resultado-det").style.display = qual === "det" ? "block" : "none"
  document.getElementById("res-tab-gen").classList.toggle("active", qual === "gen")
  document.getElementById("res-tab-det").classList.toggle("active", qual === "det")
}

function copiarSecaoAtiva() {
  copiarSecao(secaoVisivelAtual)
}

function copiarSecao(qual) {
  const texto = qual === "gen" ? textoGen : textoDet
  if (!texto) { showToast("Nenhum texto para copiar.", "error"); return }
  navigator.clipboard.writeText(texto).then(() =>
    showToast(qual === "gen" ? "Genérica copiada!" : "Detalhada copiada!", "success")
  )
}

function exportarCargo() {
  const cargo = cargosData.find(c => c.id === cargoEditando)
  if (!cargo) return
  const conteudo = `${cargo.cargo} — ${cargo.area} — ${cargo.nivel}\n${"─".repeat(60)}\n\n${cargo.texto}`
  const blob = new Blob([conteudo], { type: "text/plain;charset=utf-8" })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement("a")
  a.href     = url
  a.download = `${cargo.cargo.replace(/\s+/g, "_")}_${cargo.nivel}.txt`
  a.click()
  URL.revokeObjectURL(url)
  showToast("Arquivo exportado.", "success")
}


// ═══════════════════════════════════════════════════════════════
//  GERENCIAR ÁREAS
// ═══════════════════════════════════════════════════════════════

function renderizarListaAreas() {
  const ul = document.getElementById("areas-list")
  ul.innerHTML = ""
  areasData.forEach(a => {
    const li = document.createElement("li")
    li.className = areaEditando === a.key ? "selected" : ""
    li.innerHTML = `<i class="uil uil-layer-group"></i> ${a.label}`
    li.onclick = () => abrirEdicaoArea(a.key)
    ul.appendChild(li)
  })
}

function abrirEdicaoArea(key) {
  const area = areasData.find(a => a.key === key)
  if (!area) return

  areaEditando = key
  document.getElementById("areas-empty").style.display = "none"
  document.getElementById("areas-form").style.display  = "flex"
  document.getElementById("areas-form-title").textContent = "Editar Área"
  document.getElementById("area-key").value     = area.key
  document.getElementById("area-key").disabled  = true
  document.getElementById("area-label").value   = area.label
  document.getElementById("area-universo").value = area.universo

  renderizarListaAreas()
}

function novaArea() {
  areaEditando = null
  document.getElementById("areas-empty").style.display = "none"
  document.getElementById("areas-form").style.display  = "flex"
  document.getElementById("areas-form-title").textContent = "Nova Área"
  document.getElementById("area-key").value     = ""
  document.getElementById("area-key").disabled  = false
  document.getElementById("area-label").value   = ""
  document.getElementById("area-universo").value = ""

  document.querySelectorAll(".areas-list li").forEach(li => li.classList.remove("selected"))
  document.getElementById("area-key").focus()
}

async function salvarArea() {
  const key     = document.getElementById("area-key").value.trim()
  const label   = document.getElementById("area-label").value.trim()
  const universo = document.getElementById("area-universo").value.trim()

  if (!key || !label || !universo) {
    showToast("Preencha todos os campos.", "error")
    return
  }

  try {
    let res
    if (areaEditando) {
      res = await fetch(`/areas/${encodeURIComponent(areaEditando)}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ label, universo })
      })
    } else {
      res = await fetch("/areas", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ key, label, universo })
      })
    }

    const data = await res.json()
    if (!res.ok) { showToast(data.erro || "Erro ao salvar.", "error"); return }

    showToast("Área salva com sucesso!", "success")
    await inicializarAreas()
    areaEditando = key
    renderizarListaAreas()

  } catch {
    showToast("Erro ao salvar área.", "error")
  }
}

async function deletarArea() {
  if (!areaEditando) return
  if (!await confirmar(`Deletar a área <strong>${areaEditando}</strong>?\nEsta ação não pode ser desfeita.`, { titulo: "Deletar área", labelOk: "Deletar" })) return

  try {
    const res  = await fetch(`/areas/${encodeURIComponent(areaEditando)}`, { method: "DELETE" })
    const data = await res.json()
    if (!res.ok) { showToast(data.erro || "Erro ao deletar.", "error"); return }

    showToast("Área deletada.", "info")
    cancelarArea()
    await inicializarAreas()
    renderizarListaAreas()

  } catch {
    showToast("Erro ao deletar área.", "error")
  }
}

function cancelarArea() {
  areaEditando = null
  document.getElementById("areas-form").style.display  = "none"
  document.getElementById("areas-empty").style.display = "flex"
  document.querySelectorAll(".areas-list li").forEach(li => li.classList.remove("selected"))
}


// ═══════════════════════════════════════════════════════════════
//  BASE DE CONHECIMENTO
// ═══════════════════════════════════════════════════════════════

function renderizarListaConhecimento() {
  const ul = document.getElementById("conhecimento-list")
  ul.innerHTML = ""
  if (!conhecimentoData.length) {
    ul.innerHTML = `<li style="pointer-events:none;opacity:0.5;flex-direction:column;align-items:flex-start;padding:12px 14px"><span class="cargo-titulo">Nenhum artigo cadastrado</span></li>`
    return
  }
  conhecimentoData.forEach(a => {
    const li = document.createElement("li")
    li.className = artigoEditando === a.id ? "selected" : ""
    li.innerHTML = `
      <span class="conh-item-main">
        <i class="uil uil-book-alt" style="flex-shrink:0;opacity:${a.ativo ? 1 : 0.35}"></i>
        <span class="conh-item-titulo" style="opacity:${a.ativo ? 1 : 0.45}">${a.titulo}</span>
      </span>
      ${a.categoria ? `<span class="conh-item-cat">${a.categoria}</span>` : ""}
    `
    li.onclick = () => abrirEdicaoArtigo(a.id)
    ul.appendChild(li)
  })
}

function abrirEdicaoArtigo(id) {
  const a = conhecimentoData.find(x => x.id === id)
  if (!a) return

  artigoEditando = id
  document.getElementById("conhecimento-empty").style.display = "none"
  document.getElementById("conhecimento-form").style.display  = "flex"
  document.getElementById("conhecimento-form").style.flexDirection = "column"
  document.getElementById("conhecimento-form-title").textContent = "Editar Artigo"
  document.getElementById("artigo-titulo").value    = a.titulo
  document.getElementById("artigo-categoria").value = a.categoria
  document.getElementById("artigo-conteudo").value  = a.conteudo
  document.getElementById("artigo-ativo").checked   = a.ativo

  renderizarListaConhecimento()
}

function novoArtigo() {
  artigoEditando = null
  document.getElementById("conhecimento-empty").style.display = "none"
  document.getElementById("conhecimento-form").style.display  = "flex"
  document.getElementById("conhecimento-form").style.flexDirection = "column"
  document.getElementById("conhecimento-form-title").textContent = "Novo Artigo"
  document.getElementById("artigo-titulo").value    = ""
  document.getElementById("artigo-categoria").value = ""
  document.getElementById("artigo-conteudo").value  = ""
  document.getElementById("artigo-ativo").checked   = true

  document.querySelectorAll(".conhecimento-list li").forEach(li => li.classList.remove("selected"))
  document.getElementById("artigo-titulo").focus()
}

async function toggleAtivoArtigo(checkbox) {
  if (!artigoEditando) return
  try {
    await fetch(`/conhecimento/${artigoEditando}`, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ativo: checkbox.checked })
    })
    await inicializarConhecimento()
    renderizarListaConhecimento()
    showToast(checkbox.checked ? "Artigo ativado." : "Artigo desativado.", "info")
  } catch { showToast("Erro ao atualizar artigo.", "error") }
}

async function salvarArtigo() {
  const titulo    = document.getElementById("artigo-titulo").value.trim()
  const categoria = document.getElementById("artigo-categoria").value.trim()
  const conteudo  = document.getElementById("artigo-conteudo").value.trim()
  const ativo     = document.getElementById("artigo-ativo").checked

  if (!titulo || !conteudo) { showToast("Título e conteúdo são obrigatórios.", "error"); return }

  try {
    let res
    if (artigoEditando) {
      res = await fetch(`/conhecimento/${artigoEditando}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ titulo, categoria, conteudo, ativo })
      })
    } else {
      res = await fetch("/conhecimento", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ titulo, categoria, conteudo, ativo })
      })
    }

    const data = await res.json()
    if (!res.ok) { showToast(data.erro || "Erro ao salvar.", "error"); return }

    showToast("Artigo salvo!", "success")
    await inicializarConhecimento()
    if (!artigoEditando && data.id) artigoEditando = data.id
    renderizarListaConhecimento()

  } catch { showToast("Erro ao salvar artigo.", "error") }
}

async function deletarArtigo() {
  if (!artigoEditando) return
  const a = conhecimentoData.find(x => x.id === artigoEditando)
  if (!await confirmar(`Deletar <strong>${a?.titulo}</strong>?\nEsta ação não pode ser desfeita.`, { titulo: "Deletar conhecimento", labelOk: "Deletar" })) return

  try {
    const res = await fetch(`/conhecimento/${artigoEditando}`, { method: "DELETE" })
    if (!res.ok) { const d = await res.json(); showToast(d?.erro || "Erro.", "error"); return }

    showToast("Artigo deletado.", "info")
    cancelarArtigo()
    await inicializarConhecimento()
    renderizarListaConhecimento()

  } catch { showToast("Erro ao deletar artigo.", "error") }
}

function cancelarArtigo() {
  artigoEditando = null
  document.getElementById("conhecimento-form").style.display  = "none"
  document.getElementById("conhecimento-empty").style.display = "flex"
  document.querySelectorAll(".conhecimento-list li").forEach(li => li.classList.remove("selected"))
}


// ═══════════════════════════════════════════════════════════════
//  FONTES
// ═══════════════════════════════════════════════════════════════

function trocarFonte(familia) {
  document.documentElement.style.setProperty("--font-ui", `'${familia}', sans-serif`)
  document.querySelectorAll(".area-textarea, .resultado_content").forEach(el => {
    el.style.fontFamily = `'${familia}', sans-serif`
  })
  localStorage.setItem("joy-fonte", familia)
  showToast(`Fonte: ${familia}`, "info")
}

// Aplica fonte salva ao carregar
;(function aplicarFonteSalva() {
  const f = localStorage.getItem("joy-fonte")
  if (f) trocarFonte(f)
})()


// ═══════════════════════════════════════════════════════════════
//  BARRA DE FORMATAÇÃO — funções para os textareas
// ═══════════════════════════════════════════════════════════════

// Envolve o texto selecionado com marcadores (ex: **negrito**)
function wrapTexto(id, marcador) {
  const ta    = document.getElementById(id)
  const start = ta.selectionStart
  const end   = ta.selectionEnd
  const sel   = ta.value.substring(start, end)
  const antes  = ta.value.substring(0, start)
  const depois = ta.value.substring(end)

  // Se já tem o marcador, remove (toggle)
  if (sel.startsWith(marcador) && sel.endsWith(marcador) && sel.length > marcador.length * 2) {
    const sem = sel.slice(marcador.length, -marcador.length)
    ta.value = antes + sem + depois
    ta.selectionStart = start
    ta.selectionEnd   = start + sem.length
  } else {
    ta.value = antes + marcador + sel + marcador + depois
    ta.selectionStart = start + marcador.length
    ta.selectionEnd   = end   + marcador.length
  }
  ta.focus()
}

// Adiciona "- " no início de cada linha selecionada
function inserirLista(id) {
  const ta    = document.getElementById(id)
  const start = ta.selectionStart
  const end   = ta.selectionEnd
  const sel   = ta.value.substring(start, end)
  const linhas = sel.split("\n").map(l => l.startsWith("- ") ? l.slice(2) : `- ${l}`)
  const novo   = linhas.join("\n")
  ta.value = ta.value.substring(0, start) + novo + ta.value.substring(end)
  ta.selectionStart = start
  ta.selectionEnd   = start + novo.length
  ta.focus()
}

// Converte seleção para MAIÚSCULAS
function maiusculas(id) {
  const ta    = document.getElementById(id)
  const start = ta.selectionStart
  const end   = ta.selectionEnd
  const sel   = ta.value.substring(start, end)
  if (!sel) return
  const novo = sel === sel.toUpperCase() ? sel.toLowerCase() : sel.toUpperCase()
  ta.value = ta.value.substring(0, start) + novo + ta.value.substring(end)
  ta.selectionStart = start
  ta.selectionEnd   = start + novo.length
  ta.focus()
}

// Remove marcadores ** e _ do texto inteiro do textarea
function limparFormatacao(id) {
  const ta = document.getElementById(id)
  ta.value = ta.value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/_(.+?)_/g, "$1").replace(/`(.+?)`/g, "$1")
  ta.focus()
}

// Muda o tamanho da fonte do textarea
function tamanhoTextarea(id, tamanho) {
  document.getElementById(id).style.fontSize = tamanho + "px"
}


// ═══════════════════════════════════════════════════════════════
//  MENUS — dropdown toggle e ações
// ═══════════════════════════════════════════════════════════════

let fonteAtual = 13

// Abre/fecha dropdown ao clicar no item de menu
document.querySelectorAll(".menu-group").forEach(group => {
  group.querySelector(".menu-item").addEventListener("click", e => {
    e.stopPropagation()
    const aberto = group.classList.contains("open")
    document.querySelectorAll(".menu-group").forEach(g => g.classList.remove("open"))
    if (!aberto) group.classList.add("open")
  })
})

// Fecha ao clicar fora
document.addEventListener("click", () => {
  document.querySelectorAll(".menu-group").forEach(g => g.classList.remove("open"))
})

function menuAcao(acao) {
  document.querySelectorAll(".menu-group").forEach(g => g.classList.remove("open"))

  switch (acao) {
    case "novo":
      limparResultado()
      cargoInput.value = ""
      cargoInput.focus()
      showToast("Novo documento iniciado.", "info")
      break

    case "fechar":
      showToast("Feche a aba do navegador para encerrar.", "info")
      break

    case "selecionarTudo":
      if (textoGerado) {
        const secaoEl = document.getElementById("resultado-gen").style.display !== "none"
          ? document.getElementById("resultado-gen")
          : document.getElementById("resultado-det")
        const range = document.createRange()
        range.selectNodeContents(secaoEl)
        window.getSelection().removeAllRanges()
        window.getSelection().addRange(range)
        showToast("Texto selecionado.", "info")
      } else {
        showToast("Nenhum texto gerado ainda.", "error")
      }
      break

    case "aumentarFonte":
      fonteAtual = Math.min(fonteAtual + 1, 20)
      document.querySelectorAll(".resultado_content").forEach(el => el.style.fontSize = fonteAtual + "px")
      showToast(`Fonte: ${fonteAtual}px`, "info")
      break

    case "diminuirFonte":
      fonteAtual = Math.max(fonteAtual - 1, 10)
      document.querySelectorAll(".resultado_content").forEach(el => el.style.fontSize = fonteAtual + "px")
      showToast(`Fonte: ${fonteAtual}px`, "info")
      break

    case "resetFonte":
      fonteAtual = 13
      document.querySelectorAll(".resultado_content").forEach(el => el.style.fontSize = "")
      showToast("Fonte redefinida.", "info")
      break

    case "gerarNovamente":
      gerarDescricao()
      break

    case "contarPalavras":
      if (textoGerado) {
        const palavras = textoGerado.trim().split(/\s+/).length
        showToast(`${palavras.toLocaleString("pt-BR")} palavras · ${textoGerado.length.toLocaleString("pt-BR")} caracteres`, "info")
      } else {
        showToast("Nenhum texto gerado ainda.", "error")
      }
      break

    case "sobre":
      showToast("JoyDesc v2.0 — Gerador de Descrição de Cargos", "info")
      break

    case "cbo":
      showToast("CBO 2002 — Classificação Brasileira de Ocupações do Ministério do Trabalho e Emprego.", "info")
      break
  }
}


// ═══════════════════════════════════════════════════════════════
//  SPLASH SCREEN
// ═══════════════════════════════════════════════════════════════
;(async function iniciarSplash() {
  const splash = document.getElementById("splash")
  if (!splash) return

  const msgEl    = document.getElementById("sp-msg")
  const barEl    = document.getElementById("sp-bar")
  const pctEl    = document.getElementById("sp-pct")
  const wordmark = document.querySelector(".sp-wordmark")
  const setBar   = pct => { barEl.style.width = pct + "%"; if (pctEl) pctEl.textContent = pct + "%" }
  const delay    = ms => new Promise(r => setTimeout(r, ms))

  // ── Efeito glitch: letra por letra — sincronizado com barra ──
  await new Promise(resolve => {
    const target       = "JoyDesc"
    const chars        = "!@#$%&?§±×÷ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    const glitchFrames = 9
    const snapFrame    = 7
    const ms           = 42
    const isJoy        = i => i < 3

    let letterIdx     = 0
    let frameInLetter = 0

    const rand = () => chars[Math.floor(Math.random() * chars.length)]

    const render = (lockedCount, activeChar) => {
      let html = ""
      for (let i = 0; i < target.length; i++) {
        const cls = isJoy(i) ? "sp-wm-joy" : "sp-wm-desc"
        if (i < lockedCount) {
          html += `<span class="${cls}">${target[i]}</span>`
        } else if (i === lockedCount) {
          html += `<span class="sp-letter-active">${activeChar}</span>`
        } else {
          html += `<span class="sp-letter-pending">${target[i]}</span>`
        }
      }
      return html
    }

    wordmark.classList.add("glitching")
    wordmark.innerHTML = render(0, rand())
    // barra começa junto com as letras
    setBar(0)

    const tick = setInterval(() => {
      frameInLetter++

      const snapping  = frameInLetter >= snapFrame
      const activeChar = snapping ? target[letterIdx] : rand()

      if (frameInLetter >= glitchFrames) {
        letterIdx++
        frameInLetter = 0

        // avança a barra a cada letra que trava (0 → 48%)
        setBar(Math.round(letterIdx / target.length * 48))

        if (letterIdx >= target.length - 2) wordmark.classList.add("glitch-low")

        if (letterIdx >= target.length) {
          clearInterval(tick)
          wordmark.classList.remove("glitching", "glitch-low")
          wordmark.innerHTML = '<span class="sp-wm-joy">Joy</span><span class="sp-wm-desc">Desc</span>'
          resolve()
          return
        }
      }

      wordmark.innerHTML = render(letterIdx, activeChar)
    }, ms)
  })

  // ── Verifica auth em paralelo com as mensagens ───────────────
  const authPromise = fetch("/auth/me")
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)

  // ── Mensagens de loading (continua de ~48% → 100%) ───────────
  const msgs = [
    { text: "Conectando ao Groq...",                pct: 56,  wait: 100 },
    { text: "Indexando IA jurídica...",              pct: 64,  wait: 440 },
    { text: "Carregando base CBO 2002...",           pct: 73,  wait: 420 },
    { text: "11.097 ocupações indexadas ✓",          pct: 82,  wait: 380 },
    { text: "Verificando conformidade CLT...",       pct: 89,  wait: 400 },
    { text: "Carregando base de conhecimento...",    pct: 95,  wait: 380 },
    { text: "Calibrando análise de cargos...",       pct: 99,  wait: 340 },
    { text: "Sistema pronto ✓",                      pct: 100, wait: 320 },
  ]

  for (const { text, pct, wait } of msgs) {
    await delay(wait)
    msgEl.classList.add("sp-fading")
    await delay(150)
    msgEl.textContent = text
    setBar(pct)
    msgEl.classList.remove("sp-fading")
  }

  await delay(500)
  setProvedor("groq", true)

  const authData = await authPromise

  if (authData) {
    // ── Autenticado: fade normal do splash → mostra app ──────
    usuarioAtual = authData.user
    empresaAtual = authData.empresa
    splash.style.transition = "opacity 0.7s ease"
    splash.style.opacity    = "0"
    await delay(750)
    splash.remove()
    atualizarBarraTitulo()
    await inicializarApp()
  } else {
    // ── Não autenticado: morphar splash → login ───────────────
    // 1. Fade out o conteúdo da animação
    const spContent = document.getElementById("sp-content")
    spContent.style.transition = "opacity 0.35s ease"
    spContent.style.opacity    = "0"
    await delay(380)
    spContent.style.display = "none"

    // 2. Login aparece sobre o fundo do splash (sem fundo próprio)
    const loginEl = document.getElementById("login-overlay")
    loginEl.style.background  = "transparent"
    loginEl.style.opacity     = "0"
    loginEl.style.display     = "flex"
    loginEl.style.transition  = "opacity 0.45s ease"
    await delay(30)
    loginEl.style.opacity     = "1"
  }
})()
