// ═══════════════════════════════════════════════════════════════
//  JoyDescription – Servidor Principal (server.mjs)
//  Gerador de descrições de cargo com IA + base CBO oficial
//  Persistência: SQLite via better-sqlite3 (joydescription.db)
// ═══════════════════════════════════════════════════════════════

import express           from "express"
import cors              from "cors"
import dotenv            from "dotenv"
import fs                from "fs"
import path              from "path"
import { fileURLToPath } from "url"
import OpenAI            from "openai"
import Database          from "better-sqlite3"

dotenv.config()

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const PORT        = process.env.PORT         || 3000
const OLLAMA_URL  = process.env.OLLAMA_URL   || "http://localhost:11434"
const MODEL       = process.env.OLLAMA_MODEL || "qwen2.5"
const GROQ_KEY    = process.env.GROQ_API_KEY || ""
const GROQ_MODEL  = process.env.GROQ_MODEL   || "llama-3.3-70b-versatile"

// ── Express ────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(__dirname))
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")))


// ═══════════════════════════════════════════════════════════════
//  BANCO DE DADOS — SQLite
//  Um único arquivo .db substitui os três JSONs anteriores.
//  WAL mode garante leituras sem bloquear escritas e vice-versa.
//  Sem risco de corrupção por crash ou reinício do processo.
// ═══════════════════════════════════════════════════════════════

const db = new Database(process.env.JOY_DB_PATH || path.join(__dirname, "joydescription.db"))
db.pragma("journal_mode = WAL")
db.pragma("synchronous = NORMAL")

db.exec(`
  CREATE TABLE IF NOT EXISTS areas (
    key      TEXT PRIMARY KEY,
    label    TEXT NOT NULL,
    universo TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cargos (
    id        TEXT PRIMARY KEY,
    cargo     TEXT NOT NULL,
    area      TEXT DEFAULT '',
    nivel     TEXT DEFAULT '',
    texto     TEXT NOT NULL,
    criadoEm  TEXT NOT NULL,
    editadoEm TEXT
  );

  CREATE TABLE IF NOT EXISTS conhecimento (
    id        TEXT PRIMARY KEY,
    titulo    TEXT NOT NULL,
    categoria TEXT DEFAULT 'Geral',
    ativo     INTEGER DEFAULT 1,
    conteudo  TEXT NOT NULL,
    criadoEm  TEXT NOT NULL,
    editadoEm TEXT
  );
`)

// ── Migração única: importa JSONs antigos para o banco ─────────
// Roda apenas uma vez — se a tabela já tiver dados, pula.
;(function migrar() {
  function importar(tabela, arquivo, inserir) {
    if (db.prepare(`SELECT COUNT(*) as n FROM ${tabela}`).get().n > 0) return
    const fp = path.join(__dirname, arquivo)
    if (!fs.existsSync(fp)) return
    try {
      const dados = JSON.parse(fs.readFileSync(fp, "utf8"))
      db.transaction(() => dados.forEach(inserir))()
      console.log(`✅ Migrado: ${dados.length} registros de ${arquivo} → ${tabela}`)
    } catch (e) {
      console.warn(`⚠️  Falha ao migrar ${arquivo}: ${e.message}`)
    }
  }

  importar("areas", "areas.json", a =>
    db.prepare("INSERT OR IGNORE INTO areas VALUES (?,?,?)").run(a.key, a.label, a.universo))

  importar("cargos", "cargos.json", c =>
    db.prepare("INSERT OR IGNORE INTO cargos (id,cargo,area,nivel,texto,criadoEm) VALUES (?,?,?,?,?,?)").run(
      c.id, c.cargo, c.area||"", c.nivel||"", c.texto, c.criadoEm||new Date().toISOString()))

  importar("conhecimento", "conhecimento.json", a =>
    db.prepare("INSERT OR IGNORE INTO conhecimento (id,titulo,categoria,ativo,conteudo,criadoEm) VALUES (?,?,?,?,?,?)").run(
      a.id, a.titulo, a.categoria||"Geral", a.ativo?1:0, a.conteudo, a.criadoEm||new Date().toISOString()))
})()


// ── Cliente Ollama via SDK OpenAI-compatível ───────────────────
const ollamaClient = new OpenAI({ baseURL: `${OLLAMA_URL}/v1`, apiKey: "ollama" })
const groqClient   = new OpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey: GROQ_KEY })


// ═══════════════════════════════════════════════════════════════
//  BASE CBO — carregada na inicialização, mantida em memória
// ═══════════════════════════════════════════════════════════════

const cboBase = []

;(function carregarCBO() {
  const csvPath  = path.join(__dirname, "meta", "cargos_cbo_planilha.csv")
  const conteudo = fs.readFileSync(csvPath, "utf8")
  conteudo.split("\n").slice(1).forEach(linha => {
    if (!linha.trim()) return
    const cols = linha.split(",")
    if (cols[0] && cols[1]) cboBase.push({ codigo: cols[0].trim(), cargo: cols[1].trim() })
  })
  console.log(`✅ CBO carregado: ${cboBase.length} ocupações indexadas`)
})()


// ═══════════════════════════════════════════════════════════════
//  BUSCA CBO
// ═══════════════════════════════════════════════════════════════

const STOP = new Set([
  "para","com","que","são","dos","das","uma","uns","umas","nos","nas",
  "sua","seu","seus","suas","este","esta","esse","essa","esses","estas",
  "onde","como","pelo","pela","pelos","pelas","entre","sobre","após",
  "processo","processos","atividade","atividades","sistema","sistemas",
  "empresa","indústria","setor","área","cargo","função","nível"
])

function extrairTermos(texto, minLen = 5) {
  return texto
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= minLen && !STOP.has(w))
}

function buscarCBO(cargo, areaKey = "", limite = 25) {
  const ctx      = db.prepare("SELECT universo FROM areas WHERE key = ?").get(areaKey)
  const universo = ctx?.universo || ""

  const termosCargoRaw  = cargo.toLowerCase().trim().split(/\s+/).filter(t => t.length >= 3)
  const termosCargoNorm = extrairTermos(cargo, 3)
  const termosArea      = extrairTermos(universo, 5).slice(0, 40)

  const scores = new Map()

  cboBase.forEach(c => {
    const nome     = c.cargo.toLowerCase()
    const nomeNorm = nome.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z\s]/g," ")
    let score = 0

    termosCargoRaw.forEach((t, i) => {
      if (nome.startsWith(t))    score += i === 0 ? 8 : 4
      else if (nome.includes(t)) score += i === 0 ? 5 : 2
    })

    termosArea.forEach(t => { if (nomeNorm.includes(t)) score += 1 })

    if (score > 0 && termosCargoNorm.length > 0) {
      const temRelacao = termosCargoNorm.some(t => nomeNorm.includes(t))
      if (!temRelacao && score < 2) return
    }

    if (score > 0) scores.set(c, score)
  })

  const resultado = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limite)
    .map(([c]) => c)

  if (resultado.length < 8) {
    const t = termosCargoRaw[0] || ""
    cboBase
      .filter(c => c.cargo.toLowerCase().includes(t) && !resultado.includes(c))
      .slice(0, limite - resultado.length)
      .forEach(c => resultado.push(c))
  }

  return resultado
}


