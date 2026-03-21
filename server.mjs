// ═══════════════════════════════════════════════════════════════
//  JoyDescription – Servidor Principal (server.mjs)
//  Gerador de descrições de cargo com IA + base CBO oficial
// ═══════════════════════════════════════════════════════════════

// ── Dependências ──────────────────────────────────────────────
import express         from "express"
import cors            from "cors"
import dotenv          from "dotenv"
import fs              from "fs"
import path            from "path"
import { fileURLToPath } from "url"
import OpenAI          from "openai"

// ── Variáveis de ambiente (.env) ──────────────────────────────
// PORT:         porta do servidor (padrão: 3000)
// OLLAMA_URL:   endereço do Ollama local (padrão: http://localhost:11434)
// OLLAMA_MODEL: modelo a usar (padrão: qwen2.5 — melhor para português)
dotenv.config()

const __dirname   = path.dirname(fileURLToPath(import.meta.url))
const PORT        = process.env.PORT         || 3000
const OLLAMA_URL  = process.env.OLLAMA_URL   || "http://localhost:11434"
const MODEL       = process.env.OLLAMA_MODEL || "qwen2.5"

// ── Express + middlewares ──────────────────────────────────────
const app = express()
app.use(cors())                    // permite chamadas do frontend
app.use(express.json())            // interpreta body JSON
app.use(express.static(__dirname)) // serve index.html, style.css, script.js

// ── Cliente Ollama via SDK OpenAI-compatível ───────────────────
// O Ollama expõe uma API 100% compatível com OpenAI em /v1
// Não requer API key — roda 100% local, sem enviar dados para fora
const openai = new OpenAI({
  baseURL: `${OLLAMA_URL}/v1`,
  apiKey:  "ollama"              // campo obrigatório pelo SDK, ignorado pelo Ollama
})


// ═══════════════════════════════════════════════════════════════
//  BASE CBO — Carregada uma única vez na inicialização
//  Fonte: Classificação Brasileira de Ocupações 2002 (MTE)
//  Mantida em memória para buscas instantâneas sem I/O repetido
// ═══════════════════════════════════════════════════════════════

const cboBase = []

;(function carregarCBO() {
  const csvPath  = path.join(__dirname, "meta", "cargos_cbo_planilha.csv")
  const conteudo = fs.readFileSync(csvPath, "utf8")
  const linhas   = conteudo.split("\n")

  // Pula o cabeçalho (slice(1)) e indexa código + nome do cargo
  linhas.slice(1).forEach(linha => {
    if (!linha.trim()) return
    const cols = linha.split(",")
    if (cols[0] && cols[1]) {
      cboBase.push({
        codigo: cols[0].trim(),
        cargo:  cols[1].trim()
      })
    }
  })

  console.log(`✅ CBO carregado: ${cboBase.length} ocupações indexadas`)
})()


// ═══════════════════════════════════════════════════════════════
//  BUSCA CBO — Filtragem local em memória (sem IA, instantânea)
//  Prioriza cargos que começam com o termo antes dos que contêm
// ═══════════════════════════════════════════════════════════════

function buscarCBO(termo, limite = 15) {
  const t = termo.toLowerCase().trim()
  if (!t) return []

  const comecaCom = cboBase.filter(c =>  c.cargo.toLowerCase().startsWith(t))
  const contem    = cboBase.filter(c => !c.cargo.toLowerCase().startsWith(t)
                                     &&  c.cargo.toLowerCase().includes(t))

  return [...comecaCom, ...contem].slice(0, limite)
}


// ═══════════════════════════════════════════════════════════════
//  CONTEXTOS DE ÁREA — define o universo operacional de cada setor
//
//  REGRA FUNDAMENTAL: o mesmo cargo em setores diferentes são
//  funções completamente distintas. Um "Analista" no Armazém de
//  Açúcar opera em um universo industrial totalmente diferente
//  de um "Analista" de TI ou de RH. A ÁREA é o contexto primário
//  — o cargo é interpretado DENTRO desse universo.
// ═══════════════════════════════════════════════════════════════

