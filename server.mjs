import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import fs from "fs"
import path from "path"
import OpenAI from "openai"

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

/* ------------------------------
   CARREGAR BASE CBO NA MEMÓRIA
--------------------------------*/

const caminhoCSV = path.join("meta", "cargos_cbo_planilha.csv")

const cboBase = []

const conteudo = fs.readFileSync(caminhoCSV, "utf8")

const linhas = conteudo.split("\n")

linhas.slice(1).forEach(linha => {

  if(!linha.trim()) return

  const colunas = linha.split(",")

  cboBase.push({
    codigo: colunas[0],
    cargo: colunas[1]
  })

})

console.log("CBO carregado:", cboBase.length, "cargos")

/* ---------------------------------
   FUNÇÃO PARA PEGAR CANDIDATOS
----------------------------------*/

function buscarCandidatos(texto){

  const termo = texto.toLowerCase()

  return cboBase
    .filter(c => c.cargo.toLowerCase().includes(termo))
    .slice(0,20)

}

/* ---------------------------------
   ENDPOINT IA
----------------------------------*/

app.post("/gerar", async (req,res)=>{

  try{

    const {cargo, nivel, area} = req.body

    const candidatos = buscarCandidatos(cargo)

    const listaCBO = candidatos
      .map(c => `${c.codigo} - ${c.cargo}`)
      .join("\n")

    const prompt = `
Você é especialista em Recursos Humanos e Classificação Brasileira de Ocupações (CBO).

O usuário informou um cargo que pode não existir exatamente na CBO.

Sua tarefa é:

1. Encontrar o cargo CBO mais próximo semanticamente
2. Informar o código CBO correspondente
3. Gerar uma descrição profissional do cargo

Cargo informado:
${cargo}

Área:
${area}

Nível:
${nivel}

Possíveis cargos CBO relacionados:
${listaCBO}

Resposta no formato:

Cargo CBO escolhido:
Código CBO:

Missão do cargo:

Responsabilidades:

Requisitos técnicos:

Competências comportamentais:

Formação recomendada:
`

    const response = await openai.chat.completions.create({

      model: "gpt-4.1-mini",

      messages:[
        {role:"user", content: prompt}
      ]

    })

    res.json({
      texto: response.choices[0].message.content
    })

  }catch(err){

    console.error(err)

    res.status(500).json({erro:"Erro ao gerar descrição"})

  }

})

app.listen(3000, ()=>{
  console.log("Servidor rodando em http://localhost:3000")
})