// ═══════════════════════════════════════════════════════════════
//  MONTADOR DE PROMPT
// ═══════════════════════════════════════════════════════════════

const NIVEL_DEF = {
  "Estágio":
`PERFIL: Estudante universitário em formação, sem experiência profissional anterior. Atua exclusivamente sob supervisão direta e constante de um responsável designado. Zero autonomia decisória.

FRONTEIRA LEGAL CRÍTICA — NUNCA inclua nas FUNCOES de Estágio:
- Qualquer função que implique decisão independente, mesmo técnica
- Responsabilidade por resultado de processo ou equipamento
- Assinar, emitir ou validar qualquer tipo de documento oficial
- Coordenar, orientar ou supervisionar outras pessoas
- Representar a empresa interna ou externamente
- Acessar ou operar sistemas com impacto financeiro ou legal
(Violação dessas regras pode invalidar o contrato de estágio pela Lei 11.788/2008)

VERBOS PERMITIDOS: auxiliar, apoiar, acompanhar, observar, registrar sob supervisão, participar, aprender, colaborar, organizar sob orientação.
EXEMPLOS CORRETOS: "Auxiliar na coleta de amostras sob supervisão do analista responsável", "Apoiar o lançamento de dados no sistema conforme roteiro definido".
EXEMPLOS PROIBIDOS: "Realizar análises", "Operar equipamentos", "Elaborar relatórios" (qualquer função sem "sob supervisão" ou "auxiliar").`,

  "Trainee":
`PERFIL: Profissional recém-formado (0–1 ano), inserido em programa estruturado de desenvolvimento. Executa atividades reais, mas com validação constante do superior. Ainda não toma decisões de forma independente.

FRONTEIRA LEGAL CRÍTICA — NUNCA inclua nas FUNCOES de Trainee:
- Coordenar, supervisionar ou orientar formalmente outras pessoas
- Assinar documentos com valor legal, técnico ou fiscal
- Tomar decisões que impactem processos, equipamentos ou pessoas
- Negociar com fornecedores, clientes ou parceiros externos
- Aprovar compras, requisições ou despesas de qualquer valor
- Representar a empresa em reuniões externas sem acompanhamento

VERBOS PERMITIDOS: executar conforme orientação, apoiar, participar de, acompanhar, elaborar sob revisão, contribuir, registrar, seguir procedimentos.
EXEMPLOS CORRETOS: "Executar análises laboratoriais conforme metodologia estabelecida e revisão do supervisor", "Participar do processo de manutenção preventiva sob orientação do técnico responsável".
EXEMPLOS PROIBIDOS: "Analisar e propor soluções", "Coordenar atividades", "Representar a área".`,

  "Junior":
`PERFIL: Profissional com até 3 anos de experiência na função. Executa tarefas bem definidas seguindo procedimentos, checklists e instruções de trabalho estabelecidos. Requer supervisão periódica. Reporta desvios e problemas ao superior — não os resolve de forma autônoma.

FRONTEIRA LEGAL CRÍTICA — NUNCA inclua nas FUNCOES de Junior:
- Coordenar, supervisionar ou ser responsável formal por outras pessoas (configura cargo de confiança — CLT art. 62 II, abrindo passivo trabalhista de horas extras)
- Assinar documentos com efeito legal, fiscal, técnico ou de qualidade (laudos, ARTs, notas fiscais, contratos, certificados)
- Aprovar, liberar ou rejeitar processos, produtos ou serviços de forma autônoma
- Negociar ou tomar decisões que envolvam recursos financeiros da empresa
- Definir, alterar ou homologar procedimentos, normas ou padrões
- Representar a área ou a empresa em contextos externos ou interdepartamentais formais

VERBOS PERMITIDOS: executar, realizar, verificar conforme procedimento, registrar, monitorar, reportar ao responsável, seguir instruções, operar conforme manual, coletar, organizar, controlar rotinas definidas.
EXEMPLOS CORRETOS: "Executar inspeções de equipamentos conforme checklist e registrar ocorrências no sistema", "Monitorar parâmetros de processo e reportar desvios ao operador sênior".
EXEMPLOS PROIBIDOS: "Coordenar turno", "Aprovar liberação de produto", "Assinar laudos", "Definir parâmetros de processo", "Gerenciar fornecedores".`,

  "Pleno":
`PERFIL: Profissional com 3 a 6 anos de experiência. Autônomo na execução das suas atividades — entrega sem precisar de supervisão constante. Identifica e resolve problemas comuns do dia a dia sem escalação. Propõe melhorias pontuais dentro do seu escopo. Pode orientar tecnicamente profissionais Júnior como par técnico, NÃO como gestor formal.

FRONTEIRA LEGAL CRÍTICA — NUNCA inclua nas FUNCOES de Pleno:
- Coordenar, supervisionar ou ser responsável hierárquico por pessoas (mesmo que oriente tecnicamente, não tem poder disciplinar — mantém-se fora do art. 62 II da CLT)
- Assinar documentos com responsabilidade legal, fiscal ou técnica que implique resposta pessoal (contratos, ARTs, laudos periciais, documentos junto a órgãos reguladores)
- Aprovar formalmente processos críticos ou liberar produtos/serviços com impacto regulatório
- Negociar condições comerciais, valores ou prazos com fornecedores ou clientes
- Tomar decisões de compra ou gasto sem alçada formal definida pela empresa

PODE (diferença do Junior):
- Resolver problemas técnicos de média complexidade de forma autônoma
- Propor alterações de procedimento (não homologa — encaminha para aprovação)
- Orientar tecnicamente juniores e estagiários como referência técnica do par, sem poder de avaliação formal
- Elaborar relatórios técnicos internos e análises de desempenho do processo

VERBOS PERMITIDOS: analisar, identificar, propor, monitorar indicadores, desenvolver, elaborar relatórios internos, otimizar, orientar tecnicamente, diagnosticar problemas de média complexidade, apoiar decisões técnicas.
EXEMPLOS CORRETOS: "Analisar falhas recorrentes em equipamentos e propor soluções corretivas ao supervisor", "Orientar tecnicamente operadores juniores na execução de procedimentos complexos".
EXEMPLOS PROIBIDOS: "Coordenar equipe de turno", "Aprovar liberação de lote", "Assinar laudo técnico", "Negociar com fornecedor".`,

  "Senior":
`PERFIL: Profissional com mais de 6 anos de experiência. A distinção fundamental do Senior não é apenas maior autonomia — é que ele DEFINE e PADRONIZA processos, onde o Pleno apenas os EXECUTA. É a referência técnica máxima da área sem poder de gestão. Diagnostica falhas complexas, lidera projetos técnicos e desenvolve outros profissionais formalmente. Participa de decisões técnicas estratégicas. NÃO é gestor — não tem subordinados formais, não avalia, não contrata, não demite.

FRONTEIRA LEGAL CRÍTICA — NUNCA inclua nas FUNCOES de Senior:
- Coordenar, supervisionar ou ser responsável hierárquico por pessoas (a orientação técnica que o Senior exerce é de referência, não de chefia — manter fora do art. 62 II da CLT evita passivo trabalhista)
- Assinar contratos comerciais, documentos societários ou instrumentos que representem a empresa juridicamente (exceto responsabilidade técnica com registro profissional — CREA, CRM, CRC — que deve ser explicitada como "assinar ART/RRT" apenas quando o cargo exigir tal habilitação)
- Aprovar despesas ou compras fora da alçada operacional técnica
- Demitir, contratar ou aplicar medidas disciplinares
- Negociar condições contratuais com fornecedores ou clientes (pode participar tecnicamente, nunca decide)

PODE (diferença do Pleno):
- DEFINIR procedimentos, padrões e critérios técnicos (não apenas propor)
- VALIDAR e APROVAR entregas técnicas de Plenos e Juniores
- LIDERAR projetos técnicos (sem gestão de pessoas — gestão de escopo e entrega técnica)
- ELABORAR E MINISTRAR treinamentos formais para a equipe
- REPRESENTAR a área em fóruns técnicos internos e externos (sem assinar contratos)
- HOMOLOGAR processos, parâmetros e especificações técnicas dentro do seu domínio

VERBOS PERMITIDOS: definir, estruturar, padronizar, diagnosticar, liderar tecnicamente, validar, homologar, elaborar e ministrar treinamentos, estabelecer critérios, revisar e aprovar entregas técnicas, representar tecnicamente a área.
EXEMPLOS PROIBIDOS: "Coordenar equipe", "Aprovar orçamento", "Negociar contratos", "Demitir ou contratar".`,

  "Especialista":
`PERFIL: Domínio técnico profundo e reconhecido em uma especialidade específica. Ponto focal da empresa no tema — é consultado por todas as áreas e pela gestão. Autonomia total dentro da especialidade. Influencia decisões estratégicas através de parecer técnico. NÃO é gestor de pessoas.

FRONTEIRA LEGAL:
- Pode assinar documentos técnicos dentro da sua especialidade SE possuir registro profissional habilitante (CREA, CRM, CRC etc.) — deve ser explicitado no requisito do cargo
- Não assina contratos comerciais, documentos societários nem representa juridicamente a empresa
- Não coordena, supervisiona nem tem subordinados formais

VERBOS PERMITIDOS: definir padrões técnicos, auditar, certificar, assessorar, conduzir pesquisas, implementar metodologias, emitir pareceres técnicos, validar projetos, estabelecer requisitos técnicos, representar a empresa em fóruns especializados.`,

  "Coordenador":
`PERFIL: Primeiro nível de liderança formal com subordinados diretos. Responde pelos resultados operacionais da equipe perante a gerência. Tem poder disciplinar dentro das políticas da empresa. Enquadra-se como CARGO DE CONFIANÇA (CLT art. 62, II) — diferenciado por padrão salarial superior e fidúcia do empregador.

OBRIGAÇÕES LEGAIS DO CARGO:
- As FUNCOES DEVEM conter gestão de pessoas (é o que juridicamente justifica o enquadramento como cargo de confiança e a isenção de controle de jornada)
- Sem funções claras de gestão, o enquadramento pode ser contestado em reclamatória trabalhista

FUNCOES OBRIGATÓRIAS: coordenar equipe e distribuir atividades, definir e acompanhar metas e indicadores da equipe, avaliar desempenho e dar feedback, reportar resultados à gerência, participar de processos seletivos para a equipe, gerir conflitos e clima da equipe.
PODE TAMBÉM: aprovar requisições operacionais dentro da alçada definida, representar a área em reuniões interdepartamentais, validar procedimentos operacionais da equipe.`,

  "Gerente":
`PERFIL: Liderança de área com autonomia estratégica, orçamentária e de pessoas. Gerencia coordenadores e responde pela área perante a diretoria. Cargo de confiança pleno (CLT art. 62, II). Pode ter poderes de representação definidos por procuração.

FUNCOES OBRIGATÓRIAS: definir estratégia e metas da área alinhadas à diretoria, gerir orçamento da área (planejar, controlar e reportar), liderar e desenvolver coordenadores, tomar decisões de contratação e desligamento dentro da área, representar a área em instâncias internas e externas, responder por indicadores estratégicos da área.
PODE TAMBÉM: assinar contratos operacionais dentro da alçada definida pela empresa, representar a empresa em negociações dentro do seu escopo, homologar políticas e procedimentos da área.`,

  "Diretor":
`PERFIL: Liderança executiva com visão de longo prazo e responsabilidade pelo desempenho estratégico de uma diretoria ou unidade de negócio. Responde ao conselho ou CEO. Representa a empresa em alto nível.

FUNCOES OBRIGATÓRIAS: definir a direção estratégica da diretoria e garantir alinhamento com os objetivos corporativos, gerir o orçamento da diretoria com autonomia decisória, liderar gerentes e responder pelo desenvolvimento da liderança, representar a empresa em negociações de alto impacto, tomar decisões de investimento e alocação de recursos, reportar resultados ao conselho de administração ou CEO.
PODE TAMBÉM: assinar contratos de grande porte dentro dos poderes outorgados, definir políticas corporativas da diretoria, representar a empresa perante órgãos reguladores.`
}

