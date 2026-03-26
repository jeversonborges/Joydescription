# JoyDescription — Documentacao do Projeto

> Gerador de descricoes de cargo com IA para o setor sucroenergetico.
> Desenvolvido por Joyce / Jeverson Borges.

---

## O que e

Sistema web multi-tenant para o departamento de RH criar e gerenciar descricoes de cargos usando IA (Groq/LLaMA). Cada empresa tem seus proprios dados isolados por `empresa_id`. Inclui pesquisa salarial com dados ancorados no CAGED/MTE, dashboard comparativo, exportacao PDF, e base de conhecimento.

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Backend | Node.js + Express (ESM) — `server.mjs` |
| Banco | SQLite via `better-sqlite3` |
| IA | Groq API (llama-3.3-70b-versatile) + Together AI (failover) |
| Frontend | HTML + CSS + JS vanilla (sem framework) — SPA unica |
| Deploy | Railway (com volume persistente `/data`) |
| Autenticacao | Cookie `joy_session` + scrypt |
| Icones | Unicons (CDN) |

---

## Repositorio e Deploy

| Item | Valor |
|------|-------|
| GitHub | `github.com/jeversonborges/Joydescription` |
| Branch principal | `main` |
| Hospedagem | Railway (rebuild automatico via GitHub) |
| Railway Project ID | `caa7b613-78fa-4647-bbf5-c97439f2a281` |
| Deploy manual | `railway up` (CLI) |
| URL producao | Configurada no Railway (dominio gerado automatico) |

### Método CORRETO de Deploy (use sempre esse)
```bash
git add .
git commit -m "descricao da mudança"
git push
railway up
```

Aguarda 3-5 minutos. Confirma visual: a splash screen mostra `v1.0` (ou a versão atual).

### Diferença entre railway up e railway redeploy

| Comando | O que faz | Quando usar |
|---------|-----------|-------------|
| `railway up` | **Faz build novo** com o código atual — pega todas as mudanças | Sempre que mudar código |
| `railway redeploy --yes` | Reinicia o container já buildado — **NÃO pega código novo** | Só para reiniciar após crash |

**Regra:** Mudou código → sempre `railway up`. Nunca depender só do push automático do GitHub.

---

## Bugs de Deploy Conhecidos — NÃO repita esses erros

### Bug 1: `railway down` trava esperando confirmação
- **O que acontece:** `railway down` pede "y/N" interativo e trava o terminal
- **Solução:** Use `railway redeploy --yes` em vez de down+up
- **Nunca use:** `railway down` sem `echo y |` na frente

### Bug 2: Mudanças no código não aparecem no site
- **Causa real encontrada:** Arquivos frontend (index.html, style.css, script.js) eram hardcoded com dados desatualizados, enquanto o banco já tinha os dados novos
- **Exemplo:** Dropdown de nível na Pesquisa Salarial estava fixo no HTML com lista antiga — não buscava do banco
- **Regra:** Sempre que adicionar/remover opções de um `<select>`, verificar se ele é hardcoded no HTML ou dinâmico via JS. Se for hardcoded, atualizar o HTML também.
- **Como verificar:** `grep -n "option value" index.html`

### Bug 3: Railway servindo versão antiga mesmo após deploy
- **Causa:** Railway tem cache de container. `railway up` envia o código mas pode não reiniciar o container imediatamente
- **Sintoma:** `railway logs` mostra servidor rodando mas sem as novas mensagens de migração
- **Solução definitiva:** `railway redeploy --yes` → força rebuild completo
- **Verificação:** Após deploy, checar `railway logs` e confirmar timestamp recente

