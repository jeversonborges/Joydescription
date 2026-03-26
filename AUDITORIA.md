# Auditoria de Pesquisa Salarial — JoyDesc

**Versão:** 1.0
**Data:** 2025-03
**Responsável:** Sistema JoyDesc

---

## Metodologia de Pesquisa Salarial

### Fontes de Dados
| Fonte | Peso | Descrição | URL |
|-------|------|-----------|-----|
| **CAGED/MTE** | 60% | Dados oficiais de admissões/demissões CLT via salario.com.br | https://salario.com.br |
| **Dissídio** | 25% | Pisos sindicais e acordos coletivos do setor | https://dissidio.com.br |
| **Glassdoor** | 15% | Salários informados por profissionais (autodeclarado) | https://glassdoor.com.br |

### Cálculo de Faixas
- **Salário Base (Pleno):** Média ponderada das 3 fontes (60/25/15)
- **Salário Mínimo:** `base × 0.82` (se não fornecido pela IA)
- **Salário Máximo:** `base × 1.18` (se não fornecido pela IA)
- **Remuneração Total:** `base × 1.15` (VT, VR, convênio básico)

### Fator de Nível (Hierarquia Usinas Goiás)
Aplicado multiplicativo sobre salário Pleno.
**Fatores são editáveis pela interface** (aba Hierarquia → campo "Fator salarial") e armazenados na coluna `fator_salarial` da tabela `niveis`.

Valores padrão:
- Trainee: 0.60
- Junior: 0.80
- **Pleno: 1.00** (referência base)
- Senior: 1.25
- Especialista: 1.40
- Coordenador: 1.55
- Gestor: 1.70 (abaixo do gerente, responsável exclusivo quando não há gerente na área)
- Gerente: 2.10 (responsável por área com múltiplos operacionais)
- Superintendente: 2.70 (acima de gerente, cargo mais alto na usina)
- Diretor: 3.50 (topo — raramente presente em usinas locais)

---

## Tipos de Dados

### 1. Manual
Pesquisa salva diretamente pelo usuário (sem IA).
- **Fonte:** `fonte_tipo = 'manual'`
- **Campos vazios:** `ia_prompt = NULL`, `ia_resposta = NULL`
- **Confiabilidade:** Máxima (desde que inserido corretamente)

### 2. IA (Groq)
Gerada por LLaMA 3.3 70B (Groq API).
- **Fonte:** `fonte_tipo = 'ia_groq'`
- **Prompt:** Armazenado em `ia_prompt` para replicação
- **Resposta bruta:** Armazenada em `ia_resposta` para auditoria
- **Validação:** Limites de plausibilidade (R$ 1.200–50.000 para Pleno)

### 3. IA (Together)
Failover: LLaMA 3.3 70B Instruct Turbo (Together AI).
- **Fonte:** `fonte_tipo = 'ia_together'`
- **Prompts/respostas:** Idem Groq

---

## Validações Aplicadas

✅ **Obrigatórias:**
1. Cargo e área preenchidos
2. Valores numéricos válidos
3. Fonte tipo válida (manual|ia_groq|ia_together)

✅ **De plausibilidade (IA):**
1. Salário Pleno ≥ R$ 1.200 (piso mínimo legal + margem)
2. Salário Pleno ≤ R$ 50.000 (teto setor sucroenergético)
3. Se fora dos limites: rejeitado e retorna `dados = null`

---

## Disclaimer Obrigatório

Toda pesquisa salarial exibida deve conter:

```
AVISO DE METODOLOGIA:
Os valores de remuneração foram calculados a partir de:
• CAGED/MTE (60%) — dados oficiais de admissões CLT
• Dissídio.com.br (25%) — pisos sindicais e acordos
• Glassdoor Brasil (15%) — informações autodeclaradas

Faixas mínima/máxima são estimativas (±18% da mediana).
Dados contêm interpolações via IA e podem não ser adequados para
decisões legais ou judiciais sem verificação independente.

Referência de versão: 1.0 (2025-03)
```

---

## Auditoria de Registros

### Campos de Rastreabilidade
| Campo | Tipo | Propósito |
|-------|------|----------|
| `fonte_tipo` | TEXT | Manual vs. IA (Groq/Together) |
| `ia_prompt` | TEXT | Prompt enviado à IA (reprodutibilidade) |
| `ia_resposta` | TEXT | Resposta bruta da IA (antes de parse) |
| `versao_ref` | TEXT | Versão de salarios-referencia.json usada |
| `criado_em` | TEXT | ISO 8601 timestamp |
| `atualizado_em` | TEXT | ISO 8601 timestamp |

### Consulta de Auditoria
```sql
SELECT
  id, cargo, area, nivel, sal_med,
  fonte_tipo, criado_em, atualizado_em,
  ia_prompt, ia_resposta
FROM pesquisas_salariais
WHERE empresa_id = ?
ORDER BY criado_em DESC;
```

---

## Limitações Conhecidas

1. **Glassdoor:** Autodeclarado, sem filtros de anomalias ou duplicação
2. **IA (temperatura 0.1):** Reduz criatividade mas não a elimina completamente
3. **Defasagem regional:** Aplicada implicitamente via prompt, não versionada
4. **Histórico:** Se arquivos de referência mudarem, cálculos antigos podem divergir

---

## Certificação

❌ **NÃO adequado para:**
- Processos trabalhistas/judiciais sem validação independente
- Compliance com Lei 6.732/1979 (DIEESE) sem assinatura técnica
- Benchmarks certificados (ISO 20414 ou similares)

✅ **Adequado para:**
- Orientação interna de RH
- Comparativo preliminar antes de contratação
- Planejamento de folha de pagamento com revisão manual

---

## Contato para Auditoria

Para questionar metodologia ou replicar cálculos:
1. Solicite o `ia_prompt` e `ia_resposta` do registro em questão
2. Reproduza o parse JSON e cálculos
3. Valide contra as faixas de `salarios-referencia.json` versão informada

