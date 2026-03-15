let cargos = []

fetch("meta/cargos_cbo_planilha.csv")
.then(res => res.text())
.then(data => {

let linhas = data.split("\n")

linhas.slice(1).forEach(linha => {

if(!linha.trim()) return

let colunas = linha.split(",")

cargos.push(colunas[1].toLowerCase())

})

console.log("Cargos carregados:", cargos.length)

})


//NÃO DEIXAR UM LOOP DE BUSCA

function debounce(func, delay){

let timeout

return function(){

clearTimeout(timeout)

timeout = setTimeout(() => {
func.apply(this, arguments)
}, delay)

}

}

//AUTOCOMPLETE RÁPIDO 
const input = document.getElementById("cargoInput")
const lista = document.getElementById("listaCargos")

const buscar = debounce(function(){

let valor = input.value.toLowerCase()

lista.innerHTML = ""

if(valor.length < 2){

lista.style.display = "none"
return

}

let resultados = []

for(let i = 0; i < cargos.length; i++){

if(cargos[i].startsWith(valor)){

resultados.push(cargos[i])

if(resultados.length >= 10) break

}

}

resultados.forEach(cargo => {

let item = document.createElement("div")

item.textContent = cargo

item.onclick = () => {

input.value = cargo
lista.style.display = "none"

}

lista.appendChild(item)

})

lista.style.display = resultados.length ? "block" : "none"

}, 150)

input.addEventListener("input", buscar)

async function gerarDescricao(){

let cargo = document.getElementById("cargoInput").value
let area = document.getElementById("area").value
let nivel = document.getElementById("nivel").value

const resposta = await fetch("http://localhost:3000/gerar", {

method: "POST",

headers:{
"Content-Type":"application/json"
},

body: JSON.stringify({
cargo,
area,
nivel
})

})

const dados = await resposta.json()

document.getElementById("resultado").value = dados.texto

}