const AREA_CONTEXTOS = {
  "TI": {
    label:    "Tecnologia da Informação",
    universo: `
O setor de TI desta empresa industrial é responsável por toda a infraestrutura tecnológica
da planta: redes, servidores, ERP (sistemas de gestão), suporte técnico a usuários
operacionais e administrativos, automação de processos, segurança da informação e
integração entre sistemas industriais (SCADA, CLP) e corporativos.
Os profissionais de TI aqui atuam em ambiente industrial 24/7, onde a indisponibilidade
de sistemas pode parar a produção. O contexto é híbrido: TI corporativa + TI industrial (OT).
Tecnologias comuns: ERP SAP/TOTVS, redes industriais, Windows Server, Active Directory,
backup, CFTV integrado, suporte remoto, LGPD.`
  },

  "Armazém de Açúcar": {
    label:    "Armazém de Açúcar",
    universo: `
O Armazém de Açúcar é o setor responsável pela recepção, armazenamento, controle de
qualidade e expedição do açúcar produzido pela usina — seja a granel ou ensacado.
É um ambiente industrial pesado, com operação contínua durante a safra.
Os profissionais deste setor lidam com: pesagem em balanças rodoviárias, laudos de
polarização (POL) e umidade do açúcar, controle de lotes e rastreabilidade,
gestão de estoque de produto acabado, programação de carregamento,
interface com transportadoras e clientes, controle sanitário e de qualidade (MAPA,
FSSC 22000, HACCP). Um "Analista" aqui é especialista em produto acabado e
processos logísticos do açúcar — não tem relação com análise de dados de TI.`
  },

  "RH": {
    label:    "Recursos Humanos",
    universo: `
O setor de RH desta empresa industrial é responsável pela gestão do ciclo completo
de pessoas em uma planta com trabalhadores safristas (temporários) e efetivos,
operando em turnos 24h.
Processos típicos: recrutamento e seleção operacional e administrativo, admissão e
demissão, folha de pagamento (cálculo de horas extras, adicional noturno, insalubridade,
periculosidade), eSocial, CIPA, SIPAT, PCMSO, PPRA/PGR, treinamentos NR (NR-10, NR-12,
NR-33, NR-35), controle de ponto eletrônico, benefícios (VT, VR, plano de saúde),
relações trabalhistas e sindicais.
O RH industrial tem demandas muito específicas de conformidade legal e saúde ocupacional.`
  },

  "CFTV": {
    label:    "CFTV – Segurança e Monitoramento",
    universo: `
O setor de CFTV (Circuito Fechado de TV) é responsável pela segurança patrimonial e
monitoramento eletrônico de toda a planta industrial e seus acessos.
Atividades típicas: operação de centrais de monitoramento com dezenas de câmeras IP,
controle de acesso de pessoas e veículos ( catracas), análise de imagens para prevenção e investigação de ocorrências,
rondas eletrônicas, gestão de alarmes, relatórios de ocorrências,
integração com portaria e segurança patrimonial.
Sistemas comuns: Intelbras, JFL, o que não tem importancia de fato.
Profissionais aqui são operadores ou analista de cftv que na prática é o técnico que dá manutenção em todo cftv
 — não de TI geral.`
  },

  "Financeiro": {
    label:    "Financeiro",
    universo: `
O setor Financeiro desta empresa industrial gerencia o fluxo financeiro completo da
operação: contas a pagar (fornecedores de insumos, manutenção, utilidades),
contas a receber (vendas de açúcar, etanol e energia), conciliação bancária,
tesouraria, gestão de caixa operacional, análise de DRE e fluxo de caixa,
faturamento (NF-e de produto acabado — açúcar e etanol),
SPED Fiscal e SPED Contábil, apuração de impostos (ICMS, PIS/COFINS, IPI),
relatórios gerenciais para diretoria, controle de custos industriais e rateio de centros
de custo. Sistemas comuns: SAP, TOTVS, Conta Azul, ou sistemas próprios de usina.`
  },

  "Almoxarifado Industrial": {
    label:    "Almoxarifado Industrial",
    universo: `
O Almoxarifado Industrial é o setor responsável pelo controle e disponibilização de
todos os materiais necessários à manutenção e operação da planta — peças sobressalentes,
ferramentas, lubrificantes, EPIs, materiais elétricos, hidráulicos e mecânicos.
Trata-se de um almoxarifado de MRO (Manutenção, Reparo e Operações), com
características distintas de um almoxarifado de produto acabado ou matéria-prima.
Atividades típicas: recebimento e conferência de materiais, cadastro de itens
(codificação, especificação técnica), controle de estoque por FIFO/FEFO,
atendimento de requisições de materiais (RM), inventário rotativo, gestão de
materiais críticos de parada, interface com Compras e Manutenção,
controle de EPIs por colaborador.
Sistemas comuns: SAP PM/MM, TOTVS, sistemas próprios de ERP industrial.`
  }
}