const TIPO_CTX = {
  "Operacional":
    `Atuação: presença física na planta industrial, campo, chão de fábrica ou área produtiva. NÃO é trabalho de escritório.
Regime: pode incluir turnos (manhã/tarde/noite), trabalho aos finais de semana em safra, uso obrigatório de EPIs.
Impacto nas FUNCOES — as atividades DEVEM referenciar:
  - Operação direta de equipamentos, máquinas ou sistemas físicos da usina
  - Monitoramento de parâmetros em campo (não em tela de escritório)
  - Inspeções físicas, rondas, verificações presenciais
  - Registros em ordens de serviço, planilhas de turno ou formulários operacionais
  - Cumprimento de procedimentos operacionais padrão (POP/IT) e normas de segurança
Verbos típicos: operar, monitorar em campo, executar manutenção, vistoriar, inspecionar, registrar em OS, seguir procedimentos de segurança, utilizar EPIs, realizar rondas.
PROIBIDO nas FUNCOES de Operacional: "elaborar relatórios gerenciais", "participar de reuniões de alinhamento", "gerenciar no ERP". Esses são atributos Administrativos.`,

  "Administrativo":
    `Atuação: ambiente de escritório, backoffice, sala de reunião. NÃO há presença regular na planta ou campo.
Regime: horário comercial, sem turnos, sem necessidade de EPI.
Impacto nas FUNCOES — as atividades DEVEM referenciar:
  - Uso de sistemas informatizados (ERP, Excel, BI, sistemas internos)
  - Elaboração e análise de relatórios, indicadores, planilhas
  - Gestão de documentos, contratos, processos e fluxos administrativos
  - Comunicação escrita e verbal com áreas internas e fornecedores/clientes
  - Participação em reuniões, alinhamentos e apresentações
Verbos típicos: elaborar relatórios, analisar dados, controlar prazos, emitir documentos, gerenciar no sistema, realizar reuniões, estruturar processos, atender demandas internas.
PROIBIDO nas FUNCOES de Administrativo: "operar equipamentos", "realizar inspeções em campo", "utilizar EPIs". Esses são atributos Operacionais.`,

  "Híbrido":
    `Atuação: o profissional divide seu tempo entre escritório e planta/campo. Não é 100% de cada — é genuinamente os dois.
Impacto nas FUNCOES — a lista DEVE conter obrigatoriamente os dois mundos:
  PARTE OPERACIONAL (mínimo 3 itens): presença em campo, contato com equipamentos ou processos físicos, inspeções, acompanhamento de operação, interface com equipe técnica na planta.
  PARTE ADMINISTRATIVA (mínimo 3 itens): sistemas, relatórios, análises, documentação, reuniões, indicadores.
ERRO COMUM A EVITAR: gerar uma lista 100% administrativa com um único item genérico de "acompanhar operação". O cargo Híbrido tem peso real em campo E em escritório — isso deve ser visível nas funções.`
}

