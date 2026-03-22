# JoyDescription — Documentação do Projeto

> Gerador de descrições de cargo com IA para o RH da Goiasa.
> Desenvolvido por Joyce / Jeverson Borges.

---

## O que é

Sistema web multi-tenant para o departamento de RH criar e gerenciar descrições de cargos usando IA (Groq/LLaMA). Cada empresa tem seus próprios dados isolados por `empresa_id`.

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Backend | Node.js + Express (ESM) |
| Banco | SQLite via `better-sqlite3` |
| IA | Groq API (llama-3.3-70b-versatile) |
| Frontend | HTML + CSS + JS vanilla (sem framework) |
| Deploy | Railway (com volume persistente) |
| Autenticação | Cookie `joy_session` + scrypt |

---

## Estrutura de arquivos

```
server.mjs       — servidor Express, todas as rotas de API
index.html       — SPA única (login + app)
script.js        — toda a lógica do front-end
style.css        — estilos (tema escuro, CSS vars)
joydescription.db — banco SQLite local (não vai ao Railway; o volume é usado lá)
.gitignore       — exclui node_modules, joydescription.db, .env, WAL files
railway.json     — config de deploy
```

---

## Variáveis de ambiente (Railway)

| Var | Valor | Descrição |
|-----|-------|-----------|
| `GROQ_API_KEY` | `gsk_...` | Chave da API Groq |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Modelo usado |
| `JOY_DB_PATH` | `/data/joydescription.db` | Caminho do banco no volume persistente |
| `JOY_FORCE_SEED` | `0` (ou `1` para forçar) | `1` sobrescreve o banco do volume com o seed local — usar só para migração |
| `NODE_ENV` | `production` | Ativa Secure cookie e CORS restrito |
| `PORT` | automático | Railway injeta |

---

## Banco de dados — tabelas principais

```sql
empresas        — id, nome, criado_em
usuarios        — id, empresa_id, nome, email, senha_hash (scrypt), papel (admin|membro), ativo
sessoes         — token, usuario_id, empresa_id, expira_em (30 dias)
cargos          — id, empresa_id, cargo, area, nivel, texto, criadoEm, editadoEm
versoes         — id, cargo_id, empresa_id, cargo, area, nivel, texto, hash, hash_prev, criado_em
areas           — empresa_id, key, label, universo
conhecimento    — id, empresa_id, titulo, categoria, conteudo, ativo, criadoEm
niveis          — empresa_id, label, ordem, eh_lideranca, descricao, descricao_curta
backups_log     — id, usuario_nome, usuario_email, empresa_id, tamanho_bytes, criado_em
backup_config   — empresa_id PK, ativo, intervalo_horas, proximo_em
audit_log       — id, empresa_id, usuario_id, usuario_nome, acao, alvo, ip, criado_em
```

**Regra de ouro:** toda query filtra por `WHERE empresa_id = ?`. Nenhuma empresa vê dados de outra.

---

## Rotas de API principais

### Autenticação
```
POST /auth/registrar    — cria empresa + admin (rate limited)
POST /auth/login        — login (rate limited: 10 tentativas / 15 min)
POST /auth/logout
GET  /auth/me           — retorna usuário e empresa da sessão atual
```

### Cargos
```
GET    /cargos
POST   /cargos           — cria cargo + salva versão
PUT    /cargos/:id       — edita + salva versão
DELETE /cargos/:id
GET    /versoes/:cargo_id                    — histórico de versões
GET    /versoes/:cargo_id/:versao_id/texto   — texto de uma versão
GET    /changelog                            — últimas 200 versões
```

### Áreas / Conhecimento / Níveis
```
GET/POST/PUT/DELETE /areas/:key
GET/POST/PUT/DELETE /conhecimento/:id
GET/POST/PUT/DELETE /niveis/:label
```

### Usuários (admin only)
```
GET    /usuarios
POST   /usuarios
PUT    /usuarios/:id
DELETE /usuarios/:id          — desativa (ativo=0)
DELETE /usuarios/:id/excluir  — exclusão permanente
```

### Backup (admin only)
```
GET  /backup/status     — tamanho do banco, contagem de registros, último backup
GET  /backup/historico  — últimos 20 backups
GET  /backup/download   — baixa o .db (WAL checkpoint antes)
POST /backup/restaurar  — faz upload de um .db, valida magic bytes SQLite, sobrescreve e reinicia
GET  /backup/config     — configuração de backup automático
POST /backup/config     — salva configuração (ativo, intervalo_horas)
```

