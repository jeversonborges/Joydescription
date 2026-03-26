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
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto"
import OpenAI            from "openai"
import Database          from "better-sqlite3"

dotenv.config()

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const PORT        = process.env.PORT         || 3000
const GROQ_KEY      = process.env.GROQ_API_KEY      || ""
const GROQ_MODEL    = process.env.GROQ_MODEL        || "llama-3.3-70b-versatile"
const TOGETHER_KEY  = process.env.TOGETHER_API_KEY  || ""
const TOGETHER_MODEL= process.env.TOGETHER_MODEL    || "meta-llama/Llama-3.3-70B-Instruct-Turbo"

// ── Carregar base de salários de referência ────────────────────
let salarioBase = {}
try {
  const salariosPath = path.join(__dirname, "salarios-referencia.json")
  salarioBase = JSON.parse(fs.readFileSync(salariosPath, "utf8"))
  console.log("✅ Base de salários de referência carregada (RAIS, CAGED, UNICA, SINDICAR)")
} catch (e) {
  console.warn("⚠️  Arquivo salarios-referencia.json não encontrado:", e.message)
}

// ── Express ────────────────────────────────────────────────────
const app = express()
const PROD = process.env.NODE_ENV === "production"

// Headers de segurança
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-XSS-Protection", "1; mode=block")
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://unicons.iconscout.com; style-src 'self' 'unsafe-inline' https://unicons.iconscout.com https://fonts.googleapis.com; font-src 'self' https://unicons.iconscout.com https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'")
  next()
})

// CORS — apenas mesma origem em produção
app.use(cors(PROD ? { origin: false } : {}))
app.use(express.json({ limit: "1mb" }))

// Rate limit simples para login/registro (sem dependências)
const tentativas = new Map()
function checkRateLimit(ip) {
  const agora = Date.now()
  const rec = tentativas.get(ip) || { n: 0, desde: agora }
  if (agora - rec.desde > 15 * 60 * 1000) { tentativas.set(ip, { n: 1, desde: agora }); return true }
  if (rec.n >= 10) return false
  tentativas.set(ip, { n: rec.n + 1, desde: rec.desde })
  return true
}
function resetRateLimit(ip) { tentativas.delete(ip) }
setInterval(() => {
  const limite = Date.now() - 15 * 60 * 1000
  for (const [ip, rec] of tentativas) if (rec.desde < limite) tentativas.delete(ip)
}, 5 * 60 * 1000)
// Static servido por último — as rotas da API têm prioridade
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")))


// ═══════════════════════════════════════════════════════════════
//  BANCO DE DADOS — SQLite
//  Um único arquivo .db substitui os três JSONs anteriores.
//  WAL mode garante leituras sem bloquear escritas e vice-versa.
//  Sem risco de corrupção por crash ou reinício do processo.
// ═══════════════════════════════════════════════════════════════

// ── Se volume persistente configurado, garante diretório e copia seed ──
const dbPath = process.env.JOY_DB_PATH || path.join(__dirname, "joydescription.db")
if (process.env.JOY_DB_PATH) {
  fs.mkdirSync(path.dirname(process.env.JOY_DB_PATH), { recursive: true })
  const forceSeed = process.env.JOY_FORCE_SEED === "1"
  if (!fs.existsSync(process.env.JOY_DB_PATH) || forceSeed) {
    const seed = path.join(__dirname, "joydescription.db")
    if (fs.existsSync(seed)) {
      fs.copyFileSync(seed, process.env.JOY_DB_PATH)
      console.log("✅ Banco copiado para volume persistente" + (forceSeed ? " (forçado)" : ""))
    } else {
      console.log("ℹ️  Volume vazio — banco novo será criado em", process.env.JOY_DB_PATH)
    }
  }
}
const db = new Database(dbPath)
db.pragma("journal_mode = WAL")
db.pragma("synchronous = NORMAL")

db.exec(`
  CREATE TABLE IF NOT EXISTS empresas (
    id        TEXT PRIMARY KEY,
    nome      TEXT NOT NULL,
    criado_em TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id         TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL REFERENCES empresas(id),
    nome       TEXT NOT NULL,
    email      TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    papel      TEXT NOT NULL DEFAULT 'membro',
    ativo      INTEGER NOT NULL DEFAULT 1,
    criado_em  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token      TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL,
    empresa_id TEXT NOT NULL,
    expira_em  TEXT NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS niveis (
    label           TEXT PRIMARY KEY,
    ordem           INTEGER NOT NULL DEFAULT 0,
    eh_lideranca    INTEGER NOT NULL DEFAULT 0,
    descricao       TEXT NOT NULL DEFAULT '',
    descricao_curta TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS versoes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cargo_id   TEXT NOT NULL,
    cargo      TEXT NOT NULL,
    area       TEXT NOT NULL DEFAULT '',
    nivel      TEXT NOT NULL DEFAULT '',
    texto      TEXT NOT NULL,
    hash       TEXT NOT NULL,
    hash_prev  TEXT NOT NULL DEFAULT '',
    criado_em  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS salarios_cargo (
    id             TEXT PRIMARY KEY,
    cargo_id       TEXT,
    cargo          TEXT NOT NULL,
    area           TEXT NOT NULL,
    nivel          TEXT NOT NULL,
    empresa_id     TEXT NOT NULL DEFAULT 'default',
    setor          TEXT NOT NULL DEFAULT 'sucroenergético',
    regiao         TEXT NOT NULL DEFAULT 'Centro-Oeste',
    sal_min        REAL,
    sal_med        REAL,
    sal_max        REAL,
    rem_total_min  REAL,
    rem_total_med  REAL,
    rem_total_max  REAL,
    rem_anual_min  REAL,
    rem_anual_med  REAL,
    rem_anual_max  REAL,
    data_ref       TEXT NOT NULL,
    criado_em      TEXT NOT NULL
  );
`)

// ── Migrações de multi-tenant: adiciona empresa_id às tabelas existentes ──
;(function migrarMultiTenant() {
  // Cria empresa padrão se não existir
  db.prepare("INSERT OR IGNORE INTO empresas (id, nome, criado_em) VALUES (?, ?, ?)")
    .run("default", "Empresa Padrão", "2024-01-01T00:00:00.000Z")

  // Verifica e adiciona empresa_id em cargos
  const colsCargos = db.prepare("PRAGMA table_info(cargos)").all().map(c => c.name)
  if (!colsCargos.includes("empresa_id")) {
    db.exec("ALTER TABLE cargos ADD COLUMN empresa_id TEXT NOT NULL DEFAULT 'default'")
    console.log("✅ Migração: empresa_id adicionado a cargos")
  }

  // Verifica e adiciona empresa_id em conhecimento
  const colsConhec = db.prepare("PRAGMA table_info(conhecimento)").all().map(c => c.name)
  if (!colsConhec.includes("empresa_id")) {
    db.exec("ALTER TABLE conhecimento ADD COLUMN empresa_id TEXT NOT NULL DEFAULT 'default'")
    console.log("✅ Migração: empresa_id adicionado a conhecimento")
  }

  // Verifica e adiciona empresa_id em versoes
  const colsVersoes = db.prepare("PRAGMA table_info(versoes)").all().map(c => c.name)
  if (!colsVersoes.includes("empresa_id")) {
    db.exec("ALTER TABLE versoes ADD COLUMN empresa_id TEXT NOT NULL DEFAULT 'default'")
    console.log("✅ Migração: empresa_id adicionado a versoes")
  }

  // Migra areas para PK composta (empresa_id, key) se ainda for a versão antiga
  const colsAreas = db.prepare("PRAGMA table_info(areas)").all().map(c => c.name)
  if (!colsAreas.includes("empresa_id")) {
    db.exec(`
      CREATE TABLE areas_new (
        empresa_id TEXT NOT NULL DEFAULT 'default',
        key        TEXT NOT NULL,
        label      TEXT NOT NULL,
        universo   TEXT NOT NULL,
        PRIMARY KEY (empresa_id, key)
      );
      INSERT INTO areas_new SELECT 'default', key, label, universo FROM areas;
      DROP TABLE areas;
      ALTER TABLE areas_new RENAME TO areas;
    `)
    console.log("✅ Migração: areas recriada com empresa_id")
  }

  // Migra niveis para PK composta (empresa_id, label) se ainda for a versão antiga
  const colsNiveis = db.prepare("PRAGMA table_info(niveis)").all().map(c => c.name)
  if (!colsNiveis.includes("empresa_id")) {
    db.exec(`
      CREATE TABLE niveis_new (
        empresa_id      TEXT NOT NULL DEFAULT 'default',
        label           TEXT NOT NULL,
        ordem           INTEGER NOT NULL DEFAULT 0,
        eh_lideranca    INTEGER NOT NULL DEFAULT 0,
        descricao       TEXT NOT NULL DEFAULT '',
        descricao_curta TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (empresa_id, label)
      );
      INSERT INTO niveis_new SELECT 'default', label, ordem, eh_lideranca, descricao, descricao_curta FROM niveis;
      DROP TABLE niveis;
      ALTER TABLE niveis_new RENAME TO niveis;
    `)
    console.log("✅ Migração: niveis recriada com empresa_id")
  }
})()

// ── Limpeza periódica de sessões expiradas (1h) ────────────────────────────
setInterval(() => {
  db.prepare("DELETE FROM sessoes WHERE expira_em < ?").run(new Date().toISOString())
}, 3600000)

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


// ── Clientes IA ────────────────────────────────────────────────
const groqClient     = new OpenAI({ baseURL: "https://api.groq.com/openai/v1",      apiKey: GROQ_KEY })
const togetherClient = new OpenAI({ baseURL: "https://api.together.xyz/v1",          apiKey: TOGETHER_KEY })


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

// ── Buscar salários de referência (RAIS, CAGED, UNICA, SINDICAR) ──
function buscarSalarioReferencia(cargoNome, areaNome, nivelNome) {
  if (!salarioBase.salarios_por_cargo) return null

  const cargo = cargoNome.toLowerCase().trim()
  const area = areaNome.toUpperCase().trim()
  const nivel = nivelNome.toLowerCase().trim()

  // Buscar na base por cargo exato
  for (const [cargoKey, areas] of Object.entries(salarioBase.salarios_por_cargo)) {
    if (cargo.includes(cargoKey) || cargoKey.includes(cargo)) {
      for (const [areaKey, niveis] of Object.entries(areas)) {
        if (area.includes(areaKey.toUpperCase()) || areaKey.toUpperCase().includes(area)) {
          // Se tem dados por nível
          if (niveis[nivel]) {
            const dados = niveis[nivel]
            return {
              sal_min: Math.round(dados.min),
              sal_med: Math.round(dados.med),
              sal_max: Math.round(dados.max),
              fonte: "RAIS/CAGED/UNICA/SINDICAR"
            }
          }
          // Se tem apenas mediana (para cargos sem nivél)
          if (niveis.med) {
            return {
              sal_min: Math.round(niveis.med * 0.8),
              sal_med: Math.round(niveis.med),
              sal_max: Math.round(niveis.med * 1.3),
              fonte: "RAIS/CAGED/UNICA/SINDICAR"
            }
          }
        }
      }
    }
  }
  return null
}