// ── Resumos curtos para modelos pequenos ───────────────────────
const NIVEL_CURTO = {
  "Estágio":      "aprendizado supervisionado, sem autonomia, sem decisão própria",
  "Trainee":      "recém-formado, executa com validação constante do superior",
  "Junior":       "até 3 anos de experiência, segue procedimentos, supervisão regular",
  "Pleno":        "3 a 6 anos, executa com autonomia, propõe melhorias, orienta tecnicamente pares",
  "Senior":       "6+ anos, define padrões técnicos, referência máxima da área, lidera projetos técnicos",
  "Especialista": "domínio profundo de especialidade, ponto focal consultivo, sem subordinados",
  "Coordenador":  "primeiro nível de liderança formal — DEVE ter funções de gestão de equipe",
  "Gerente":      "liderança de área com orçamento e decisão de pessoas",
  "Diretor":      "liderança executiva, estratégia, decisões de alto impacto",
}

const TIPO_CURTO = {
  "Operacional":    "campo/planta/equipamentos — sem escritório. Verbos: operar, monitorar, inspecionar, executar manutenção.",
  "Administrativo": "escritório/sistemas — sem campo. Verbos: elaborar, analisar, controlar, emitir, gerenciar no sistema.",
  "Híbrido":        "campo E escritório — obrigatoriamente os dois. Mínimo 4 funções de campo e 4 de escritório.",
}

// Prompt ultra-enxuto para Ollama — modelos pequenos perdem o fio em prompts longos
function montarPromptOllamaGen(cargo, area, nivel, tipo, candidatos) {
  const ctx = db.prepare("SELECT * FROM areas WHERE key = ?").get(area)
  const contextoArea = ctx?.universo?.slice(0, 300) || `Setor de uma usina sucroenergética.`
  const nivelRes = NIVEL_CURTO[nivel] || nivel
  const tipoRes  = TIPO_CURTO[tipo]  || tipo
  const isLider  = ["Coordenador","Gerente","Diretor"].includes(nivel)
  const regraLider = isLider
    ? "OBRIGATÓRIO: incluir funções de gestão de equipe, metas e reporte hierárquico."
    : "PROIBIDO: coordenar, liderar ou gerenciar pessoas."
  const listaCBO = candidatos.slice(0, 5).map(c => `${c.codigo} – ${c.cargo}`).join("\n") || "Sem referências."

  return `CARGO: ${cargo}
SETOR: ${area}
NIVEL: ${nivel} — ${nivelRes}
TIPO: ${tipo} — ${tipoRes}
CONTEXTO DO SETOR: ${contextoArea}

REGRA ABSOLUTA: Esta descrição é do setor ${area}. PROIBIDO qualquer outro setor.
${regraLider}

Escreva apenas o conteúdo abaixo, sem introduções:

DESCRICAO DO CARGO
[3 frases sobre propósito do cargo de ${cargo} no setor ${area}]

FUNCOES
- [verbo infinitivo + ação concreta do setor ${area}]
[escreva 9 itens totais]

INDICACAO DE CBOS
[escolha 2 itens da lista]
${listaCBO}
`
}