### Auditoria (admin only)
```
GET /auditoria?acao=&usuario=&limit=100&offset=0
```

### IA
```
POST /gerar    — gera descrição de cargo (Groq)
POST /analisar — análise jurídica do texto (Groq)
POST /corrigir — reescrita/correção (Groq)
GET  /sugestoes — sugestões de cargos similares
GET  /exportar  — exporta versões assinadas (JSON + hash manifesto)
GET  /exportar/pdf — exporta PDF
```

---

## Segurança implementada

- **Senhas**: scrypt + salt random + timingSafeEqual (sem timing attacks)
- **Rate limit**: 10 tentativas de login por IP a cada 15 min (in-memory Map)
- **Cookies**: HttpOnly, SameSite=Lax, Secure em produção
- **Headers**: X-Frame-Options DENY, CSP, X-Content-Type-Options, Referrer-Policy
- **Multi-tenant**: isolamento por empresa_id em TODAS as queries
- **CORS**: desativado em produção (origem única)
- **Backup**: validação de magic bytes SQLite antes de restaurar

---

## Sistema de backup

- **Manual**: download do `.db` via menu Backup → "Baixar Backup"
- **Restaurar**: upload de um `.db` → valida → sobrescreve → reinicia servidor
- **Automático**: configurável por empresa (toggle + intervalo em horas), job roda a cada 1h
- **Histórico**: tabela `backups_log` registra cada download
- **Volume Railway**: banco fica em `/data/joydescription.db` — persiste entre deploys

---

## Log de Auditoria

Registra automaticamente:

| Ação | O que loga |
|------|-----------|
| `auth.login` | Login com sucesso |
| `auth.login_falhou` | Senha errada |
| `auth.logout` | Saída |
| `cargo.criar/editar/deletar` | Nome do cargo |
| `area.criar/editar/deletar` | Nome da área |
| `conhecimento.criar/editar/deletar` | Título do artigo |
| `nivel.criar/editar/deletar` | Label do nível |
| `usuario.criar/editar/desativar/excluir` | Nome do usuário |
| `backup.download/restaurar` | Tamanho em KB |

Interface: modal "Auditoria" no menu superior (admin only) — filtros por usuário e tipo de ação, paginação de 50.

---

## Frontend — como funciona

- SPA single-page: tela de login e app inteiro em `index.html`
- Estado global em `script.js`: `usuarioLogado`, `empresaAtual`, `cargosData`, etc.
- Abas principais: `descricao`, `cargos`, `areas`, `conhecimento`, `niveis`, `usuarios`
- Modais (abre sobre o app): Calendário, Backup, Segurança, Auditoria
- Todos os modais admin ficam no menu superior e são visíveis só para `papel === "admin"`
- Splash de carregamento com barra de progresso e percentual animado

---

## Deploy Railway — passo a passo

```bash
railway login --browserless
railway init           # seleciona o projeto existente
railway up --detach    # sobe o código
```

### Variáveis obrigatórias no Railway
```
GROQ_API_KEY=gsk_...
JOY_DB_PATH=/data/joydescription.db
NODE_ENV=production
```

### Volume
- Criado no dashboard Railway → projeto → "+ New" → Volume
- Mount path: `/data`
- Para migrar dados locais para o volume pela primeira vez: setar `JOY_FORCE_SEED=1`, fazer `railway up`, depois setar `JOY_FORCE_SEED=0` e fazer `railway up` novamente

---

## Empresa Goiasa (dados de produção)

- **Nome**: Goiasa
- **Admin**: joyce@joydesc.com
- **empresa_id**: gerado em timestamp no registro
- Dados: ~67 cargos, 14 conhecimentos, 27 áreas, 10 níveis
- Padrão de nome de área: `"ETA — Estação de Tratamento de Água"` (sigla + travessão + nome completo)

---

## O que ainda pode melhorar

- [ ] Recuperação de senha por email
- [ ] Export para PDF/Word das descrições
- [ ] Upload do backup automático para S3/R2 (hoje só loga localmente)
- [ ] Testes automatizados
- [ ] Tela de analytics (cargos mais gerados, usuários mais ativos)