function buscarCBO(cargo, areaKey = "", limite = 25, empresaId = "default") {
  const ctx      = db.prepare("SELECT universo FROM areas WHERE key = ? AND empresa_id = ?").get(areaKey, empresaId)
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

  "Gestor":
`PERFIL: Liderança tática de área — nível acima do Coordenador, abaixo do Gerente. Dono do resultado da área: aprova decisões operacionais e táticas, lidera coordenadores e responde pelo desempenho integral do seu escopo perante a gerência/diretoria. Cargo de confiança pleno (CLT art. 62, II) com poder disciplinar amplo.

OBRIGAÇÕES LEGAIS DO CARGO:
- As FUNCOES DEVEM conter gestão de pessoas e gestão de resultados (coordenadores subordinados)
- Deve exercer poder decisório real — sem decisões próprias, enquadramento pode ser contestado em reclamatória

FUNCOES OBRIGATÓRIAS: definir objetivos e metas da área com desdobramento para os coordenadores, gerir e desenvolver coordenadores (avaliação, feedback, plano de desenvolvimento), aprovar decisões operacionais e táticas dentro do escopo da área, gerir orçamento operacional e responder pelos indicadores da área, garantir o cumprimento de políticas, normas e procedimentos da empresa na área, representar a área em fóruns internos e prestar contas à gerência/diretoria.
PODE TAMBÉM: participar de processos de contratação e desligamento da equipe, aprovar requisições de investimento dentro da alçada definida, representar a área em negociações operacionais com parceiros e fornecedores.`,

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
  "Gestor":       "liderança tática de área — acima do Coordenador, DEVE ter gestão de coordenadores e decisão sobre resultados da área",
  "Gerente":      "liderança de área com orçamento e decisão de pessoas",
  "Diretor":      "liderança executiva, estratégia, decisões de alto impacto",
}

const TIPO_CURTO = {
  "Operacional":    "campo/planta/equipamentos — sem escritório. Verbos: operar, monitorar, inspecionar, executar manutenção.",
  "Administrativo": "escritório/sistemas — sem campo. Verbos: elaborar, analisar, controlar, emitir, gerenciar no sistema.",
  "Híbrido":        "campo E escritório — obrigatoriamente os dois. Mínimo 4 funções de campo e 4 de escritório.",
}

// ── Função reutilizável: semeia níveis padrão para uma empresa ─
function seedNiveis(empresaId) {
  const ins = db.prepare("INSERT OR IGNORE INTO niveis (empresa_id,label,ordem,eh_lideranca,descricao,descricao_curta) VALUES (?,?,?,?,?,?)")
  const seed = [
    ["Estágio",     1, 0, NIVEL_DEF["Estágio"],     NIVEL_CURTO["Estágio"]],
    ["Trainee",     2, 0, NIVEL_DEF["Trainee"],     NIVEL_CURTO["Trainee"]],
    ["Junior",      3, 0, NIVEL_DEF["Junior"],      NIVEL_CURTO["Junior"]],
    ["Pleno",       4, 0, NIVEL_DEF["Pleno"],       NIVEL_CURTO["Pleno"]],
    ["Senior",      5, 0, NIVEL_DEF["Senior"],      NIVEL_CURTO["Senior"]],
    ["Especialista",6, 0, NIVEL_DEF["Especialista"],NIVEL_CURTO["Especialista"]],
    ["Coordenador", 7, 1, NIVEL_DEF["Coordenador"], NIVEL_CURTO["Coordenador"]],
    ["Gestor",      8, 1, NIVEL_DEF["Gestor"],      NIVEL_CURTO["Gestor"]],
    ["Gerente",     9, 1, NIVEL_DEF["Gerente"],     NIVEL_CURTO["Gerente"]],
    ["Diretor",     10,1, NIVEL_DEF["Diretor"],     NIVEL_CURTO["Diretor"]],
  ]
  db.transaction(() => seed.forEach(([label, ordem, lider, desc, curta]) =>
    ins.run(empresaId, label, ordem, lider, desc, curta)
  ))()
}

// ── Semeia níveis padrão na tabela se ainda estiver vazia (empresa default) ─
;(function semeiarNiveis() {
  if (db.prepare("SELECT COUNT(*) as n FROM niveis WHERE empresa_id = 'default'").get().n > 0) return
  seedNiveis("default")
  console.log("✅ Níveis padrão inseridos para empresa default")
})()

// ── Migração: insere Gestor se banco antigo não tiver ──────────
;(function addGestor() {
  if (db.prepare("SELECT COUNT(*) as n FROM niveis WHERE label='Gestor' AND empresa_id='default'").get().n > 0) return
  db.prepare("UPDATE niveis SET ordem = 9  WHERE label = 'Gerente' AND empresa_id = 'default'").run()
  db.prepare("UPDATE niveis SET ordem = 10 WHERE label = 'Diretor' AND empresa_id = 'default'").run()
  db.prepare("INSERT OR IGNORE INTO niveis (empresa_id,label,ordem,eh_lideranca,descricao,descricao_curta) VALUES (?,?,?,?,?,?)")
    .run("default", "Gestor", 8, 1, NIVEL_DEF["Gestor"], NIVEL_CURTO["Gestor"])
  console.log("✅ Nível Gestor adicionado para empresa default")
})()