### Bug 4: Migração de banco não roda
- **Causa:** Migrações com `INSERT OR IGNORE` ou verificação `if count > 0` não rodam se o dado já existe
- **Sintoma:** Banco tá certo mas site não mostra mudança (confunde com bug de deploy)
- **Solução:** Sempre criar migração separada que verifica coluna/dado específico, não a tabela inteira
- **Exemplo correto:**
```js
const temSuperintendente = db.prepare("SELECT COUNT(*) as n FROM niveis WHERE label='Superintendente'").get().n > 0
if (!temSuperintendente) { /* insere */ }
```

### Checklist antes de dizer "não subiu"
1. `git log --oneline -3` — commit foi feito?
2. `git push` — foi para o GitHub?
3. `railway logs` — timestamp do servidor é recente?
4. O elemento mudado é **hardcoded no HTML** ou **dinâmico do banco**?
5. Se dinâmico: a migração rodou? (verificar nos logs)
6. Se hardcoded: o arquivo HTML/CSS/JS foi atualizado e commitado?

---

## PDF de Pesquisa Salarial — Como Funciona e Como Editar

### Rota
`GET /exportar/salarios-pdf` — server.mjs, linha ~1784

### Estrutura do PDF (ordem das seções)
1. **Header/Cover** — logo JoyDesc, título, data, total de cargos
2. **Avisos Importantes** — caixa VERMELHA com 4 itens: adequação, fontes, interpolações, responsabilidade
3. **Rastreabilidade e Auditoria** — grid 2x3 com metadados (data, total, região, período, versão, endpoint)
4. **Metodologia, Fontes e Cálculos** — box azul com fórmulas, grid de 6 cards de fontes, exemplo passo-a-passo
5. **Resumo por Área** — cards com total e mediana de cada área
6. **Tabela de Detalhamento** — colunas: Cargo, Área, Nível, Fonte (📋/🤖), Sal Min/Med/Max, Rem Total Min/Med/Max, Obs
7. **Rodapé** — assinatura + data

### Fontes e Pesos (NUNCA mudar sem atualizar AUDITORIA.md)
- CAGED/MTE: **60%**
- Dissídio.com.br: **25%**
- Glassdoor Brasil: **15%**

### Fórmulas
```
Salário PLENO = CAGED×0.60 + Dissídio×0.25 + Glassdoor×0.15
Salário por nível = PLENO × fator_nivel
Faixas = mediana ±18% (quando não fornecido pela IA)
Remuneração total = salário_base × 1.15 (VT + VR + convênio)
```

### Hierarquia de Níveis (Goiás — Usinas Sucroenergéticas)
| Nível | Fator | Observação |
|-------|-------|-----------|
| Trainee | 0.60 | |
| Junior | 0.80 | |
| Pleno | 1.00 | **base de cálculo** |
| Senior | 1.25 | |
| Especialista | 1.40 | |
| Coordenador | 1.55 | |
| Gerente | 1.80 | Responsável por área com múltiplos operacionais |
| Gestor | 2.10 | Responsável exclusivo em áreas sem gerente |
| Superintendente | 2.70 | Cargo mais alto na usina, acima de Gestor |
| Diretor | 3.50 | Raramente presente na usina local |

> **Estágio não existe nas usinas goianas** — removido do sistema.

### Rastreabilidade de Auditoria
Cada pesquisa salva guarda:
- `fonte_tipo`: `manual` | `ia_groq` | `ia_together`
- `ia_prompt`: prompt exato enviado à IA
- `ia_resposta`: resposta bruta da IA
- `versao_ref`: versão da metodologia usada

Para auditar um valor: `GET /pesquisas-salariais/:id/auditoria`

### Limites de Validação da IA
Valores fora do range são rejeitados silenciosamente:
- Mínimo para PLENO: R$ 1.200
- Máximo para PLENO: R$ 50.000

### Como editar o PDF
Toda a lógica está em **server.mjs** na função `app.get("/exportar/salarios-pdf", ...)`.
O HTML é gerado via template literal. CSS está inline dentro do `<style>`.
Para alterar layout: editar o CSS. Para alterar dados: editar a query SQL ou o template.

---