function montarPromptOllamaDet(cargo, area, nivel, tipo, candidatos) {
  const ctx = db.prepare("SELECT * FROM areas WHERE key = ?").get(area)
  const contextoArea = ctx?.universo?.slice(0, 300) || `Setor de uma usina sucroenergética.`
  const nivelRes = NIVEL_CURTO[nivel] || nivel
  const tipoRes  = TIPO_CURTO[tipo]  || tipo
  const isLider  = ["Coordenador","Gerente","Diretor"].includes(nivel)
  const regraLider = isLider
    ? "OBRIGATÓRIO: funções de gestão de equipe, metas e reporte hierárquico."
    : "PROIBIDO: coordenar, liderar ou gerenciar pessoas."
  const listaCBO = candidatos.slice(0, 5).map(c => `${c.codigo} – ${c.cargo}`).join("\n") || "Sem referências."

  return `CARGO: ${cargo}
SETOR: ${area}
NIVEL: ${nivel} — ${nivelRes}
TIPO: ${tipo} — ${tipoRes}
CONTEXTO DO SETOR: ${contextoArea}

REGRA ABSOLUTA: Esta descrição é do setor ${area}. PROIBIDO qualquer outro setor.
${regraLider}

Escreva apenas o conteúdo abaixo, sem introduções:

MISSAO DO CARGO
[2 frases — propósito estratégico do cargo ${cargo} no setor ${area}]

ATRIBUICOES
- [verbo infinitivo + ação concreta do setor ${area}]
[escreva 9 itens totais]

COMPETENCIAS TECNICAS
- [habilidade técnica específica para ${area}]
[escreva 5 itens]

COMPETENCIAS COMPORTAMENTAIS
- [comportamento esperado para nível ${nivel}]
[escreva 4 itens]

REQUISITOS MINIMOS
Formacao: [grau mínimo]
Experiencia: [tempo e tipo para nível ${nivel}]
Diferenciais: [ou "Não exigido"]

INDICACAO DE CBOS
[escolha 3 itens da lista]
${listaCBO}
`
}

function montarPromptGenerica(cargo, area, nivel, tipo, candidatos) {
  const ctx = db.prepare("SELECT * FROM areas WHERE key = ?").get(area)
  const contextoArea = ctx?.universo.trim()
    || `Setor especializado de uma usina sucroenergética.`

  const artigos = db.prepare("SELECT titulo, conteudo FROM conhecimento WHERE ativo = 1").all()
  const baseConhecimento = artigos.length > 0
    ? `\nBASE DE CONHECIMENTO:\n\n` + artigos.map(a => `[ ${a.titulo} ]\n${a.conteudo}`).join("\n\n") + "\n"
    : ""

  const listaCBO = candidatos.length > 0
    ? candidatos.slice(0, 8).map(c => `${c.codigo} – ${c.cargo}`).join("\n")
    : "Nenhuma referência próxima encontrada."

  const nivelDef = NIVEL_DEF[nivel] || `Nível ${nivel}`
  const isLider  = ["Coordenador","Gerente","Diretor"].includes(nivel)
  const regraLideranca = isLider
    ? `FUNCOES devem incluir: gestão de pessoas, metas, delegação, reporte à hierarquia.`
    : `PROIBIDO nas FUNCOES: liderar equipe, coordenar pessoas, delegar tarefas, gerir subordinados.`

  const tipoCtx = TIPO_CTX[tipo] || `Atuação ${tipo}.`

  return `Você é redator técnico de RH de usinas sucroenergéticas. Preencha o template abaixo. Sem introduções, sem comentários, sem texto fora do template.
${baseConhecimento}

⚠ ATENÇÃO — REGRA INVIOLÁVEL: O setor deste cargo é "${area}". TODA a descrição deve ser ancorada exclusivamente no setor ${area}. PROIBIDO mencionar, sugerir ou usar qualquer outro setor (TI, Financeiro, Agrícola, etc.). Se o nome do cargo parecer de outro setor, interprete-o dentro do contexto de ${area}.

CARGO: ${cargo}
SETOR: ${area} (ÚNICO setor permitido nesta descrição)
NIVEL: ${nivel} — ${nivelDef}
ATUACAO: ${tipo} — ${tipoCtx}
CONTEXTO DO SETOR ${area}: ${contextoArea}

REGRAS:
- DESCRICAO DO CARGO: parágrafo único corrido, 800 a 999 caracteres. Descreva o PROPÓSITO do cargo (por que existe), o IMPACTO gerado e o ESCOPO de atuação no setor ${area}. PROIBIDO descrever rotina ou dizer "o profissional faz". PROIBIDO citar o nível ${nivel}.
- FUNCOES: 8 a 12 itens, verbo no infinitivo + atividade concreta do setor ${area}. ${regraLideranca}
- CBOs: após descrever o cargo, escolha 3 da lista que melhor representam o que foi descrito.

CBOs DISPONÍVEIS:
${listaCBO}

`
}