// Prompt ultra-enxuto para Ollama — modelos pequenos perdem o fio em prompts longos
function montarPromptOllamaGen(cargo, area, nivel, tipo, candidatos, nm = {}, empresaId = "default") {
  const ctx = db.prepare("SELECT * FROM areas WHERE key = ? AND empresa_id = ?").get(area, empresaId)
  const contextoArea = ctx?.universo?.slice(0, 300) || `Setor de uma usina sucroenergética.`
  const nivelRes = nm[nivel]?.descricao_curta || NIVEL_CURTO[nivel] || nivel
  const tipoRes  = TIPO_CURTO[tipo]  || tipo
  const isLider  = nm[nivel]?.eh_lideranca === 1 || ["Coordenador","Gestor","Gerente","Diretor"].includes(nivel)
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

function montarPromptOllamaDet(cargo, area, nivel, tipo, candidatos, nm = {}, empresaId = "default") {
  const ctx = db.prepare("SELECT * FROM areas WHERE key = ? AND empresa_id = ?").get(area, empresaId)
  const contextoArea = ctx?.universo?.slice(0, 300) || `Setor de uma usina sucroenergética.`
  const nivelRes = nm[nivel]?.descricao_curta || NIVEL_CURTO[nivel] || nivel
  const tipoRes  = TIPO_CURTO[tipo]  || tipo
  const isLider  = nm[nivel]?.eh_lideranca === 1 || ["Coordenador","Gestor","Gerente","Diretor"].includes(nivel)
  const regraLider = isLider
    ? "OBRIGATÓRIO nas ATRIBUICOES: gestão de equipe, metas, delegação, reporte hierárquico."
    : `PROIBIDO nas ATRIBUICOES: coordenar equipe, gerir subordinados, negociar sindicato, aprovar salários de outros, demitir ou contratar. Nível técnico sem poder disciplinar.`
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

function montarPromptGenerica(cargo, area, nivel, tipo, candidatos, nm = {}, empresaId = "default") {
  const ctx = db.prepare("SELECT * FROM areas WHERE key = ? AND empresa_id = ?").get(area, empresaId)
  const contextoArea = ctx?.universo?.trim()
    || `Setor especializado de uma usina sucroenergética.`

  const artigos = db.prepare("SELECT titulo, conteudo FROM conhecimento WHERE ativo = 1 AND empresa_id = ?").all(empresaId)
  const baseConhecimento = artigos.length > 0
    ? `\nBASE DE CONHECIMENTO:\n\n` + artigos.map(a => `[ ${a.titulo} ]\n${a.conteudo}`).join("\n\n") + "\n"
    : ""

  const listaCBO = candidatos.length > 0
    ? candidatos.slice(0, 8).map(c => `${c.codigo} – ${c.cargo}`).join("\n")
    : "Nenhuma referência próxima encontrada."

  const nivelDef = nm[nivel]?.descricao || NIVEL_DEF[nivel] || `Nível ${nivel}`
  const isLider  = nm[nivel]?.eh_lideranca === 1 || ["Coordenador","Gestor","Gerente","Diretor"].includes(nivel)
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

function montarPrompt(cargo, area, nivel, tipo, candidatos, nm = {}, empresaId = "default") {
  const ctx = db.prepare("SELECT * FROM areas WHERE key = ? AND empresa_id = ?").get(area, empresaId)

  const contextoArea = ctx
    ? ctx.universo.trim()
    : `Setor especializado de uma usina sucroenergética. Considere as particularidades operacionais industriais deste setor.`

  const artigos = db.prepare("SELECT titulo, conteudo FROM conhecimento WHERE ativo = 1 AND empresa_id = ?").all(empresaId)
  const baseConhecimento = artigos.length > 0
    ? `\nBASE DE CONHECIMENTO — use como referência técnica ao elaborar a descrição:\n\n` +
      artigos.map(a => `[ ${a.titulo} ]\n${a.conteudo}`).join("\n\n") + "\n"
    : ""

  const listaCBO = candidatos.length > 0
    ? candidatos.slice(0, 8).map(c => `${c.codigo} – ${c.cargo}`).join("\n")
    : "Nenhuma referência próxima encontrada na base."

  const nivelDef = nm[nivel]?.descricao || NIVEL_DEF[nivel] || `Nível ${nivel} — adapte a complexidade das responsabilidades ao tempo de experiência esperado.`

  const isLider = nm[nivel]?.eh_lideranca === 1 || ["Coordenador","Gestor","Gerente","Diretor"].includes(nivel)

  // Extrai fronteira legal do NIVEL_DEF para injetar no prompt
  const nivelDefCompleto = nm[nivel]?.descricao || NIVEL_DEF[nivel] || ""
  const linhasFronteira  = nivelDefCompleto.split("\n")
    .filter(l => /FRONTEIRA|PROIBIDO|NUNCA|PODE\s|EXEMPLOS PROIBIDOS/i.test(l))
    .slice(0, 10)
    .join("\n")

  const regraLideranca = isLider
    ? `Este nível É de liderança. As ATRIBUICOES devem incluir obrigatoriamente: gestão de pessoas, definição de metas, delegação de tarefas, acompanhamento de resultados e reporte à hierarquia superior.`
    : `PROIBIDO nas ATRIBUICOES: coordenar equipe formalmente, gerir subordinados, supervisionar funcionários com poder disciplinar. O nível "${nivel}" NÃO é cargo de gestão de pessoas (CLT art. 62 II).
FRONTEIRA LEGAL DO NÍVEL "${nivel}" — respeite estritamente:
${linhasFronteira || `Nível técnico sem subordinados formais. Não inclua aprovação de aumentos salariais, negociação sindical formal, demissão ou contratação.`}`

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

[ATRIBUICOES] Lista de 8 a 12 itens. Cada item = VERBO INFINITIVO + AÇÃO CONCRETA.
⚠ ESTA SEÇÃO É EXCLUSIVAMENTE O QUE O CARGO FAZ — não o que ele sabe ou como ele é.
PROIBIDO nesta seção: conhecimentos técnicos, softwares, certificações, habilidades, legislações, perfil comportamental, atitudes. Esses itens pertencem às próximas seções.
CHECKLIST por item:
  1. É uma AÇÃO (verbo + objeto concreto)? Se for "conhecimento de X" ou "habilidade em Y" → mova para COMPETENCIAS TECNICAS.
  2. Condiz com o TIPO "${tipo}"? (Operacional=campo/equipamentos | Administrativo=sistemas/escritório | Híbrido=ambos)
  3. Condiz com o NÍVEL "${nivel}" conforme definição acima? Se NÃO → reescreva ou remova.
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

// ── Hash SHA-256 encadeado para versionamento imutável ─────────
function hashVersao(hashPrev, texto) {
  return createHash("sha256").update(hashPrev + texto).digest("hex")
}

function salvarVersao(cargo_id, cargo, area, nivel, texto, empresaId = "default") {
  const ultima = db.prepare(
    "SELECT hash FROM versoes WHERE cargo_id = ? AND empresa_id = ? ORDER BY id DESC LIMIT 1"
  ).get(cargo_id, empresaId)
  const hashPrev = ultima?.hash || ""
  const hash     = hashVersao(hashPrev, texto)
  db.prepare(`
    INSERT INTO versoes (cargo_id,cargo,area,nivel,texto,hash,hash_prev,criado_em,empresa_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(cargo_id, cargo, area, nivel, texto, hash, hashPrev, new Date().toISOString(), empresaId)
}

// ═══════════════════════════════════════════════════════════════
//  AUTH — helpers e middleware
// ═══════════════════════════════════════════════════════════════

function hashSenha(senha) {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(senha, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

function verificarSenha(senha, armazenado) {
  const [salt, hashArm] = armazenado.split(":")
  const hashTent = scryptSync(senha, salt, 64).toString("hex")
  return timingSafeEqual(Buffer.from(hashArm, "hex"), Buffer.from(hashTent, "hex"))
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || ""
  const match = cookies.split(";").find(c => c.trim().startsWith(name + "="))
  return match ? match.trim().slice(name.length + 1) : null
}

function authMiddleware(req, res, next) {
  const token = getCookie(req, "joy_session")
  if (!token) return res.status(401).json({ erro: "Não autenticado." })
  const sessao = db.prepare(
    "SELECT s.*, u.nome, u.email, u.papel FROM sessoes s JOIN usuarios u ON s.usuario_id = u.id WHERE s.token = ? AND s.expira_em > ? AND u.ativo = 1"
  ).get(token, new Date().toISOString())
  if (!sessao) return res.status(401).json({ erro: "Sessão inválida ou expirada." })
  req.user = { id: sessao.usuario_id, nome: sessao.nome, email: sessao.email, papel: sessao.papel }
  req.empresaId = sessao.empresa_id
  next()
}

// ── Middleware global: protege rotas de API, libera estáticos e auth ──
app.use((req, res, next) => {
  const ext = req.path.split(".").pop().toLowerCase()
  const isStatic = ["css","js","html","ico","png","jpg","svg","woff","woff2","ttf","map"].includes(ext)
  const isPub    = isStatic || req.path === "/" || req.path.startsWith("/auth/") || req.path === "/health"
  if (isPub) return next()
  authMiddleware(req, res, next)
})

// ═══════════════════════════════════════════════════════════════
//  LOG DE AUDITORIA
// ═══════════════════════════════════════════════════════════════

db.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id TEXT NOT NULL,
  usuario_id TEXT,
  usuario_nome TEXT,
  acao       TEXT NOT NULL,
  alvo       TEXT,
  ip         TEXT,
  criado_em  TEXT NOT NULL
)`).run()
db.prepare("CREATE INDEX IF NOT EXISTS idx_audit_empresa ON audit_log(empresa_id, id DESC)").run()

function audit(empresa_id, usuario_id, usuario_nome, acao, alvo, ip) {
  try {
    db.prepare("INSERT INTO audit_log (empresa_id,usuario_id,usuario_nome,acao,alvo,ip,criado_em) VALUES (?,?,?,?,?,?,?)")
      .run(empresa_id, usuario_id || null, usuario_nome || null, acao, alvo || null, ip || null, new Date().toISOString())
  } catch {}
}

// Atalho para rotas autenticadas
function auditReq(req, acao, alvo) {
  audit(req.empresaId, req.user?.id, req.user?.nome, acao, alvo, req.ip || req.connection?.remoteAddress)
}

app.get("/auditoria", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito." })
  const { acao, usuario, limit = 100, offset = 0 } = req.query
  let where = "empresa_id = ?"
  const params = [req.empresaId]
  if (acao)    { where += " AND acao LIKE ?";         params.push(`%${acao}%`) }
  if (usuario) { where += " AND usuario_nome LIKE ?"; params.push(`%${usuario}%`) }
  params.push(parseInt(limit), parseInt(offset))
  const rows  = db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params)
  const total = db.prepare(`SELECT COUNT(*) as n FROM audit_log WHERE empresa_id = ?`).get(req.empresaId).n
  res.json({ rows, total })
})

app.get("/auditoria/exportar", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito." })
  const rows = db.prepare("SELECT * FROM audit_log WHERE empresa_id = ? ORDER BY id DESC").all(req.empresaId)
  const escape = v => v == null ? "" : `"${String(v).replace(/"/g, '""')}"`
  const header = ["id","criado_em","usuario_nome","usuario_id","acao","alvo","ip"].join(";")
  const body = rows.map(r =>
    [r.id, r.criado_em, r.usuario_nome, r.usuario_id, r.acao, r.alvo, r.ip].map(escape).join(";")
  ).join("\n")
  const csv = "\uFEFF" + header + "\n" + body  // BOM para Excel
  const nome = `auditoria-${new Date().toISOString().slice(0,10)}.csv`
  res.setHeader("Content-Disposition", `attachment; filename="${nome}"`)
  res.setHeader("Content-Type", "text/csv; charset=utf-8")
  auditReq(req, "auditoria.exportar", `${rows.length} registros`)
  res.send(csv)
})

// ═══════════════════════════════════════════════════════════════
//  ROTAS — AUTENTICAÇÃO
// ═══════════════════════════════════════════════════════════════

app.post("/auth/registrar", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress
  if (!checkRateLimit(ip)) return res.status(429).json({ erro: "Muitas tentativas. Aguarde 15 minutos." })
  const { empresa, nome, email, senha } = req.body
  if (!empresa?.trim() || !nome?.trim() || !email?.trim() || !senha)
    return res.status(400).json({ erro: "Campos obrigatórios: empresa, nome, email, senha" })
  if (!/^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}$/.test(senha))
    return res.status(400).json({ erro: "A senha deve ter no mínimo 8 caracteres, uma letra maiúscula, um número e um símbolo." })

  const emailExiste = db.prepare("SELECT id FROM usuarios WHERE email = ?").get(email.trim().toLowerCase())
  if (emailExiste) return res.status(409).json({ erro: "Este e-mail já está cadastrado." })

  const empresaId  = Date.now().toString()
  const usuarioId  = (Date.now() + 1).toString()
  const agora      = new Date().toISOString()
  const senhaHash  = hashSenha(senha)
  const token      = randomBytes(32).toString("hex")
  const expira     = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()

  db.transaction(() => {
    db.prepare("INSERT INTO empresas (id, nome, criado_em) VALUES (?,?,?)").run(empresaId, empresa.trim(), agora)
    db.prepare("INSERT INTO usuarios (id, empresa_id, nome, email, senha_hash, papel, ativo, criado_em) VALUES (?,?,?,?,?,?,?,?)")
      .run(usuarioId, empresaId, nome.trim(), email.trim().toLowerCase(), senhaHash, "admin", 1, agora)
    db.prepare("INSERT INTO sessoes (token, usuario_id, empresa_id, expira_em) VALUES (?,?,?,?)").run(token, usuarioId, empresaId, expira)
    // Semeia níveis padrão para a nova empresa
    seedNiveis(empresaId)
  })()

  const empresaRow = db.prepare("SELECT * FROM empresas WHERE id = ?").get(empresaId)

  const secure = PROD ? "; Secure" : ""
  res.setHeader("Set-Cookie", `joy_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`)
  res.json({ ok: true, user: { id: usuarioId, nome: nome.trim(), email: email.trim().toLowerCase(), papel: "admin" }, empresa: empresaRow })
})