## Estrutura de arquivos

```
server.mjs                    — servidor Express, todas as rotas de API (~2900 linhas)
index.html                    — SPA unica (login + app, todas as abas)
script.js                     — toda a logica do front-end (~2400 linhas)
style.css                     — estilos (tema escuro, CSS vars, ~3200 linhas)
salarios-referencia.json      — tabela de salarios reais por area/cargo/nivel (CAGED/MTE)
defasagem-salarial-goias.txt  — conhecimento de defasagem regional Sul Goiano vs SP
joydescription.db             — banco SQLite local (nao vai pro Git)
railway.json                  — config de deploy Railway
Dockerfile                    — build para Railway
.env                          — chaves de API (nao vai pro Git)
.gitignore                    — exclui node_modules, .db, .env, WAL files
PROJETO.md                    — este arquivo
```

---

## Variaveis de ambiente

| Var | Descricao |
|-----|-----------|
| `GROQ_API_KEY` | Chave da API Groq (obrigatoria) |
| `GROQ_MODEL` | Modelo Groq (default: `llama-3.3-70b-versatile`) |
| `TOGETHER_API_KEY` | Chave Together AI (opcional, failover) |
| `TOGETHER_MODEL` | Modelo Together (default: `meta-llama/Llama-3.3-70B-Instruct-Turbo`) |
| `JOY_DB_PATH` | Caminho do banco no volume Railway (`/data/joydescription.db`) |
| `JOY_FORCE_SEED` | `1` para forcar seed do banco (so migracao) |
| `NODE_ENV` | `production` em Railway (Secure cookie, CORS restrito) |
| `PORT` | Railway injeta automaticamente |

---

## Banco de dados — tabelas

```sql
empresas              — id, nome, criado_em
usuarios              — id, empresa_id, nome, email, senha_hash (scrypt), papel (admin|membro), ativo
sessoes               — token, usuario_id, empresa_id, expira_em (30 dias)
cargos                — id, empresa_id, cargo, area, nivel, texto, criadoEm, editadoEm
versoes               — id, cargo_id, empresa_id, cargo, area, nivel, texto, hash, hash_prev, criado_em
areas                 — empresa_id, key, label, universo
conhecimento          — id, empresa_id, titulo, categoria, conteudo, ativo, criadoEm
niveis                — empresa_id, label, ordem, eh_lideranca, descricao, descricao_curta
pesquisas_salariais   — id, cargo, area, nivel, empresa_id, setor, regiao, sal_min/med/max, rem_total_min/med/max, observacoes, criado_em, atualizado_em
salarios_cargo        — id, cargo_id, empresa_id, cargo, area, nivel, sal_min/med/max, rem_total_min/med/max, fonte, data_ref
backups_log           — id, usuario_nome, usuario_email, empresa_id, tamanho_bytes, criado_em
backup_config         — empresa_id PK, ativo, intervalo_horas, proximo_em
audit_log             — id, empresa_id, usuario_id, usuario_nome, acao, alvo, ip, criado_em
```

**Regra de ouro:** toda query filtra por `WHERE empresa_id = ?`. Nenhuma empresa ve dados de outra.

---

## Abas do sistema (frontend)

1. **Descricao de Cargo** (`descricao`) — Gerador principal com IA via SSE streaming
2. **Cargos** (`cargos`) — Lista de cargos gerados, historico de versoes, exportar PDF
3. **Pesquisa Salarial** (`salarios`) — Pesquisa salarial com IA, dashboard donut chart, exportar PDF individual
4. **Conhecimento** (`conhecimento`) — Base de conhecimento injetada nos prompts de IA
5. **Gerenciar Areas** (`areas`) — CRUD de areas com geracao de descricao por IA
6. **Gerenciar Niveis** (`niveis`) — Hierarquia de niveis com descricoes legais detalhadas
7. **Usuarios** (`usuarios`) — Gestao de usuarios (admin only)