function montarPrompt(cargo, area, nivel, tipo, candidatos) {
  const ctx = db.prepare("SELECT * FROM areas WHERE key = ?").get(area)

  const contextoArea = ctx
    ? ctx.universo.trim()
    : `Setor especializado de uma usina sucroenergética. Considere as particularidades operacionais industriais deste setor.`

  const artigos = db.prepare("SELECT titulo, conteudo FROM conhecimento WHERE ativo = 1").all()
  const baseConhecimento = artigos.length > 0
    ? `\nBASE DE CONHECIMENTO — use como referência técnica ao elaborar a descrição:\n\n` +
      artigos.map(a => `[ ${a.titulo} ]\n${a.conteudo}`).join("\n\n") + "\n"
    : ""

  const listaCBO = candidatos.length > 0
    ? candidatos.slice(0, 8).map(c => `${c.codigo} – ${c.cargo}`).join("\n")
    : "Nenhuma referência próxima encontrada na base."

  const nivelDef = NIVEL_DEF[nivel] || `Nível ${nivel} — adapte a complexidade das responsabilidades ao tempo de experiência esperado.`

  const isLider = ["Coordenador","Gerente","Diretor"].includes(nivel)
  const regraLideranca = isLider
    ? `Este nível É de liderança. As FUNCOES devem incluir obrigatoriamente: gestão de pessoas, definição de metas, delegação de tarefas, acompanhamento de resultados e reporte à hierarquia superior.`
    : `PROIBIDO nas FUNCOES: liderar equipe, coordenar pessoas, delegar tarefas, gerir subordinados, supervisionar funcionários. O nível "${nivel}" NÃO é cargo de gestão. Violação disso invalida a descrição.`

  const tipoCtx = TIPO_CTX[tipo] || TIPO_CTX["Híbrido"]

  return `Você é especialista sênior em Recursos Humanos de usinas sucroenergéticas.
${baseConhecimento}

⚠ REGRA INVIOLÁVEL: O setor deste cargo é "${area}". TODA a descrição deve ser ancorada exclusivamente no setor ${area}. PROIBIDO usar qualquer outro setor. Se o nome do cargo parecer de outra área, interprete-o dentro de ${area}.

DADOS DO CARGO:
- Cargo: ${cargo}
- Setor: ${area} (ÚNICO setor permitido)
- Nível: ${nivel}
- Tipo de atuação: ${tipo}

════════════════════════════════════════════════════
INTERPRETAÇÃO DO CARGO — LEIA ANTES DE TUDO
════════════════════════════════════════════════════

O nome do cargo "${cargo}" pode ser coloquial, metafórico, criativo ou incomum.
Sua tarefa é SEMPRE encontrar uma interpretação coerente que:
1. PRIORIZE o setor "${area}" — toda a descrição deve ser ancorada nele
2. Use o nome do cargo como ponto de partida criativo, nunca o ignore
3. Se o cargo tiver dois elementos (ex: "Boiadeiro de TI"), interprete o primeiro
   como metáfora/estilo de atuação e o segundo como o domínio técnico:
   "Boiadeiro de TI" → profissional que conduz/gerencia/guia ativos de TI (servidores,
   usuários, infraestrutura) com autonomia de campo, estilo hands-on.
4. Se o cargo for totalmente fora do contexto do setor, adapte-o criativamente para
   que faça sentido dentro do setor "${area}" — nunca descarte o cargo.
5. NUNCA produza uma descrição genérica que poderia servir a qualquer cargo.
   A descrição deve fazer a pessoa rir de reconhecimento: "sim, é exatamente isso".

DEFINICAO DO NIVEL "${nivel.toUpperCase()}":
${nivelDef}

TIPO DE ATUACAO — ${tipo.toUpperCase()}:
${tipoCtx}

CONTEXTO DO SETOR ${area.toUpperCase()}:
${contextoArea}

════════════════════════════════════════════════════
REGRAS ABSOLUTAS
════════════════════════════════════════════════════

Texto 100% limpo. Proibido: **, *, #, ##, emojis, markdown. Apenas texto puro.
Escreva exatamente os cinco títulos abaixo em MAIÚSCULO, sem pular nenhum.

[MISSAO] 2 a 3 frases explicando o PROPÓSITO ESTRATÉGICO do cargo — por que ele existe,
qual problema resolve, qual seu impacto no setor ${area}. NÃO liste tarefas aqui.
É a razão de ser do cargo, não o que o profissional faz no dia a dia.

[ATRIBUICOES] Lista de 8 a 12 responsabilidades. Cada item inicia com hífen e verbo no infinitivo.
São as atividades que o cargo executa. Devem ser concretas, específicas do setor ${area}.
CHECKLIST por item:
  1. Condiz com o TIPO "${tipo}"? (Operacional=campo/equipamentos | Administrativo=sistemas/escritório | Híbrido=ambos)
  2. Condiz com o NÍVEL "${nivel}"? (Junior=segue rotinas | Pleno=executa com autonomia | Senior=define padrões | Coordenador+=gere pessoas)
  3. Se NÃO em qualquer ponto, reescreva antes de incluir.
${regraLideranca}

[COMPETENCIAS TECNICAS] Lista de 4 a 6 itens. Conhecimentos e habilidades técnicas
exigidas para exercer o cargo. Específicos para o setor ${area} e nível ${nivel}.
Ex: softwares, normas técnicas, equipamentos, metodologias, legislações.

[COMPETENCIAS COMPORTAMENTAIS] Lista de 4 a 6 itens. Atitudes e comportamentos
esperados. Devem ser coerentes com o nível ${nivel} e o ambiente ${tipo}.
Ex: proatividade, comunicação assertiva, trabalho em equipe, foco em resultados.

[REQUISITOS] Três linhas fixas:
Formacao: [grau mínimo — Ex: Ensino Médio Completo / Superior em Engenharia / MBA]
Experiencia: [tempo e tipo — Ex: Mínimo 3 anos em manutenção industrial]
Diferenciais: [certificações, ferramentas, idiomas — se não houver, escreva "Não exigido"]

[CBO] Com base nas ATRIBUICOES que você acabou de escrever, escolha 3 CBOs da lista abaixo
que melhor representam o que o profissional EXECUTA. Se nenhum for perfeito, escolha o mais
próximo e justifique brevemente.

CBOs DISPONÍVEIS:
${listaCBO}

════════════════════════════════════════════════════
FORMATO — comece direto no primeiro título, sem introdução nem texto extra
════════════════════════════════════════════════════

MISSAO DO CARGO

[2 a 3 frases sobre o propósito estratégico do cargo no setor ${area}]

ATRIBUICOES E RESPONSABILIDADES

- [verbo infinitivo + atividade específica]
- [...]
(mínimo 8 itens)

COMPETENCIAS TECNICAS

- [conhecimento ou habilidade técnica requerida]
- [...]
(mínimo 4 itens)

COMPETENCIAS COMPORTAMENTAIS

- [competência comportamental esperada]
- [...]
(mínimo 4 itens)

REQUISITOS MINIMOS

Formacao: [grau mínimo]
Experiencia: [tempo e tipo conforme nível ${nivel}]
Diferenciais: [certificações, ferramentas ou "Não exigido"]

INDICACAO DE CBOs

[Código] - [Nome exato do CBO] - [Justificativa baseada nas atribuições acima]
[Código] - [Nome exato] - [Justificativa]
[Código] - [Nome exato] - [Justificativa]`
}


// ═══════════════════════════════════════════════════════════════
//  ROTAS — CARGOS
// ═══════════════════════════════════════════════════════════════

app.get("/cargos", (_, res) => {
  res.json(db.prepare("SELECT * FROM cargos ORDER BY criadoEm DESC").all())
})

app.post("/cargos", (req, res) => {
  const { cargo, area, nivel, texto } = req.body
  if (!cargo?.trim() || !texto?.trim())
    return res.status(400).json({ erro: "Campos obrigatórios: cargo, texto" })

  const novo = {
    id:       Date.now().toString(),
    cargo:    cargo.trim(),
    area:     area || "",
    nivel:    nivel || "",
    texto:    texto.trim(),
    criadoEm: new Date().toISOString()
  }
  db.prepare("INSERT INTO cargos (id,cargo,area,nivel,texto,criadoEm) VALUES (?,?,?,?,?,?)").run(
    novo.id, novo.cargo, novo.area, novo.nivel, novo.texto, novo.criadoEm)
  res.json({ ok: true, id: novo.id })
})

app.put("/cargos/:id", (req, res) => {
  const { cargo, area, nivel, texto } = req.body
  const info = db.prepare(`
    UPDATE cargos SET
      cargo     = COALESCE(NULLIF(?, ''), cargo),
      area      = COALESCE(?, area),
      nivel     = COALESCE(?, nivel),
      texto     = COALESCE(NULLIF(?, ''), texto),
      editadoEm = ?
    WHERE id = ?
  `).run(cargo?.trim()||"", area||null, nivel||null, texto?.trim()||"", new Date().toISOString(), req.params.id)

  if (info.changes === 0) return res.status(404).json({ erro: "Cargo não encontrado." })
  res.json({ ok: true })
})

