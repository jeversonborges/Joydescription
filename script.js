// ═══════════════════════════════════════════════════════════════
//  JoyDescription — Script do Frontend (script.js)
//  Responsável por: autocomplete via API, geração com streaming,
//  renderização do resultado em markdown, copiar e baixar texto
// ═══════════════════════════════════════════════════════════════


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
let abaAtiva           = "descricao"

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
  ollama: {
    ico:  "uil-processor",
    nome: "Ollama · qwen2.5",
    desc: "Local · privacidade total · sem internet"
  },
  groq: {
    ico:  "uil-cloud",
    nome: "Groq · llama-3.3-70b",
    desc: "Nuvem · 70B parâmetros · ~500 tok/s"
  }
}

function setProvedor(prov, silent = false) {
  provedorAtual = prov
  document.getElementById("prov-ollama").classList.toggle("active", prov === "ollama")
  document.getElementById("prov-groq").classList.toggle("active",   prov === "groq")
  const info = IA_INFO[prov]
  document.getElementById("ia-card-ico").className   = `uil ${info.ico}`
  document.getElementById("ia-card-name").textContent = info.nome
  document.getElementById("ia-card-desc").textContent = info.desc
  setIAStatus("ready")
  if (!silent) showToast(prov === "groq" ? "Groq · llama-3.3-70b · nuvem" : "Ollama · local · privacidade total", "info")
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

inicializarAreas()

// ── Carrega cargos salvos ──────────────────────────────────────
async function inicializarCargos() {
  try {
    const res  = await fetch("/cargos")
    cargosData = await res.json()
    atualizarContadorCargos()
  } catch { /* silencioso */ }
}

function atualizarContadorCargos() {
  const el = document.getElementById("cargos-count")
  if (el) el.textContent = cargosData.length
}

inicializarCargos()

// ── Carrega base de conhecimento ───────────────────────────────
async function inicializarConhecimento() {
  try {
    const res        = await fetch("/conhecimento")
    conhecimentoData = await res.json()
  } catch { /* silencioso */ }
}

inicializarConhecimento()


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
          showToast("Groq indisponível — usando Ollama como fallback", "info")
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
  ;["descricao","cargos","areas","conhecimento"].forEach(id => {
    document.getElementById("tab-"    + id).classList.toggle("active", aba === id)
    document.getElementById("painel-" + id).style.display = aba === id ? "flex" : "none"
  })
  if (aba === "areas")       renderizarListaAreas()
  if (aba === "cargos")      renderizarListaCargos()
  if (aba === "conhecimento") renderizarListaConhecimento()
}


// ═══════════════════════════════════════════════════════════════
//  GERENCIAR CARGOS
// ═══════════════════════════════════════════════════════════════

async function autoSalvarCargo(cargo, area, nivel, texto) {
  try {
    const res  = await fetch("/cargos", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ cargo, area, nivel, texto })
    })
    if (res.ok) {
      await res.json()
      await inicializarCargos()
      showToast("Cargo salvo automaticamente.", "info")
    }
  } catch { /* silencioso */ }
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
  document.getElementById("cargo-texto").value = c.texto

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
  if (!confirm(`Deletar "${c?.cargo}"? Esta ação não pode ser desfeita.`)) return

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
  if (!confirm(`Deletar a área "${areaEditando}"? Esta ação não pode ser desfeita.`)) return

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
      <span class="cargo-titulo">${a.ativo ? "●" : "○"} ${a.titulo}</span>
      <span class="cargo-meta">${a.categoria}</span>
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
  if (!confirm(`Deletar "${a?.titulo}"? Esta ação não pode ser desfeita.`)) return

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
  const wordmark = document.querySelector(".sp-wordmark")
  const delay    = ms => new Promise(r => setTimeout(r, ms))

  // ── Efeito glitch: letra por letra ───────────────────────────
  await new Promise(resolve => {
    const target       = "JoyDesc"
    const chars        = "!@#$%&?§±×÷ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    const glitchFrames = 9   // frames de caos por letra
    const snapFrame    = 7   // frame em que a letra trava
    const ms           = 42  // ms por frame
    const isJoy        = i => i < 3  // J o y

    let letterIdx    = 0
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

    const tick = setInterval(() => {
      frameInLetter++

      const snapping = frameInLetter >= snapFrame
      const activeChar = snapping ? target[letterIdx] : rand()

      if (frameInLetter >= glitchFrames) {
        letterIdx++
        frameInLetter = 0

        // reduz glitch nas últimas 2 letras
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

  // ── Mensagens de loading ──────────────────────────────────────
  const msgs = [
    { text: "Inicializando JoyDesc...",           pct: 14,  wait:   0 },
    { text: "Conectando ao Groq...",              pct: 34,  wait: 480 },
    { text: "Carregando base CBO 2002...",         pct: 60,  wait: 600 },
    { text: "11.097 ocupações indexadas ✓",        pct: 76,  wait: 520 },
    { text: "Carregando base de conhecimento...",  pct: 90,  wait: 480 },
    { text: "Sistema pronto ✓",                   pct: 100, wait: 480 },
  ]

  for (const { text, pct, wait } of msgs) {
    await delay(wait)
    msgEl.classList.add("sp-fading")
    await delay(160)
    msgEl.textContent = text
    barEl.style.width = pct + "%"
    msgEl.classList.remove("sp-fading")
  }

  await delay(700)
  splash.style.transition = "opacity 0.7s ease"
  splash.style.opacity    = "0"
  await delay(750)
  splash.remove()

  // inicia Groq como provider padrão (silencioso)
  setProvedor("groq", true)
})()