Modais: Calendario, Backup, Seguranca, Auditoria (admin only no menu superior)

---

## Rotas de API

### Autenticacao
```
POST /auth/registrar    — cria empresa + admin (rate limited)
POST /auth/login        — login (rate limited: 10/15min)
POST /auth/logout
GET  /auth/me           — retorna usuario e empresa da sessao
```

### Cargos
```
GET/POST/PUT/DELETE /cargos/:id
GET  /versoes/:cargo_id              — historico de versoes
GET  /versoes/:cargo_id/:id/texto    — texto de uma versao
GET  /changelog                      — ultimas 200 versoes
```

### Areas / Conhecimento / Niveis
```
GET/POST/PUT/DELETE /areas/:key
GET/POST/PUT/DELETE /conhecimento/:id
GET/POST/PUT/DELETE /niveis/:label
```

### Pesquisa Salarial
```
GET    /pesquisas-salariais          — lista todas (por empresa)
POST   /pesquisas-salariais          — cria nova pesquisa
PUT    /pesquisas-salariais/:id      — edita pesquisa
DELETE /pesquisas-salariais/:id      — deleta pesquisa
POST   /gerar-pesquisa-salarial      — gera estimativa salarial com IA
```

### IA / Geracao
```
POST /gerar              — gera descricao de cargo (SSE streaming)
POST /analisar           — analise juridica do texto
POST /corrigir           — reescrita/correcao
POST /gerar-descricao-area — gera descricao de area com IA
GET  /sugestoes          — sugestoes de cargos similares
```

### Exportacao
```
GET /exportar            — exporta versoes assinadas (JSON + hash)
GET /exportar/pdf        — PDF de descricao de cargo (auditoria)
GET /exportar/salarios-pdf       — relatorio geral de salarios (landscape A4)
GET /exportar/salario-pdf/:id    — PDF individual de pesquisa salarial
```

### Usuarios / Backup / Auditoria (admin)
```
GET/POST/PUT/DELETE /usuarios/:id
GET  /backup/status | /backup/historico | /backup/download
POST /backup/restaurar | POST /backup/config
GET  /auditoria?acao=&usuario=&limit=100&offset=0
```

### Utilidades
```
GET /cbo?q=texto         — busca CBO (11097 ocupacoes indexadas)
GET /health              — healthcheck
```

---

## Sistema de Salarios — como funciona

### Fluxo de estimativa salarial
1. Usuario informa cargo + area + nivel
2. Sistema busca na **tabela de referencia** (`salarios-referencia.json`) — dados reais do CAGED/MTE via salario.com.br
3. Se encontrar: retorna direto da tabela (sem IA)
4. Se NAO encontrar: chama IA com prompt ancorado em referencias reais do Sul Goiano
5. IA retorna salario base de nivel **PLENO** (sempre)
6. Servidor aplica **fator multiplicador fixo** por nivel:
   - Estagio: x0.35 | Trainee: x0.50 | Junior: x0.72
   - Pleno: x1.00 | Senior: x1.30 | Especialista: x1.45
   - Coordenador: x1.60 | Gestor: x1.90 | Gerente: x2.40 | Diretor: x3.50
7. Remuneracao total = salario base x 1.15 (VT + VR + convenio)

### Fontes de dados
- **CAGED/MTE via salario.com.br** (peso 60%) — dados oficiais CLT
- **Dissidio.com.br** (peso 25%) — pisos sindicais
- **Glassdoor Brasil** (peso 15%) — informado por profissionais

### Arquivo `salarios-referencia.json`
Tabela com ~80 cargos organizados por area (producao, manutencao, qualidade, agricola, rh, administrativo, engenharia, ti, logistica, meio_ambiente), cada um com faixas min/med/max por nivel. Dados calibrados para usinas de cana do Sul Goiano.