app.delete("/cargos/:id", (req, res) => {
  const info = db.prepare("DELETE FROM cargos WHERE id = ?").run(req.params.id)
  if (info.changes === 0) return res.status(404).json({ erro: "Cargo não encontrado." })
  res.json({ ok: true })
})


// ═══════════════════════════════════════════════════════════════
//  ROTAS — ÁREAS
// ═══════════════════════════════════════════════════════════════

app.get("/areas", (_, res) => {
  res.json(db.prepare("SELECT * FROM areas").all())
})

app.post("/areas", (req, res) => {
  const { key, label, universo } = req.body
  if (!key?.trim() || !label?.trim() || !universo?.trim())
    return res.status(400).json({ erro: "Campos obrigatórios: key, label, universo" })
  try {
    db.prepare("INSERT INTO areas VALUES (?,?,?)").run(key.trim(), label.trim(), universo.trim())
    res.json({ ok: true })
  } catch (e) {
    if (e.message.includes("UNIQUE"))
      return res.status(409).json({ erro: "Já existe uma área com esse identificador." })
    res.status(500).json({ erro: e.message })
  }
})

app.put("/areas/:key", (req, res) => {
  const { label, universo } = req.body
  const info = db.prepare(`
    UPDATE areas SET
      label    = COALESCE(NULLIF(?, ''), label),
      universo = COALESCE(NULLIF(?, ''), universo)
    WHERE key = ?
  `).run(label?.trim()||"", universo?.trim()||"", req.params.key)

  if (info.changes === 0) return res.status(404).json({ erro: "Área não encontrada." })
  res.json({ ok: true })
})

app.delete("/areas/:key", (req, res) => {
  const info = db.prepare("DELETE FROM areas WHERE key = ?").run(req.params.key)
  if (info.changes === 0) return res.status(404).json({ erro: "Área não encontrada." })
  res.json({ ok: true })
})


// ═══════════════════════════════════════════════════════════════
//  ROTAS — BASE DE CONHECIMENTO
// ═══════════════════════════════════════════════════════════════

app.get("/conhecimento", (_, res) => {
  res.json(db.prepare("SELECT * FROM conhecimento ORDER BY criadoEm ASC").all().map(a => ({
    ...a, ativo: a.ativo === 1
  })))
})

app.post("/conhecimento", (req, res) => {
  const { titulo, categoria, conteudo, ativo = true } = req.body
  if (!titulo?.trim() || !conteudo?.trim())
    return res.status(400).json({ erro: "Campos obrigatórios: titulo, conteudo" })

  const novo = {
    id:        Date.now().toString(),
    titulo:    titulo.trim(),
    categoria: categoria?.trim() || "Geral",
    ativo:     ativo ? 1 : 0,
    conteudo:  conteudo.trim(),
    criadoEm:  new Date().toISOString()
  }
  db.prepare("INSERT INTO conhecimento (id,titulo,categoria,ativo,conteudo,criadoEm) VALUES (?,?,?,?,?,?)").run(
    novo.id, novo.titulo, novo.categoria, novo.ativo, novo.conteudo, novo.criadoEm)
  res.json({ ok: true, id: novo.id })
})

app.put("/conhecimento/:id", (req, res) => {
  const { titulo, categoria, conteudo, ativo } = req.body
  const ativoVal = typeof ativo === "boolean" ? (ativo ? 1 : 0) : null

  const info = db.prepare(`
    UPDATE conhecimento SET
      titulo    = COALESCE(NULLIF(?, ''), titulo),
      categoria = COALESCE(NULLIF(?, ''), categoria),
      conteudo  = COALESCE(NULLIF(?, ''), conteudo),
      ativo     = CASE WHEN ? IS NOT NULL THEN ? ELSE ativo END,
      editadoEm = ?
    WHERE id = ?
  `).run(
    titulo?.trim()||"", categoria?.trim()||"", conteudo?.trim()||"",
    ativoVal, ativoVal, new Date().toISOString(), req.params.id)

  if (info.changes === 0) return res.status(404).json({ erro: "Artigo não encontrado." })
  res.json({ ok: true })
})

app.delete("/conhecimento/:id", (req, res) => {
  const info = db.prepare("DELETE FROM conhecimento WHERE id = ?").run(req.params.id)
  if (info.changes === 0) return res.status(404).json({ erro: "Artigo não encontrado." })
  res.json({ ok: true })
})


// ═══════════════════════════════════════════════════════════════
//  ROTAS — UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════

app.get("/health", async (_, res) => {
  let ollamaOk = false
  try { ollamaOk = (await fetch(`${OLLAMA_URL}/api/tags`)).ok } catch { /* offline */ }
  res.json({
    status:        "ok",
    cbo_ocupacoes: cboBase.length,
    ollama_url:    OLLAMA_URL,
    modelo:        MODEL,
    ollama_ok:     ollamaOk
  })
})

app.get("/sugestoes", (req, res) => {
  const { q = "" } = req.query
  if (q.length < 2) return res.json([])
  res.json(
    cboBase
      .filter(c => c.cargo.toLowerCase().startsWith(q.toLowerCase()))
      .slice(0, 10)
      .map(c => ({ codigo: c.codigo, cargo: c.cargo }))
  )
})


// ═══════════════════════════════════════════════════════════════
//  ROTA — GERAR (streaming SSE)
// ═══════════════════════════════════════════════════════════════

