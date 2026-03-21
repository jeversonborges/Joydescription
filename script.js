// ═══════════════════════════════════════════════════════════════
//  JoyDescription — Script do Frontend (script.js)
//  Responsável por: autocomplete via API, geração com streaming,
//  renderização do resultado em markdown, copiar e baixar texto
// ═══════════════════════════════════════════════════════════════


// ── Estado global ──────────────────────────────────────────────
let textoGerado  = ""     // acumula o texto bruto durante o streaming
let isGenerating = false  // impede cliques duplos durante a geração


// ── Referências DOM — capturadas uma vez para performance ───────
const cargoInput  = document.getElementById("cargoInput")
const listaCargos = document.getElementById("listaCargos")
const resultado   = document.getElementById("resultado")
const placeholder = document.getElementById("resultado_placeholder")
const loadingEl   = document.getElementById("loading_state")
const statusDot   = document.getElementById("status_dot")
const cboBadge    = document.getElementById("cbo_badge")
const cboBadgeText= document.getElementById("cbo_badge_text")
const btnGerar    = document.getElementById("btn_gerar")


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

function renderMarkdown(texto) {
  return texto
    .replace(/&/g,              "&amp;")
    .replace(/</g,              "&lt;")
    .replace(/>/g,              "&gt;")
    // Títulos ###
    .replace(/^### (.+)$/gm,   "<h3>$1</h3>")
    // Negrito **texto**
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Separador ---
    .replace(/^---$/gm,        "<hr>")
    // Bullet points: • ou -
    .replace(/^[•\-] (.+)$/gm, "<li>$1</li>")
    // Itálico *texto*
    .replace(/\*(.+?)\*/g,     "<em>$1</em>")
    // Quebras de parágrafo
    .replace(/\n\n/g,          "<br><br>")
    .replace(/\n/g,            "<br>")
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

  // ── Prepara a tela para o estado de geração ──────────────────
  isGenerating           = true
  textoGerado            = ""
  btnGerar.disabled      = true
  placeholder.style.display  = "none"
  resultado.style.display    = "none"
  resultado.textContent      = ""
  resultado.className        = "resultado_content"
  cboBadge.style.display     = "none"
  loadingEl.style.display    = "flex"
  listaCargos.style.display  = "none"
  setStatus("loading")

  try {
    // ── Inicia a requisição com streaming ────────────────────────
    const response = await fetch("/gerar", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ cargo, area, nivel })
    })

    if (!response.ok) throw new Error(`Servidor retornou ${response.status}`)

    // Lê o corpo como stream binário e decodifica UTF-8
    const reader  = response.body.getReader()
    const decoder = new TextDecoder()
    let   buffer  = ""
    let   primeiro = true

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Processa todas as linhas completas do buffer SSE
      const linhas = buffer.split("\n")
      buffer = linhas.pop() // guarda linha incompleta para o próximo ciclo

      for (const linha of linhas) {
        if (!linha.startsWith("data: ")) continue

        let data
        try { data = JSON.parse(linha.slice(6)) } catch { continue }

        // Evento: fragmento de texto da IA chegando
        if (data.texto) {
          // Exibe o painel de resultado ao receber o primeiro token
          if (primeiro) {
            loadingEl.style.display = "none"
            resultado.style.display = "block"
            resultado.className     = "resultado_content streaming"
            setStatus("streaming")
            primeiro = false
          }
          textoGerado           += data.texto
          resultado.textContent  = textoGerado
          // Rola automaticamente para o final do texto
          resultado.scrollTop    = resultado.scrollHeight
        }

        // Evento: erro reportado pelo servidor durante a geração
        if (data.erro) throw new Error(data.erro)

        // Evento: stream concluído — renderiza o markdown final
        if (data.fim) {
          resultado.innerHTML = renderMarkdown(textoGerado)
          resultado.className = "resultado_content"
          setStatus("done")
          showToast("Descrição gerada com sucesso!", "success")
        }
      }
    }

  } catch (err) {
    console.error("Erro:", err)
    setStatus("error")
    loadingEl.style.display    = "none"
    resultado.style.display    = "block"
    resultado.textContent      = `Erro: ${err.message}\n\nVerifique se o servidor está rodando e se o Ollama está ativo em http://localhost:11434`
    showToast("Erro ao gerar descrição.", "error")

  } finally {
    isGenerating      = false
    btnGerar.disabled = false
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