### Arquivo `defasagem-salarial-goias.txt`
Relatorio de defasagem regional Sul Goiano vs Interior SP. Carregado na inicializacao do servidor na variavel `defasagemSalarial`. Contem fatores de ajuste por tipo de cargo.

### Dashboard (frontend)
- Grafico donut (CSS conic-gradient) com 4 fontes: Glassdoor, Dissidio, CAGED, Portal Salario
- Range bar min-mediana-max com marcadores visuais
- Input "Valor da usina" para comparar posicionamento (abaixo/na media/acima)
- Texto explicativo gerado dinamicamente
- Secao de metodologia com cards por fonte

---

## Seguranca implementada

- **Senhas**: scrypt + salt random + timingSafeEqual
- **Rate limit**: 10 tentativas de login por IP a cada 15 min
- **Cookies**: HttpOnly, SameSite=Lax, Secure em producao
- **Headers**: X-Frame-Options DENY, CSP, X-Content-Type-Options, Referrer-Policy
- **Multi-tenant**: isolamento por empresa_id em TODAS as queries
- **Backup**: validacao de magic bytes SQLite antes de restaurar

---

## Deploy Railway — checklist

1. Garantir que `railway.json` e `Dockerfile` estao no root
2. Variaveis de ambiente configuradas no dashboard Railway
3. Volume `/data` criado e montado
4. Source conectado ao repo GitHub (`jeversonborges/Joydescription`, branch `main`)
5. Deploy: `git push` (automatico) ou `railway up` (CLI manual)

### Volume
- Mount path: `/data`
- Banco fica em `/data/joydescription.db`
- Para migrar dados locais: `JOY_FORCE_SEED=1` → deploy → `JOY_FORCE_SEED=0` → deploy

---

## Empresa Goiasa (dados de producao)

- **Nome**: Goiasa
- **Admin**: joyce@joydesc.com
- **empresa_id**: gerado em timestamp no registro
- Dados: ~67 cargos, 14 conhecimentos, 27 areas, 10 niveis
- Padrao de nome de area: `"ETA — Estacao de Tratamento de Agua"` (sigla + travessao + nome completo)
- Regiao: Sul Goiano (Quirinopolis, Jatai, Rio Verde)
- Setor: Sucroenergetico (usinas de cana-de-acucar)

---

## Pontos importantes para desenvolvimento

1. **server.mjs** e o unico arquivo backend (~2900 linhas). Tudo esta nele: rotas, middlewares, prompts de IA, seeds, migracoes.
2. **Prompts de IA** ficam inline no server.mjs (nao em arquivos separados). Busque por `const prompt` ou `const SYS` para encontra-los.
3. **SSE streaming** e usado na geracao de cargos (`POST /gerar`) — o frontend recebe chunks via EventSource.
4. **CBO** — 11097 ocupacoes carregadas na inicializacao. Arquivo base: `cbo_2002.json` (ou similar). Endpoint: `GET /cbo?q=texto`.
5. **Failover IA**: se Groq falhar, tenta Together AI (se configurado). Logica em `criarStream()`.
6. **Frontend e SPA pura**: tudo em `index.html` + `script.js` + `style.css`. Sem build, sem bundler, sem framework.
7. **Tema escuro** por padrao com CSS variables (`--bg`, `--text`, `--accent`, etc).
8. **Niveis** tem descricoes juridicas detalhadas que sao injetadas nos prompts de geracao de cargo para garantir conformidade legal (CLT art. 62, Lei 11.788, etc).

---

## O que ainda pode melhorar

- [ ] Integrar API real do salario.com.br ou basedosdados.org (CAGED tratado) para salarios em tempo real
- [ ] Recuperacao de senha por email
- [ ] Export para Word das descricoes
- [ ] Upload do backup automatico para S3/R2
- [ ] Testes automatizados
- [ ] Tela de analytics (cargos mais gerados, usuarios mais ativos)
- [ ] PWA / modo offline