app.post("/gerar", async (req, res) => {
  const { cargo, area, nivel, tipo = "Híbrido", provedor = "ollama" } = req.body

  if (!cargo?.trim() || !area || !nivel)
    return res.status(400).json({ erro: "Campos obrigatórios: cargo, area, nivel" })

  if (provedor === "groq" && !GROQ_KEY)
    return res.status(400).json({ erro: "GROQ_API_KEY não configurada no .env" })

  res.setHeader("Content-Type",  "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection",    "keep-alive")
  res.flushHeaders()

  const useGroq      = provedor === "groq"
  let   activeClient = useGroq ? groqClient : ollamaClient
  let   activeModel  = useGroq ? GROQ_MODEL : MODEL
  let   didFailover  = false

  // Wrapper com failover automático para Ollama se Groq falhar
  const criarStream = async (params) => {
    try {
      return await activeClient.chat.completions.create({ ...params, model: activeModel })
    } catch (err) {
      const status = err.status ?? err.statusCode ?? 0
      console.error(`❌ Groq erro ${status}:`, err.message)

      // 429 = rate limit — não faz sentido falhar para Ollama, avisa o usuário
      if (status === 429) {
        const retry = err.headers?.["retry-after"] ?? "60"
        throw Object.assign(new Error(`Limite de requisições Groq atingido. Aguarde ${retry}s ou troque para Ollama.`), { groqRateLimit: true })
      }

      // Outros erros: failover para Ollama
      if (useGroq && !didFailover) {
        didFailover  = true
        activeClient = ollamaClient
        activeModel  = MODEL
        console.warn("⚠️  Groq indisponível — failover para Ollama:", err.message)
        res.write(`data: ${JSON.stringify({ tipo: "failover", para: "ollama" })}\n\n`)
        return await activeClient.chat.completions.create({ ...params, model: activeModel })
      }
      throw err
    }
  }

  // Envia um evento de raciocínio para o frontend
  const pensar = (texto) => res.write(`data: ${JSON.stringify({ tipo: "pensando", texto })}\n\n`)

  try {
    // ── Raciocínio em tempo real ──────────────────────────────────
    pensar(`Interpretando cargo: "${cargo}" no setor ${area}`)

    const ctx = db.prepare("SELECT * FROM areas WHERE key = ?").get(area)
    if (ctx) pensar(`Contexto do setor carregado — ${ctx.universo.slice(0, 80)}...`)

    pensar(`Buscando correspondências no CBO 2002...`)
    const candidatos = buscarCBO(cargo, area)

    if (candidatos.length > 0) {
      pensar(`${candidatos.length} candidatos CBO encontrados:`)
      candidatos.slice(0, 5).forEach(c => pensar(`  · ${c.codigo} — ${c.cargo}`))
    } else {
      pensar(`Nenhum CBO exato encontrado — IA irá inferir o mais próximo`)
    }

    const artigos = db.prepare("SELECT titulo FROM conhecimento WHERE ativo = 1").all()
    if (artigos.length > 0)
      pensar(`Base de conhecimento: ${artigos.length} artigo(s) injetado(s) no contexto`)

    pensar(`Nível "${nivel}" → ${
      nivel === "Senior"      ? "define padrões, lidera projetos técnicos, diagnóstico complexo" :
      nivel === "Pleno"       ? "autônomo na execução, propõe melhorias, orienta juniores" :
      nivel === "Junior"      ? "segue rotinas definidas, supervisão regular" :
      nivel === "Coordenador" ? "gestão de equipe, metas e resultados" :
      nivel === "Gerente"     ? "estratégia de área, orçamento, liderança de coordenadores" :
      nivel === "Especialista"? "domínio técnico profundo, referência interna e externa" :
      nivel
    }`)

    pensar(`Tipo de atuação: ${tipo} → ${
      tipo === "Operacional"    ? "campo, equipamentos, EPIs, turnos" :
      tipo === "Administrativo" ? "escritório, sistemas, relatórios" :
      "presença híbrida — campo e escritório"
    }`)

    console.log(`🤖 Gerando via ${useGroq ? "Groq (" + GROQ_MODEL + ")" : "Ollama (" + MODEL + ")"}`)

    // System messages — Groq segue bem instruções complexas; Ollama precisa de abordagem mais diretiva
    const SYS_GROQ = "Você é especialista sênior em RH de usinas sucroenergéticas. Siga o formato EXATAMENTE como solicitado. PROIBIDO adicionar qualquer texto fora do template — sem introduções, sem conclusões, sem comentários."

    const SYS_OLLAMA = `Você é um gerador de documentos. Preencha o template exatamente como solicitado.
PROIBIDO: introduções, explicações, "aqui está", "claro", "certamente", meta-comentários de qualquer tipo.
Escreva apenas o conteúdo do documento, começando pelo primeiro título.`

    const SYS = useGroq ? SYS_GROQ : SYS_OLLAMA

    // Prefill ancorado no cargo e área — força o modelo a permanecer no contexto correto
    const prefillGen = `DESCRICAO DO CARGO\n\n`
    const prefillDet = `MISSAO DO CARGO\n\n`

    // Seleção de prompt: Groq usa o detalhado completo; Ollama usa versão enxuta
    const promptGen = useGroq
      ? montarPromptGenerica(cargo, area, nivel, tipo, candidatos)
      : montarPromptOllamaGen(cargo, area, nivel, tipo, candidatos)

    const promptDet = useGroq
      ? montarPrompt(cargo, area, nivel, tipo, candidatos)
      : montarPromptOllamaDet(cargo, area, nivel, tipo, candidatos)

    // ── Genérica ──────────────────────────────────────────────────
    res.write(`data: ${JSON.stringify({ tipo: "secao", nome: "generica" })}\n\n`)

    if (!useGroq) res.write(`data: ${JSON.stringify({ texto: prefillGen })}\n\n`)

    const streamGen = await criarStream({
      stream: true, temperature: 0.2, max_tokens: 900,
      messages: [
        { role: "system",    content: SYS },
        { role: "user",      content: promptGen },
        ...(!useGroq ? [{ role: "assistant", content: prefillGen }] : [])
      ]
    })
    for await (const chunk of streamGen) {
      const delta = chunk.choices[0]?.delta?.content ?? ""
      if (delta) res.write(`data: ${JSON.stringify({ texto: delta })}\n\n`)
    }

    // ── Detalhada ─────────────────────────────────────────────────
    res.write(`data: ${JSON.stringify({ tipo: "secao", nome: "detalhada" })}\n\n`)

    if (!useGroq) res.write(`data: ${JSON.stringify({ texto: prefillDet })}\n\n`)

    const streamDet = await criarStream({
      stream: true, temperature: 0.2, max_tokens: 1600,
      messages: [
        { role: "system",    content: SYS },
        { role: "user",      content: promptDet },
        ...(!useGroq ? [{ role: "assistant", content: prefillDet }] : [])
      ]
    })
    for await (const chunk of streamDet) {
      const delta = chunk.choices[0]?.delta?.content ?? ""
      if (delta) res.write(`data: ${JSON.stringify({ texto: delta })}\n\n`)
    }

    res.write(`data: ${JSON.stringify({ fim: true })}\n\n`)
    res.end()

  } catch (err) {
    console.error(`❌ Erro ${useGroq ? "Groq" : "Ollama"}:`, err.message)
    res.write(`data: ${JSON.stringify({ erro: err.message })}\n\n`)
    res.end()
  }
})


// ═══════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🚀 JoyDescription → http://localhost:${PORT}`)
  console.log(`🦙 Ollama:  ${OLLAMA_URL} (${MODEL})`)
  console.log(`⚡ Groq:    ${GROQ_KEY ? "✅ configurado (" + GROQ_MODEL + ")" : "❌ sem API key"}`)
  console.log(`🗄️  Banco:   joydescription.db\n`)
})