// ═══════════════════════════════════════════════════════════════
//  MONTADOR DE PROMPT
//
//  REGRAS IMUTÁVEIS:
//  1. O NOME DO CARGO é exatamente o que o usuário digitou.
//     A IA não renomeia, não sugere, não corrige.
//  2. A ÁREA é o contexto primário: define o universo operacional.
//     O mesmo cargo em setores diferentes = funções distintas.
//  3. A CBO é apenas correlação fraca — não dita o conteúdo.
//  4. Saída: Descrição SUMÁRIA (curta) + LONGA DETALHADA.
// ═══════════════════════════════════════════════════════════════

function montarPrompt(cargo, area, nivel, candidatos) {
  const ctx = AREA_CONTEXTOS[area]

  const contextoArea = ctx
    ? ctx.universo.trim()
    : `Setor especializado de uma usina sucroenergética. Considere as particularidades operacionais industriais deste setor.`

  // CBO apenas como referência correlata — não define o cargo
  const refCBO = candidatos.length > 0
    ? `Referência correlata CBO (uso informativo apenas, não define o cargo):\n` +
      candidatos.slice(0, 5).map(c => `  • ${c.codigo} – ${c.cargo}`).join("\n")
    : `Nenhuma referência CBO próxima encontrada.`

  return `Você é um especialista sênior em Recursos Humanos com 15 anos de experiência \
em usinas sucroenergéticas. Você elabora descrições de cargo aderentes à realidade \
operacional do setor informado.

════════════════════════════════════════════════════════
REGRAS ABSOLUTAS
════════════════════════════════════════════════════════
1. O nome do cargo é "${cargo}". Não renomeie. Não sugira outro nome. Não corrija.
   Use exatamente: "${cargo}".

2. O setor "${area}" é o contexto primário. Todas as responsabilidades, ferramentas,
   normas e KPIs devem ser específicos deste setor em uma usina.

3. A CBO é apenas referência correlata. Não a use para definir o cargo.

4. Gere DUAS descrições no formato exato abaixo.
   Comece direto no "---". Nenhum texto antes disso.
════════════════════════════════════════════════════════

## CONTEXTO DO SETOR: ${area.toUpperCase()} — USINA SUCROENERGÉTICA

${contextoArea}

## Cargo

- Nome: ${cargo}
- Setor: ${area}
- Nível: ${nivel}

${refCBO}

---

# ${cargo}
**Setor:** ${area} | **Nível:** ${nivel}

---

## Descrição Sumária

[Parágrafo único de 3 a 5 linhas. Descreva o papel deste profissional no setor ${area} \
desta usina: o que faz, seu impacto operacional e perfil essencial. \
Texto corrido, sem bullet points, direto e profissional.]

---

## Descrição Longa Detalhada

### 🎯 Missão do Cargo

[Uma frase que define o propósito deste cargo dentro do setor ${area}.]

### 📋 Responsabilidades Principais

- [Responsabilidade concreta e específica do setor ${area} — verbo no infinitivo]
- [Responsabilidade 2 — real, própria deste setor, não genérica]
- [Responsabilidade 3]
- [Responsabilidade 4]
- [Responsabilidade 5]
- [Responsabilidade 6]
- [Responsabilidade 7]

### 🛠️ Requisitos Técnicos

- [Ferramenta, sistema, equipamento ou norma usada no setor ${area}]
- [Conhecimento técnico específico da operação deste setor]
- [Certificação ou formação técnica relevante para este contexto]
- [Experiência com processos reais do setor ${area}]
- [Requisito adicional condizente com o nível ${nivel}]

### 🤝 Competências Comportamentais

- [Competência adequada ao ambiente operacional do setor ${area} e nível ${nivel}]
- [Competência 2]
- [Competência 3]
- [Competência 4]
- [Competência 5]

### 🎓 Formação e Experiência

- **Formação mínima:** [grau e curso relevante para o setor ${area}]
- **Experiência:** [tempo e tipo esperados para nível ${nivel} neste setor]
- **Diferencial:** [qualificação que destaca o candidato dentro do setor]

### 📊 Indicadores de Sucesso (KPIs)

- [KPI mensurável e específico do setor ${area}]
- [KPI 2 — operacional ou de qualidade]
- [KPI 3]

---`
}