app.post("/auth/login", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress
  if (!checkRateLimit(ip)) return res.status(429).json({ erro: "Muitas tentativas. Aguarde 15 minutos." })
  const { email, senha } = req.body
  if (!email?.trim() || !senha)
    return res.status(400).json({ erro: "E-mail e senha são obrigatórios." })

  const usuario = db.prepare("SELECT * FROM usuarios WHERE email = ? AND ativo = 1").get(email.trim().toLowerCase())
  if (!usuario) return res.status(401).json({ erro: "E-mail ou senha inválidos." })

  let senhaOk
  try { senhaOk = verificarSenha(senha, usuario.senha_hash) } catch { senhaOk = false }
  if (!senhaOk) {
    audit(usuario.empresa_id, usuario.id, usuario.nome, "auth.login_falhou", email.trim(), ip)
    return res.status(401).json({ erro: "E-mail ou senha inválidos." })
  }

  resetRateLimit(ip)
  const token  = randomBytes(32).toString("hex")
  const expira = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
  db.prepare("INSERT INTO sessoes (token, usuario_id, empresa_id, expira_em) VALUES (?,?,?,?)").run(token, usuario.id, usuario.empresa_id, expira)
  audit(usuario.empresa_id, usuario.id, usuario.nome, "auth.login", null, ip)

  const empresa = db.prepare("SELECT * FROM empresas WHERE id = ?").get(usuario.empresa_id)
  const secure = PROD ? "; Secure" : ""
  res.setHeader("Set-Cookie", `joy_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`)
  res.json({ ok: true, user: { id: usuario.id, nome: usuario.nome, email: usuario.email, papel: usuario.papel }, empresa })
})

app.post("/auth/logout", (req, res) => {
  const token = getCookie(req, "joy_session")
  if (token) {
    const sessao = db.prepare("SELECT s.*, u.nome FROM sessoes s JOIN usuarios u ON s.usuario_id = u.id WHERE s.token = ?").get(token)
    if (sessao) audit(sessao.empresa_id, sessao.usuario_id, sessao.nome, "auth.logout", null, req.ip || req.connection?.remoteAddress)
    db.prepare("DELETE FROM sessoes WHERE token = ?").run(token)
  }
  res.setHeader("Set-Cookie", "joy_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0")
  res.json({ ok: true })
})

app.get("/auth/me", (req, res) => {
  const token = getCookie(req, "joy_session")
  if (!token) return res.status(401).json({ erro: "Não autenticado." })
  const sessao = db.prepare(
    "SELECT s.*, u.nome, u.email, u.papel FROM sessoes s JOIN usuarios u ON s.usuario_id = u.id WHERE s.token = ? AND s.expira_em > ? AND u.ativo = 1"
  ).get(token, new Date().toISOString())
  if (!sessao) return res.status(401).json({ erro: "Sessão inválida ou expirada." })
  const empresa = db.prepare("SELECT * FROM empresas WHERE id = ?").get(sessao.empresa_id)
  res.json({ user: { id: sessao.usuario_id, nome: sessao.nome, email: sessao.email, papel: sessao.papel }, empresa })
})

// ═══════════════════════════════════════════════════════════════
//  ROTAS — GERENCIAMENTO DE USUÁRIOS (admin only)
// ═══════════════════════════════════════════════════════════════

app.get("/usuarios", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  const rows = db.prepare("SELECT id, nome, email, papel, ativo, criado_em FROM usuarios WHERE empresa_id = ? ORDER BY criado_em ASC").all(req.empresaId)
  res.json(rows)
})

app.post("/usuarios", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  const { nome, email, senha, papel = "membro" } = req.body
  if (!nome?.trim() || !email?.trim() || !senha)
    return res.status(400).json({ erro: "Campos obrigatórios: nome, email, senha" })
  if (!/^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}$/.test(senha))
    return res.status(400).json({ erro: "A senha deve ter no mínimo 8 caracteres, uma letra maiúscula, um número e um símbolo." })
  if (!["admin","membro"].includes(papel))
    return res.status(400).json({ erro: "Papel inválido. Use 'admin' ou 'membro'." })

  const emailExiste = db.prepare("SELECT id FROM usuarios WHERE email = ?").get(email.trim().toLowerCase())
  if (emailExiste) return res.status(409).json({ erro: "E-mail já cadastrado." })

  const id = Date.now().toString()
  db.prepare("INSERT INTO usuarios (id, empresa_id, nome, email, senha_hash, papel, ativo, criado_em) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, req.empresaId, nome.trim(), email.trim().toLowerCase(), hashSenha(senha), papel, 1, new Date().toISOString())
  auditReq(req, "usuario.criar", `${nome.trim()} (${email.trim().toLowerCase()}) — ${papel}`)
  res.json({ ok: true, id })
})

app.put("/usuarios/:id", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  const alvo = db.prepare("SELECT * FROM usuarios WHERE id = ? AND empresa_id = ?").get(req.params.id, req.empresaId)
  if (!alvo) return res.status(404).json({ erro: "Usuário não encontrado." })

  const { nome, papel, ativo, senha } = req.body
  const senhaHash = senha ? hashSenha(senha) : alvo.senha_hash
  const novoNome  = nome?.trim() || alvo.nome
  const novoPapel = ["admin","membro"].includes(papel) ? papel : alvo.papel
  const novoAtivo = typeof ativo === "number" ? ativo : alvo.ativo

  db.prepare("UPDATE usuarios SET nome=?, papel=?, ativo=?, senha_hash=? WHERE id=? AND empresa_id=?")
    .run(novoNome, novoPapel, novoAtivo, senhaHash, req.params.id, req.empresaId)
  auditReq(req, "usuario.editar", `${alvo.nome} → papel:${novoPapel}, ativo:${novoAtivo}`)
  res.json({ ok: true })
})

app.delete("/usuarios/:id", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  if (req.params.id === req.user.id) return res.status(400).json({ erro: "Você não pode desativar sua própria conta." })
  const alvo = db.prepare("SELECT * FROM usuarios WHERE id = ? AND empresa_id = ?").get(req.params.id, req.empresaId)
  if (!alvo) return res.status(404).json({ erro: "Usuário não encontrado." })
  db.prepare("UPDATE usuarios SET ativo = 0 WHERE id = ? AND empresa_id = ?").run(req.params.id, req.empresaId)
  auditReq(req, "usuario.desativar", alvo.nome)
  res.json({ ok: true })
})

app.delete("/usuarios/:id/excluir", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  if (req.params.id === req.user.id) return res.status(400).json({ erro: "Você não pode excluir sua própria conta." })
  const alvo = db.prepare("SELECT * FROM usuarios WHERE id = ? AND empresa_id = ?").get(req.params.id, req.empresaId)
  if (!alvo) return res.status(404).json({ erro: "Usuário não encontrado." })
  db.prepare("DELETE FROM sessoes WHERE usuario_id = ?").run(req.params.id)
  db.prepare("DELETE FROM usuarios WHERE id = ? AND empresa_id = ?").run(req.params.id, req.empresaId)
  auditReq(req, "usuario.excluir", alvo.nome)
  res.json({ ok: true })
})

// ═══════════════════════════════════════════════════════════════
//  ROTAS — BACKUP
// ═══════════════════════════════════════════════════════════════

// Tabela de histórico de backups
db.prepare(`CREATE TABLE IF NOT EXISTS backups_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_nome TEXT,
  usuario_email TEXT,
  empresa_id TEXT,
  tamanho_bytes INTEGER,
  criado_em TEXT
)`).run()

// Tabela de configuração de backup automático
db.prepare(`CREATE TABLE IF NOT EXISTS backup_config (
  empresa_id TEXT PRIMARY KEY,
  ativo INTEGER NOT NULL DEFAULT 0,
  intervalo_horas INTEGER NOT NULL DEFAULT 24,
  proximo_em TEXT
)`).run()

// Job de backup automático — roda a cada hora e dispara se passou o horário
const autoBackupTimers = new Map()
function agendarAutoBackup() {
  const configs = db.prepare("SELECT * FROM backup_config WHERE ativo = 1").all()
  const agora = Date.now()
  for (const cfg of configs) {
    if (cfg.proximo_em && new Date(cfg.proximo_em).getTime() <= agora) {
      try {
        db.pragma("wal_checkpoint(TRUNCATE)")
        const stat = require ? null : null // stat via fs
        const size = (() => { try { return fs.statSync(dbPath).size } catch { return 0 } })()
        db.prepare("INSERT INTO backups_log (usuario_nome, usuario_email, empresa_id, tamanho_bytes, criado_em) VALUES (?,?,?,?,?)")
          .run("Sistema (automático)", "—", cfg.empresa_id, size, new Date().toISOString())
        const proximo = new Date(agora + cfg.intervalo_horas * 3600000).toISOString()
        db.prepare("UPDATE backup_config SET proximo_em = ? WHERE empresa_id = ?").run(proximo, cfg.empresa_id)
        console.log(`[backup-auto] empresa=${cfg.empresa_id} proximo=${proximo}`)
      } catch (e) { console.error("[backup-auto] erro:", e.message) }
    }
  }
}
setInterval(agendarAutoBackup, 60 * 60 * 1000) // verifica a cada 1h

app.get("/backup/config", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito." })
  const cfg = db.prepare("SELECT * FROM backup_config WHERE empresa_id = ?").get(req.empresaId)
  if (!cfg) return res.json({ ativo: false, intervalo_horas: 24, proximo_em: null })
  res.json({ ativo: !!cfg.ativo, intervalo_horas: cfg.intervalo_horas, proximo_em: cfg.proximo_em })
})

app.post("/backup/config", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito." })
  const { ativo, intervalo_horas } = req.body
  const horas = parseInt(intervalo_horas) || 24
  const proximo = ativo ? new Date(Date.now() + horas * 3600000).toISOString() : null
  db.prepare(`INSERT INTO backup_config (empresa_id, ativo, intervalo_horas, proximo_em) VALUES (?,?,?,?)
    ON CONFLICT(empresa_id) DO UPDATE SET ativo=excluded.ativo, intervalo_horas=excluded.intervalo_horas, proximo_em=excluded.proximo_em`)
    .run(req.empresaId, ativo ? 1 : 0, horas, proximo)
  res.json({ ok: true, proximo_em: proximo })
})

app.get("/backup/status", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  db.pragma("wal_checkpoint(TRUNCATE)")
  const stat = fs.statSync(dbPath)
  const cargos     = db.prepare("SELECT COUNT(*) as n FROM cargos WHERE empresa_id = ?").get(req.empresaId).n
  const areas      = db.prepare("SELECT COUNT(*) as n FROM areas WHERE empresa_id = ?").get(req.empresaId).n
  const conhec     = db.prepare("SELECT COUNT(*) as n FROM conhecimento WHERE empresa_id = ?").get(req.empresaId).n
  const usuarios   = db.prepare("SELECT COUNT(*) as n FROM usuarios WHERE empresa_id = ?").get(req.empresaId).n
  const versoes    = db.prepare("SELECT COUNT(*) as n FROM versoes WHERE empresa_id = ?").get(req.empresaId).n
  const ultimoBackup = db.prepare("SELECT * FROM backups_log WHERE empresa_id = ? ORDER BY id DESC LIMIT 1").get(req.empresaId)
  res.json({ tamanho: stat.size, modificado: stat.mtime, cargos, areas, conhec, usuarios, versoes, ultimoBackup })
})

app.get("/backup/historico", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  const rows = db.prepare("SELECT * FROM backups_log WHERE empresa_id = ? ORDER BY id DESC LIMIT 20").all(req.empresaId)
  res.json(rows)
})

app.get("/backup/download", (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  db.pragma("wal_checkpoint(TRUNCATE)")
  const stat = fs.statSync(dbPath)
  db.prepare("INSERT INTO backups_log (usuario_nome, usuario_email, empresa_id, tamanho_bytes, criado_em) VALUES (?,?,?,?,?)")
    .run(req.user.nome, req.user.email, req.empresaId, stat.size, new Date().toISOString())
  auditReq(req, "backup.download", `${(stat.size/1024).toFixed(0)} KB`)
  const agora = new Date().toISOString().slice(0, 10)
  res.setHeader("Content-Disposition", `attachment; filename="joydesc-backup-${agora}.db"`)
  res.setHeader("Content-Type", "application/octet-stream")
  res.sendFile(dbPath)
})

app.post("/backup/restaurar", express.raw({ type: "application/octet-stream", limit: "50mb" }), (req, res) => {
  if (req.user.papel !== "admin") return res.status(403).json({ erro: "Acesso restrito a administradores." })
  const buf = req.body
  if (!buf || buf.length < 16) return res.status(400).json({ erro: "Arquivo inválido." })
  const magic = buf.slice(0, 16).toString("utf8")
  if (!magic.startsWith("SQLite format 3")) return res.status(400).json({ erro: "Arquivo não é um banco SQLite válido." })
  db.pragma("wal_checkpoint(TRUNCATE)")
  fs.writeFileSync(dbPath, buf)
  auditReq(req, "backup.restaurar", `${(buf.length/1024).toFixed(0)} KB`)
  res.json({ ok: true })
  setTimeout(() => process.exit(0), 500)
})

app.get("/cargos", (req, res) => {
  res.json(db.prepare("SELECT * FROM cargos WHERE empresa_id = ? ORDER BY criadoEm DESC").all(req.empresaId))
})

app.get("/changelog", (req, res) => {
  const rows = db.prepare(`
    SELECT v.id, v.cargo_id, v.cargo, v.area, v.nivel, v.hash, v.criado_em,
           c.cargo as cargo_atual
    FROM versoes v
    LEFT JOIN cargos c ON v.cargo_id = c.id
    WHERE v.empresa_id = ?
    ORDER BY v.id DESC LIMIT 200
  `).all(req.empresaId)
  res.json(rows)
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
  db.prepare("INSERT INTO cargos (id,cargo,area,nivel,texto,criadoEm,empresa_id) VALUES (?,?,?,?,?,?,?)").run(
    novo.id, novo.cargo, novo.area, novo.nivel, novo.texto, novo.criadoEm, req.empresaId)
  try { salvarVersao(novo.id, novo.cargo, novo.area, novo.nivel, novo.texto, req.empresaId) } catch (e) { console.error("versao:", e.message) }
  auditReq(req, "cargo.criar", novo.cargo)
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
    WHERE id = ? AND empresa_id = ?
  `).run(cargo?.trim()||"", area||null, nivel||null, texto?.trim()||"", new Date().toISOString(), req.params.id, req.empresaId)

  if (info.changes === 0) return res.status(404).json({ erro: "Cargo não encontrado." })
  try {
    const atualizado = db.prepare("SELECT * FROM cargos WHERE id = ? AND empresa_id = ?").get(req.params.id, req.empresaId)
    if (atualizado) {
      salvarVersao(atualizado.id, atualizado.cargo, atualizado.area, atualizado.nivel, atualizado.texto, req.empresaId)
      auditReq(req, "cargo.editar", atualizado.cargo)
    }
  } catch (e) { console.error("versao:", e.message) }
  res.json({ ok: true })
})

app.delete("/cargos/:id", (req, res) => {
  const cargo = db.prepare("SELECT cargo FROM cargos WHERE id = ? AND empresa_id = ?").get(req.params.id, req.empresaId)
  const info = db.prepare("DELETE FROM cargos WHERE id = ? AND empresa_id = ?").run(req.params.id, req.empresaId)
  if (info.changes === 0) return res.status(404).json({ erro: "Cargo não encontrado." })
  auditReq(req, "cargo.deletar", cargo?.cargo)
  res.json({ ok: true })
})

app.get("/versoes/:cargo_id", (req, res) => {
  const rows = db.prepare(
    "SELECT id,cargo,area,nivel,hash,hash_prev,criado_em FROM versoes WHERE cargo_id=? AND empresa_id=? ORDER BY id DESC"
  ).all(req.params.cargo_id, req.empresaId)
  res.json(rows)
})

app.get("/versoes/:cargo_id/:versao_id/texto", (req, res) => {
  const row = db.prepare(
    "SELECT texto,hash,hash_prev,criado_em FROM versoes WHERE cargo_id=? AND id=? AND empresa_id=?"
  ).get(req.params.cargo_id, req.params.versao_id, req.empresaId)
  if (!row) return res.status(404).json({ erro: "Versão não encontrada." })
  res.json(row)
})

// ═══════════════════════════════════════════════════════════════
//  ROTA — SALÁRIOS
// ═══════════════════════════════════════════════════════════════

app.get("/salarios", (req, res) => {
  const { cargo, area, nivel } = req.query
  if (!cargo || !area || !nivel)
    return res.status(400).json({ erro: "Parâmetros obrigatórios: cargo, area, nivel" })

  const row = db.prepare(
    `SELECT * FROM salarios_cargo
     WHERE cargo = ? AND area = ? AND nivel = ? AND empresa_id = ?
     ORDER BY criado_em DESC LIMIT 1`
  ).get(cargo, area, nivel, req.empresaId)

  res.json(row || null)
})

app.post("/salarios", (req, res) => {
  const { cargo, area, nivel, sal_min, sal_med, sal_max, rem_total_min, rem_total_med, rem_total_max, rem_anual_min, rem_anual_med, rem_anual_max, cargo_id } = req.body

  if (!cargo?.trim() || !area?.trim() || !nivel?.trim())
    return res.status(400).json({ erro: "Campos obrigatórios: cargo, area, nivel" })

  const id = randomBytes(16).toString("hex")
  const agora = new Date().toISOString()
  const dataRef = agora.substring(0, 7)

  try {
    db.prepare(`
      INSERT INTO salarios_cargo
      (id, cargo_id, cargo, area, nivel, empresa_id, setor, regiao, sal_min, sal_med, sal_max, rem_total_min, rem_total_med, rem_total_max, rem_anual_min, rem_anual_med, rem_anual_max, data_ref, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, 'sucroenergético', 'Centro-Oeste', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, cargo_id||null, cargo, area, nivel, req.empresaId, sal_min||null, sal_med||null, sal_max||null, rem_total_min||null, rem_total_med||null, rem_total_max||null, rem_anual_min||null, rem_anual_med||null, rem_anual_max||null, dataRef, agora)

    auditReq(req, "salarios.criar", `${cargo} (${area}/${nivel})`)
    res.json({ ok: true, id })
  } catch (e) {
    console.error("Erro ao salvar salários:", e.message)
    res.status(500).json({ erro: "Erro ao salvar dados salariais" })
  }
})


// ═══════════════════════════════════════════════════════════════
//  ROTA — EXPORTAR (bundle assinado com hash manifesto)
// ═══════════════════════════════════════════════════════════════

app.get("/exportar", (req, res) => {
  const { de, ate } = req.query
  let query = `
    SELECT v.id, v.cargo_id, v.cargo, v.area, v.nivel, v.texto,
           v.hash, v.hash_prev, v.criado_em,
           c.cargo as cargo_atual
    FROM versoes v
    LEFT JOIN cargos c ON v.cargo_id = c.id
    WHERE v.empresa_id = ?
  `
  const filtros = []
  const params  = [req.empresaId]
  if (de)  { filtros.push("v.criado_em >= ?"); params.push(de) }
  if (ate) { filtros.push("v.criado_em <= ?"); params.push(ate + "T23:59:59.999Z") }
  if (filtros.length) query += " AND " + filtros.join(" AND ")
  query += " ORDER BY v.id ASC"

  const versoes = db.prepare(query).all(...params)

  // Manifesto: SHA-256 de todos os hashes individuais concatenados em ordem de id
  const hashManifesto = createHash("sha256")
    .update(versoes.map(v => v.hash).join("|"))
    .digest("hex")

  const bundle = {
    sistema:        "JoyDescription",
    versaoSistema:  "1.0",
    exportadoEm:    new Date().toISOString(),
    filtro:         { de: de || null, ate: ate || null },
    totalVersoes:   versoes.length,
    hashManifesto,
    algoritmo:      "SHA-256",
    como_verificar: [
      "1. Para verificar um registro individual:",
      "   hash = SHA256(hash_prev + texto)  →  deve ser igual ao campo 'hash'",
      "2. Para verificar o manifesto:",
      "   hashManifesto = SHA256( hash[0] + '|' + hash[1] + '|' ... )  em ordem crescente de id",
      "3. Qualquer divergência indica adulteração."
    ],
    versoes
  }

  const filename = `joydesc-export-${new Date().toISOString().slice(0,10)}.json`
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.json(bundle)
})

// ═══════════════════════════════════════════════════════════════
//  ROTA — EXPORTAR HTML/PDF (relatório imprimível)
// ═══════════════════════════════════════════════════════════════