// ═══════════════════════════════════════════════════════════════
//  ROTAS DA API
// ═══════════════════════════════════════════════════════════════

// ── GET /health — verifica se o servidor está rodando ─────────
// Útil para monitoramento e para o frontend checar conectividade
app.get("/health", async (_req, res) => {
  // Verifica se o Ollama está respondendo
  let ollamaOk = false
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`)
    ollamaOk = r.ok
  } catch { /* Ollama offline */ }

  res.json({
    status:      "ok",
    cbo_ocupacoes: cboBase.length,
    ollama_url:  OLLAMA_URL,
    modelo:      MODEL,
    ollama_ok:   ollamaOk
  })
})

// ── GET /sugestoes?q= — autocomplete para o frontend ──────────
// Retorna até 10 cargos CBO que começam com o parâmetro "q"
// Usado pelo campo de cargo para sugestões em tempo real
app.get("/sugestoes", (req, res) => {
  const { q = "" } = req.query
  if (q.length < 2) return res.json([])

  const resultados = cboBase
    .filter(c => c.cargo.toLowerCase().startsWith(q.toLowerCase()))
    .slice(0, 10)
    .map(c => ({ codigo: c.codigo, cargo: c.cargo }))

  res.json(resultados)
})

// ── POST /gerar — gera descrição com streaming (SSE) ──────────
// Usa Server-Sent Events para transmitir a resposta token a token
// O frontend lê o stream e exibe o texto conforme vai chegando
app.post("/gerar", async (req, res) => {
  const { cargo, area, nivel } = req.body

  if (!cargo?.trim() || !area || !nivel) {
    return res.status(400).json({ erro: "Campos obrigatórios: cargo, area, nivel" })
  }

  // Configura cabeçalhos SSE — mantém conexão aberta para streaming
  res.setHeader("Content-Type",  "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection",    "keep-alive")
  res.flushHeaders()

  try {
    const candidatos = buscarCBO(cargo)
    const prompt     = montarPrompt(cargo, area, nivel, candidatos)

    // Chama Ollama com streaming ativado (stream: true)
    // Cada fragmento (token) é enviado imediatamente ao cliente
    const stream = await openai.chat.completions.create({
      model:       MODEL,
      stream:      true,
      temperature: 0.4,    // menor temperatura = maior aderência ao formato exigido
      messages: [
        {
          role:    "system",
          content: "Você é um especialista sênior em RH e CBO. Escreva descrições de cargo precisas, estruturadas e adequadas ao mercado de trabalho brasileiro. Siga exatamente o formato solicitado, sem adicionar texto fora do template."
        },
        { role: "user", content: prompt }
      ]
    })

    // Envia cada fragmento como evento SSE individual
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ""
      if (delta) {
        res.write(`data: ${JSON.stringify({ texto: delta })}\n\n`)
      }
    }

    // Sinaliza ao frontend que a geração terminou
    res.write(`data: ${JSON.stringify({ fim: true })}\n\n`)
    res.end()

  } catch (err) {
    console.error("❌ Erro Ollama:", err.message)
    res.write(`data: ${JSON.stringify({ erro: err.message })}\n\n`)
    res.end()
  }
})


// ═══════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🚀 JoyDescription → http://localhost:${PORT}`)
  console.log(`🦙 Ollama:  ${OLLAMA_URL}`)
  console.log(`🤖 Modelo:  ${MODEL}`)
  console.log(`💡 Dica: defina OLLAMA_MODEL=llama3 no .env para trocar o modelo\n`)
})