app.get("/exportar/pdf", (req, res) => {
  const { de, ate } = req.query
  let query = `
    SELECT v.id, v.cargo_id, v.cargo, v.area, v.nivel, v.texto,
           v.hash, v.hash_prev, v.criado_em
    FROM versoes v WHERE v.empresa_id = ? ORDER BY v.cargo ASC, v.id ASC
  `
  const filtros = []
  const params  = [req.empresaId]
  if (de)  { filtros.push("v.criado_em >= ?"); params.push(de) }
  if (ate) { filtros.push("v.criado_em <= ?"); params.push(ate + "T23:59:59.999Z") }
  if (filtros.length) query = query.replace("ORDER BY", "AND " + filtros.join(" AND ") + " ORDER BY")

  const versoes = db.prepare(query).all(...params)
  const hashManifesto = createHash("sha256")
    .update(versoes.map(v => v.hash).join("|"))
    .digest("hex")

  // agrupar por cargo_id
  const grupos = {}
  for (const v of versoes) {
    if (!grupos[v.cargo_id]) grupos[v.cargo_id] = { cargo: v.cargo, area: v.area, nivel: v.nivel, versoes: [] }
    grupos[v.cargo_id].versoes.push(v)
  }

  const formatDate = iso => {
    if (!iso) return ""
    const d = new Date(iso)
    return d.toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" })
  }

  const periodoTexto = (de || ate)
    ? `Período: ${de ? formatDate(de) : "início"} até ${ate ? formatDate(ate) : "hoje"}`
    : "Período: todo o histórico"

  const gruposHtml = Object.values(grupos).map((g, gi) => {
    const versoesHtml = g.versoes.map((v, i) => {
      const isPrimeira = i === 0
      const chain = isPrimeira
        ? `<span class="chain-tag chain-origem">versão inicial</span>`
        : `<span class="chain-tag chain-rev">revisão #${i + 1}</span>`
      return `
        <div class="versao-bloco">
          <div class="versao-meta-row">
            <span class="versao-num">${chain}</span>
            <span class="versao-data">${formatDate(v.criado_em)}</span>
            <span class="versao-hash" title="hash completo: ${v.hash}">#${v.hash.slice(0,14)}…</span>
          </div>
          <div class="versao-texto">${v.texto.replace(/\n/g, "<br>")}</div>
        </div>`
    }).join("")

    return `
      <div class="cargo-bloco ${gi > 0 ? "page-break" : ""}">
        <div class="cargo-header">
          <div class="cargo-title">${g.cargo}</div>
          <div class="cargo-meta">
            ${g.nivel ? `<span class="meta-pill">${g.nivel}</span>` : ""}
            ${g.area  ? `<span class="meta-pill meta-area">${g.area}</span>`  : ""}
            <span class="meta-pill meta-count">${g.versoes.length} versão${g.versoes.length > 1 ? "ões" : ""}</span>
          </div>
        </div>
        ${versoesHtml}
      </div>`
  }).join("")

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>JoyDescription — Relatório de Mudanças</title>
<style>
  @page { margin: 18mm 20mm; size: A4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #1e293b; background: #fff; }

  /* CAPA */
  .cover { display: flex; flex-direction: column; gap: 8px; margin-bottom: 28px; padding-bottom: 18px; border-bottom: 2px solid #e2e8f0; }
  .cover-brand { display: flex; align-items: baseline; gap: 4px; }
  .cover-joy  { font-size: 28px; font-weight: 800; color: #1e293b; letter-spacing: -1px; }
  .cover-desc { font-size: 28px; font-weight: 800; color: #94a3b8; letter-spacing: -1px; }
  .cover-sub  { font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: #94a3b8; margin-top: -4px; }
  .cover-title { font-size: 16px; font-weight: 700; color: #1e293b; margin-top: 12px; }
  .cover-periodo { font-size: 10.5px; color: #64748b; }
  .cover-data    { font-size: 10px; color: #94a3b8; }

  /* CAIXA DE INTEGRIDADE */
  .integrity-box {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-left: 4px solid #3b82f6;
    border-radius: 6px;
    padding: 11px 14px;
    margin-bottom: 24px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .integrity-title { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #3b82f6; }
  .integrity-hash  { font-family: 'Courier New', monospace; font-size: 10px; color: #1e293b; word-break: break-all; }
  .integrity-nota  { font-size: 9.5px; color: #64748b; line-height: 1.5; }
  .integrity-total { font-size: 10px; font-weight: 600; color: #475569; }

  /* CARGO */
  .cargo-bloco { margin-bottom: 28px; }
  .page-break  { page-break-before: auto; }
  .cargo-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: #1e293b;
    color: #fff;
    border-radius: 6px 6px 0 0;
    margin-bottom: 0;
  }
  .cargo-title { font-size: 13px; font-weight: 700; flex: 1; }
  .cargo-meta  { display: flex; gap: 5px; flex-wrap: wrap; }
  .meta-pill {
    font-size: 9px;
    padding: 2px 7px;
    border-radius: 99px;
    background: rgba(255,255,255,0.15);
    color: #fff;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .meta-area  { background: rgba(59,130,246,0.35); }
  .meta-count { background: rgba(16,185,129,0.35); }

  /* VERSÃO */
  .versao-bloco {
    border: 1px solid #e2e8f0;
    border-top: none;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .versao-bloco:last-child { border-radius: 0 0 6px 6px; }
  .versao-meta-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid #f1f5f9;
  }
  .versao-num  { flex: 1; }
  .versao-data { font-size: 9.5px; color: #64748b; }
  .versao-hash { font-family: 'Courier New', monospace; font-size: 9px; color: #94a3b8; }
  .chain-tag {
    font-size: 9px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .chain-origem { background: #dcfce7; color: #166534; }
  .chain-rev    { background: #dbeafe; color: #1d4ed8; }
  .versao-texto { font-size: 10.5px; line-height: 1.65; color: #334155; white-space: pre-wrap; }

  /* RODAPÉ */
  .rodape {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 1px solid #e2e8f0;
    font-size: 9px;
    color: #94a3b8;
    display: flex;
    justify-content: space-between;
  }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .cargo-bloco { page-break-inside: avoid; }
    .versao-bloco { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="cover">
  <div class="cover-brand">
    <span class="cover-joy">Joy</span><span class="cover-desc">Desc</span>
  </div>
  <div class="cover-sub">Gerador de Descrição de Cargos</div>
  <div class="cover-title">Relatório de Histórico de Modificações</div>
  <div class="cover-periodo">${periodoTexto}</div>
  <div class="cover-data">Gerado em ${formatDate(new Date().toISOString())}</div>
</div>

<div class="integrity-box">
  <div class="integrity-title">🔐 Integridade do Documento</div>
  <div class="integrity-total">${versoes.length} versões incluídas neste relatório</div>
  <div class="integrity-hash"><strong>Hash Manifesto SHA-256:</strong> ${hashManifesto}</div>
  <div class="integrity-nota">
    Verifique a autenticidade: para cada versão, recalcule SHA-256(hash_anterior + texto) e compare com o campo hash.
    O hash manifesto é SHA-256 de todos os hashes individuais concatenados com "|" em ordem de id crescente.
  </div>
</div>

${gruposHtml}

<div class="rodape">
  <span>JoyDescription — Relatório gerado automaticamente</span>
  <span>Hash: ${hashManifesto.slice(0,20)}…</span>
</div>

<script>
  window.addEventListener("load", () => setTimeout(() => window.print(), 600))
</script>
</body>
</html>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(html)
})

// ═══════════════════════════════════════════════════════════════
//  ROTAS — ÁREAS
// ═══════════════════════════════════════════════════════════════

app.get("/areas", (req, res) => {
  res.json(db.prepare("SELECT * FROM areas WHERE empresa_id = ?").all(req.empresaId))
})

app.post("/areas", (req, res) => {
  const { key, label, universo } = req.body
  if (!key?.trim() || !label?.trim() || !universo?.trim())
    return res.status(400).json({ erro: "Campos obrigatórios: key, label, universo" })
  try {
    db.prepare("INSERT INTO areas (empresa_id, key, label, universo) VALUES (?,?,?,?)").run(req.empresaId, key.trim(), label.trim(), universo.trim())
    auditReq(req, "area.criar", label.trim())
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
    WHERE key = ? AND empresa_id = ?
  `).run(label?.trim()||"", universo?.trim()||"", req.params.key, req.empresaId)

  if (info.changes === 0) return res.status(404).json({ erro: "Área não encontrada." })
  auditReq(req, "area.editar", label?.trim() || req.params.key)
  res.json({ ok: true })
})

app.delete("/areas/:key", (req, res) => {
  const area = db.prepare("SELECT label FROM areas WHERE key = ? AND empresa_id = ?").get(req.params.key, req.empresaId)
  const info = db.prepare("DELETE FROM areas WHERE key = ? AND empresa_id = ?").run(req.params.key, req.empresaId)
  if (info.changes === 0) return res.status(404).json({ erro: "Área não encontrada." })
  auditReq(req, "area.deletar", area?.label || req.params.key)
  res.json({ ok: true })
})


// ═══════════════════════════════════════════════════════════════
//  ROTAS — BASE DE CONHECIMENTO
// ═══════════════════════════════════════════════════════════════

app.get("/conhecimento", (req, res) => {
  res.json(db.prepare("SELECT * FROM conhecimento WHERE empresa_id = ? ORDER BY criadoEm ASC").all(req.empresaId).map(a => ({
    ...a, ativo: a.ativo === 1
  })))
})

app.post("/conhecimento", (req, res) => {
  try {
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
    db.prepare("INSERT INTO conhecimento (id,titulo,categoria,ativo,conteudo,criadoEm,empresa_id) VALUES (?,?,?,?,?,?,?)").run(
      novo.id, novo.titulo, novo.categoria, novo.ativo, novo.conteudo, novo.criadoEm, req.empresaId)
    auditReq(req, "conhecimento.criar", novo.titulo)
    res.json({ ok: true, id: novo.id })
  } catch (err) {
    console.error("POST /conhecimento:", err.message)
    res.status(500).json({ erro: "Erro ao salvar artigo: " + err.message })
  }
})

app.put("/conhecimento/:id", (req, res) => {
  try {
    const { titulo, categoria, conteudo, ativo } = req.body
    const ativoVal = typeof ativo === "boolean" ? (ativo ? 1 : 0) : null

    const info = db.prepare(`
      UPDATE conhecimento SET
        titulo    = COALESCE(NULLIF(?, ''), titulo),
        categoria = COALESCE(NULLIF(?, ''), categoria),
        conteudo  = COALESCE(NULLIF(?, ''), conteudo),
        ativo     = CASE WHEN ? IS NOT NULL THEN ? ELSE ativo END,
        editadoEm = ?
      WHERE id = ? AND empresa_id = ?
    `).run(
      titulo?.trim()||"", categoria?.trim()||"", conteudo?.trim()||"",
      ativoVal, ativoVal, new Date().toISOString(), req.params.id, req.empresaId)

    if (info.changes === 0) return res.status(404).json({ erro: "Artigo não encontrado." })
    auditReq(req, "conhecimento.editar", titulo?.trim() || req.params.id)
    res.json({ ok: true })
  } catch (err) {
    console.error("PUT /conhecimento:", err.message)
    res.status(500).json({ erro: "Erro ao atualizar artigo: " + err.message })
  }
})

app.delete("/conhecimento/:id", (req, res) => {
  try {
    const artigo = db.prepare("SELECT titulo FROM conhecimento WHERE id = ? AND empresa_id = ?").get(req.params.id, req.empresaId)
    const info = db.prepare("DELETE FROM conhecimento WHERE id = ? AND empresa_id = ?").run(req.params.id, req.empresaId)
    if (info.changes === 0) return res.status(404).json({ erro: "Artigo não encontrado." })
    auditReq(req, "conhecimento.deletar", artigo?.titulo)
    res.json({ ok: true })
  } catch (err) {
    console.error("DELETE /conhecimento:", err.message)
    res.status(500).json({ erro: "Erro ao deletar artigo: " + err.message })
  }
})


// ═══════════════════════════════════════════════════════════════
//  ROTAS — NÍVEIS
// ═══════════════════════════════════════════════════════════════

app.get("/niveis", (req, res) => {
  res.json(db.prepare("SELECT * FROM niveis WHERE empresa_id = ? ORDER BY ordem ASC").all(req.empresaId))
})

app.post("/niveis", (req, res) => {
  const { label, ordem = 0, eh_lideranca = 0, descricao = "", descricao_curta = "" } = req.body
  if (!label?.trim()) return res.status(400).json({ erro: "label obrigatório" })
  const maxOrdem = db.prepare("SELECT MAX(ordem) as m FROM niveis WHERE empresa_id = ?").get(req.empresaId).m ?? 0
  try {
    db.prepare("INSERT INTO niveis (empresa_id,label,ordem,eh_lideranca,descricao,descricao_curta) VALUES (?,?,?,?,?,?)")
      .run(req.empresaId, label.trim(), ordem || maxOrdem + 1, eh_lideranca ? 1 : 0, descricao, descricao_curta)
    auditReq(req, "nivel.criar", label.trim())
    res.json({ ok: true })
  } catch (e) {
    if (e.message?.includes("UNIQUE")) return res.status(409).json({ erro: "Já existe um nível com esse nome." })
    throw e
  }
})

app.put("/niveis/:label", (req, res) => {
  const labelAtual = decodeURIComponent(req.params.label)
  const { label, ordem, eh_lideranca, descricao, descricao_curta } = req.body
  if (!label?.trim()) return res.status(400).json({ erro: "label obrigatório" })
  try {
    const info = db.prepare(
      "UPDATE niveis SET label=?, ordem=?, eh_lideranca=?, descricao=?, descricao_curta=? WHERE label=? AND empresa_id=?"
    ).run(label.trim(), ordem ?? 0, eh_lideranca ? 1 : 0, descricao ?? "", descricao_curta ?? "", labelAtual, req.empresaId)
    if (info.changes === 0) return res.status(404).json({ erro: "Nível não encontrado." })
    auditReq(req, "nivel.editar", label.trim())
    res.json({ ok: true })
  } catch (e) {
    if (e.message?.includes("UNIQUE")) return res.status(409).json({ erro: "Já existe um nível com esse nome." })
    throw e
  }
})

app.delete("/niveis/:label", (req, res) => {
  const label = decodeURIComponent(req.params.label)
  const info = db.prepare("DELETE FROM niveis WHERE label = ? AND empresa_id = ?").run(label, req.empresaId)
  if (info.changes === 0) return res.status(404).json({ erro: "Nível não encontrado." })
  auditReq(req, "nivel.deletar", label)
  res.json({ ok: true })
})

// ═══════════════════════════════════════════════════════════════
//  ROTAS — UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════
//  ROTA — ANÁLISE JURÍDICA
// ═══════════════════════════════════════════════════════════════

app.post("/analisar", async (req, res) => {
  const { cargo, nivel, texto, provedor = "groq" } = req.body
  if (!cargo || !nivel || !texto?.trim())
    return res.status(400).json({ erro: "Campos obrigatórios: cargo, nivel, texto" })

  const niveisRows = db.prepare("SELECT * FROM niveis WHERE label = ? AND empresa_id = ?").get(nivel, req.empresaId)
  const ehLider    = niveisRows?.eh_lideranca === 1 || ["Coordenador","Gestor","Gerente","Diretor"].includes(nivel)

  const descNivel = niveisRows?.descricao_curta || NIVEL_CURTO[nivel] || ""
  const descNivelCompleta = niveisRows?.descricao || NIVEL_DEF[nivel] || ""

  // Separa PODE/VERBOS PERMITIDOS do perfil completo para injetar no prompt
  const linhasPermitidas = descNivelCompleta
    .split("\n")
    .filter(l => /PODE|VERBOS PERMITIDOS|FUNCOES OBRIGATÓRIAS/i.test(l))
    .join("\n")
    .slice(0, 600)

  const prompt = `Você é um especialista em legislação trabalhista brasileira (CLT) e gestão de RH.
Analise a descrição de cargo abaixo e retorne APENAS um JSON válido, sem texto adicional.

CARGO: ${cargo}
NÍVEL: ${nivel}
É CARGO DE LIDERANÇA (CLT art.62 II): ${ehLider ? "SIM — gestão de subordinados é OBRIGATÓRIA e ESPERADA" : "NÃO — cargo técnico/operacional sem subordinados formais"}

REFERÊNCIA DO NÍVEL "${nivel}" (use isto para julgar o que é correto ou errado):
${linhasPermitidas || descNivel}

DEFINIÇÃO LEGAL IMPORTANTE:
- "Gestão de pessoas" no sentido da CLT = ter subordinados com poder disciplinar, avaliar desempenho formal, contratar/demitir. Só é problema em cargo NÃO liderança.
- "Liderança técnica", "orientar", "desenvolver profissionais", "mentorar", "liderar projetos técnicos" = funções TÉCNICAS, NÃO são gestão de pessoas pela CLT. São permitidas e esperadas em níveis Sênior/Especialista.
- Verbos como "elaborar", "definir", "estruturar", "validar", "homologar" são típicos de nível Sênior — NÃO são alertas.

DESCRIÇÃO A ANALISAR:
${texto.slice(0, 2500)}

Retorne este JSON exato (sem markdown, sem explicações):
{
  "aprovado": true ou false,
  "score": número de 0 a 100,
  "alertas": [
    { "descricao": "descrição do problema", "sugestao": "como corrigir", "gravidade": "critico|moderado|leve" }
  ],
  "pontos_ok": ["ponto positivo 1", "ponto positivo 2"]
}

CHECKLIST — avalie cada item e gere alerta SOMENTE se realmente ocorrer:

${ehLider
  ? `☑ LIDERANÇA SEM GESTÃO DE PESSOAS: a descrição omite coordenação de equipe, avaliação de desempenho ou distribuição de atividades? → "critico" (score -30). Se menciona, NÃO é alerta.`
  : `☑ NÃO-LIDERANÇA COM GESTÃO DE SUBORDINADOS: a descrição menciona ter subordinados formais, contratar/demitir, poder disciplinar? → "critico" (score -30). "Liderar tecnicamente", "orientar", "desenvolver" NÃO contam como gestão de subordinados.`}
☑ DESCRIÇÃO GENÉRICA: contém "atividades diversas", "outras atividades" ou similar sem especificar? → "moderado" (score -15)
☑ MISTURA DE NÍVEIS: atribui ao cargo funções que são exclusivas de um nível muito diferente e que NÃO constam como permitidas no perfil acima? → "moderado" (score -20). Se a função está no perfil do nível, NÃO é mistura.
☑ ESCOPO INDEFINIDO: não é possível entender em qual área/processo o profissional atua? → "moderado" (score -10)
☑ VERBO INADEQUADO: usa verbos que contradizem o nível (ex: Estágio com "definir estratégia" ou Diretor com "executar tarefas operacionais")? → "leve" (score -5). Verbos listados no perfil do nível NÃO são alerta.

Score inicial: 100. Subtraia apenas pelos alertas gerados. aprovado = true se score final >= 70`

  const client = GROQ_KEY ? groqClient : togetherClient
  const model  = GROQ_KEY ? GROQ_MODEL : TOGETHER_MODEL

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Você é um analisador jurídico de descrições de cargo. Responda APENAS com JSON válido." },
        { role: "user",   content: prompt }
      ],
      temperature: 0.1,
      max_tokens:  900,
    })

    let raw = completion.choices[0]?.message?.content?.trim() || "{}"
    // remove possível markdown ```json ... ```
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim()

    let resultado
    try {
      resultado = JSON.parse(raw)
    } catch {
      resultado = { aprovado: false, score: 0, alertas: [{ descricao: "Não foi possível analisar o texto.", sugestao: "", gravidade: "moderado" }], pontos_ok: [] }
    }

    res.json(resultado)
  } catch (err) {
    console.error("Erro análise jurídica:", err.message)
    res.status(500).json({ erro: "Falha na análise: " + err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  ROTA — CORREÇÃO JURÍDICA (streaming)
// ═══════════════════════════════════════════════════════════════

app.post("/corrigir", async (req, res) => {
  const { cargo, nivel, texto, alerta, provedor = "groq" } = req.body
  if (!cargo || !nivel || !texto?.trim() || !alerta)
    return res.status(400).json({ erro: "Campos obrigatórios: cargo, nivel, texto, alerta" })

  const prompt = `Você é um revisor especialista em descrições de cargo conforme a CLT brasileira.
Corrija APENAS o trecho problemático da descrição abaixo, mantendo todo o resto exatamente igual.
Retorne somente a descrição corrigida completa, sem explicações, sem markdown extra além do que já existe.

CARGO: ${cargo}
NÍVEL: ${nivel}

PROBLEMA IDENTIFICADO: ${alerta.descricao}
SUGESTÃO DE CORREÇÃO: ${alerta.sugestao}

TEXTO ATUAL:
${texto.slice(0, 3000)}

TEXTO CORRIGIDO:`

  const client = GROQ_KEY ? groqClient : togetherClient
  const model  = GROQ_KEY ? GROQ_MODEL : TOGETHER_MODEL

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Você é um revisor de descrições de cargo. Retorne apenas o texto corrigido." },
        { role: "user",   content: prompt }
      ],
      temperature: 0.2,
      max_tokens:  1200,
      stream: true,
    })

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content
      if (token) send({ texto: token })
    }

    send({ fim: true })
  } catch (err) {
    console.error("Erro correção jurídica:", err.message)
    send({ erro: "Falha na correção: " + err.message })
  } finally {
    res.end()
  }
})

// ═══════════════════════════════════════════════════════════════

app.get("/health", (_, res) => {
  res.json({
    status:        "ok",
    cbo_ocupacoes: cboBase.length,
    groq:          GROQ_KEY    ? "configurado (" + GROQ_MODEL + ")"    : "não configurado",
    together:      TOGETHER_KEY ? "configurado (" + TOGETHER_MODEL + ")" : "não configurado"
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
  const { cargo, area, nivel, tipo = "Híbrido" } = req.body

  if (!cargo?.trim() || !area || !nivel)
    return res.status(400).json({ erro: "Campos obrigatórios: cargo, area, nivel" })

  if (!GROQ_KEY && !TOGETHER_KEY)
    return res.status(500).json({ erro: "Nenhuma API de IA configurada. Configure GROQ_API_KEY ou TOGETHER_API_KEY." })

  res.setHeader("Content-Type",  "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection",    "keep-alive")
  res.flushHeaders()

  let   activeClient = GROQ_KEY ? groqClient : togetherClient
  let   activeModel  = GROQ_KEY ? GROQ_MODEL : TOGETHER_MODEL
  let   didFailover  = false

  // Wrapper com failover automático Groq → Together AI
  const criarStream = async (params) => {
    try {
      return await activeClient.chat.completions.create({ ...params, model: activeModel })
    } catch (err) {
      const status = err.status ?? err.statusCode ?? 0
      console.error(`❌ Groq erro ${status}:`, err.message)

      // 429 = rate limit — tenta Together AI se disponível
      if (status === 429 && TOGETHER_KEY && !didFailover) {
        didFailover  = true
        activeClient = togetherClient
        activeModel  = TOGETHER_MODEL
        console.warn("⚠️  Groq rate limit — failover para Together AI")
        res.write(`data: ${JSON.stringify({ tipo: "failover", para: "together" })}\n\n`)
        return await activeClient.chat.completions.create({ ...params, model: activeModel })
      }

      if (status === 429) {
        const retry = err.headers?.["retry-after"] ?? "60"
        throw new Error(`Limite de requisições atingido. Aguarde ${retry}s.`)
      }

      // Outros erros: failover para Together AI
      if (TOGETHER_KEY && !didFailover) {
        didFailover  = true
        activeClient = togetherClient
        activeModel  = TOGETHER_MODEL
        console.warn("⚠️  Groq indisponível — failover para Together AI:", err.message)
        res.write(`data: ${JSON.stringify({ tipo: "failover", para: "together" })}\n\n`)
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

    const ctx = db.prepare("SELECT * FROM areas WHERE key = ? AND empresa_id = ?").get(area, req.empresaId)
    if (ctx) pensar(`Contexto do setor carregado — ${ctx.universo.slice(0, 80)}...`)

    pensar(`Buscando correspondências no CBO 2002...`)
    const candidatos = buscarCBO(cargo, area, 25, req.empresaId)

    if (candidatos.length > 0) {
      pensar(`${candidatos.length} candidatos CBO encontrados:`)
      candidatos.slice(0, 5).forEach(c => pensar(`  · ${c.codigo} — ${c.cargo}`))
    } else {
      pensar(`Nenhum CBO exato encontrado — IA irá inferir o mais próximo`)
    }

    const artigos = db.prepare("SELECT titulo FROM conhecimento WHERE ativo = 1 AND empresa_id = ?").all(req.empresaId)
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

    console.log(`🤖 Gerando via ${didFailover ? "Together AI (" + TOGETHER_MODEL + ")" : "Groq (" + GROQ_MODEL + ")"}`)

    const SYS = "Você é especialista sênior em RH de usinas sucroenergéticas. Siga o formato EXATAMENTE como solicitado. PROIBIDO adicionar qualquer texto fora do template — sem introduções, sem conclusões, sem comentários."

    const niveisRows = db.prepare("SELECT * FROM niveis WHERE empresa_id = ?").all(req.empresaId)
    const nm = Object.fromEntries(niveisRows.map(n => [n.label, n]))

    const promptGen = montarPromptGenerica(cargo, area, nivel, tipo, candidatos, nm, req.empresaId)
    const promptDet = montarPrompt(cargo, area, nivel, tipo, candidatos, nm, req.empresaId)

    // ── Genérica ──────────────────────────────────────────────────
    res.write(`data: ${JSON.stringify({ tipo: "secao", nome: "generica" })}\n\n`)

    const streamGen = await criarStream({
      stream: true, temperature: 0.2, max_tokens: 900,
      messages: [
        { role: "system", content: SYS },
        { role: "user",   content: promptGen }
      ]
    })
    for await (const chunk of streamGen) {
      const delta = chunk.choices[0]?.delta?.content ?? ""
      if (delta) res.write(`data: ${JSON.stringify({ texto: delta })}\n\n`)
    }

    // ── Detalhada ─────────────────────────────────────────────────
    res.write(`data: ${JSON.stringify({ tipo: "secao", nome: "detalhada" })}\n\n`)

    const streamDet = await criarStream({
      stream: true, temperature: 0.2, max_tokens: 1600,
      messages: [
        { role: "system", content: SYS },
        { role: "user",   content: promptDet }
      ]
    })
    for await (const chunk of streamDet) {
      const delta = chunk.choices[0]?.delta?.content ?? ""
      if (delta) res.write(`data: ${JSON.stringify({ texto: delta })}\n\n`)
    }

    // ── Gerar dados salariais (Base + IA Ponderada) ──────────────────
    try {
      pensar(`Consultando RAIS, CAGED, UNICA para faixa salarial...`)

      // 1️⃣ Buscar na base de referência (RAIS, CAGED, UNICA, SINDICAR)
      let salarioRef = buscarSalarioReferencia(cargo, area, nivel)

      // 2️⃣ Se não encontrar, chamar IA com contexto de dados oficiais
      if (!salarioRef) {
        pensar(`Gerando estimativa com base em tendências de mercado...`)

        const promptSalarios = `Estime o salário REALISTA do cargo no Centro-Oeste (Glassdoor + Salário.com.br).

Cargo: ${cargo} | Área: ${area} | Nível: ${nivel}

Valores CONSERVADORES e realistas (não inflacionados). Retorne JSON:
{"sal_min":0,"sal_med":0,"sal_max":0}`

        const streamSalarios = await criarStream({
          stream: false,
          temperature: 0.1,
          max_tokens: 100,
          messages: [
            { role: "system", content: "Responda APENAS com JSON válido numérico." },
            { role: "user", content: promptSalarios }
          ]
        })

        const textSalarios = streamSalarios.choices[0]?.message?.content ?? "{}"
        try {
          const jsonMatch = textSalarios.match(/\{[^{}]*\}/)
          const dadosIA = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
          if (dadosIA.sal_med) {
            salarioRef = {
              sal_min: Math.round(dadosIA.sal_min || dadosIA.sal_med * 0.80),
              sal_med: Math.round(dadosIA.sal_med),
              sal_max: Math.round(dadosIA.sal_max || dadosIA.sal_med * 1.25),
              fonte: "Estimativa IA"
            }
          }
        } catch (e) {
          console.warn("Erro no parse de IA:", e.message)
        }
      }

      // 3️⃣ Calcular remuneração total (salário + benefícios mínimos)
      const FATOR_BENEFICIOS = 1.15 // VT + VR (média 15%)
      const salariesData = salarioRef ? {
        sal_min: salarioRef.sal_min,
        sal_med: salarioRef.sal_med,
        sal_max: salarioRef.sal_max,
        rem_total_min: Math.round(salarioRef.sal_min * FATOR_BENEFICIOS),
        rem_total_med: Math.round(salarioRef.sal_med * FATOR_BENEFICIOS),
        rem_total_max: Math.round(salarioRef.sal_max * FATOR_BENEFICIOS),
        fonte: salarioRef.fonte
      } : null

      // 4️⃣ Emitir dados salariais
      if (salariesData) {
        res.write(`data: ${JSON.stringify({ tipo: "salarios", dados: salariesData })}\n\n`)

        // Salvar no banco de dados
        const salarioId = randomBytes(16).toString("hex")
        const agora = new Date().toISOString()
        const dataRef = agora.substring(0, 7)

        try {
          db.prepare(`
            INSERT INTO salarios_cargo
            (id, cargo, area, nivel, empresa_id, setor, regiao, sal_min, sal_med, sal_max, rem_total_min, rem_total_med, rem_total_max, data_ref, criado_em)
            VALUES (?, ?, ?, ?, ?, 'sucroenergético', 'Centro-Oeste', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(salarioId, cargo, area, nivel, req.empresaId, salariesData.sal_min, salariesData.sal_med, salariesData.sal_max, salariesData.rem_total_min, salariesData.rem_total_med, salariesData.rem_total_max, dataRef, agora)

          console.log(`✅ Salários (${salariesData.fonte}): ${cargo} (${area}/${nivel}) → R$ ${salariesData.sal_med}`)
        } catch (dbErr) {
          console.error("Erro ao salvar salários:", dbErr.message)
        }
      } else {
        res.write(`data: ${JSON.stringify({ tipo: "salarios", dados: null })}\n\n`)
      }
    } catch (salErr) {
      console.error("Erro ao processar salários:", salErr.message)
      res.write(`data: ${JSON.stringify({ tipo: "salarios", dados: null })}\n\n`)
    }

    res.write(`data: ${JSON.stringify({ fim: true })}\n\n`)
    res.end()

  } catch (err) {
    console.error(`❌ Erro IA:`, err.message)
    res.write(`data: ${JSON.stringify({ erro: err.message })}\n\n`)
    res.end()
  }
})


// ═══════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════

// Static depois de todas as rotas — rotas da API têm prioridade
app.use(express.static(__dirname))

app.listen(PORT, () => {
  console.log(`\n🚀 JoyDescription → http://localhost:${PORT}`)
  console.log(`⚡ Groq:    ${GROQ_KEY     ? "✅ configurado (" + GROQ_MODEL     + ")" : "❌ sem API key"}`)
  console.log(`🔀 Together:${TOGETHER_KEY ? "✅ configurado (" + TOGETHER_MODEL + ")" : "❌ sem API key (failover inativo)"}`)
  console.log(`🗄️  Banco:   joydescription.db\n`)
})
