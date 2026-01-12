# mk-bot-boleto

Bot de WhatsApp (Evolution API) para consulta automática de boletos e dados do cliente no **MK-AUTH**, usando Node.js e Webhook HTTP.

- Quando o cliente envia **"boleto"**, **"pix"** ou **"fatura"**, o bot:
  - Tenta localizar o cadastro pelo número de WhatsApp (últimos 9 dígitos).
  - Consulta os títulos em aberto/vencidos no MK-AUTH.
  - Retorna resumo, link PIX (se existir), link do boleto e linha digitável em mensagem separada possibilitando a cópia.
- Quando o cliente envia **"cliente"** ou **"meu plano"**, o bot retorna nome, login, plano e telefone cadastrado.

## Requisitos

- MK-AUTH com HTTPS e habilitados em GET os endpoints TITULO E CLIENTE..
- Evolution API (homologado na v2)com webhook apontando para o bot.
- Docker.

## Variáveis de ambiente

Crie um arquivo `.env` baseado em `.env.example` com as variáveis abaixo.

### MK-AUTH

- `MKAUTH_PUBLIC_URL`  
  URL **pública** raiz do seu MK-AUTH, **sem `/api`**.  
  Exemplo: `https://www.suaempresa.com.br`

  A API será chamada em `MKAUTH_PUBLIC_URL + "/api"`, por exemplo: `https://www.suaempresa.com.br/api`.

- `MKAUTH_CLIENT_ID`  
- `MKAUTH_CLIENT_SECRET`  

Credenciais da API do MK-AUTH (Basic Auth).

### Evolution API

- `EVOLUTION_API_URL`  
  Default: `http://evolution-api:7070`

- `EVOLUTION_INSTANCE_NAME`  
  Nome da instância no Evolution. Default: `minha_instancia`.

- `EVOLUTION_APIKEY`  
  Chave de API da instância usada para enviar mensagens.

### App

- `PORT`  
  Porta onde o bot vai ouvir o webhook. Default: `3000`.

### Exemplo de `.env`

```env
# Porta do bot HTTP
PORT=3000

# MK-AUTH
MKAUTH_PUBLIC_URL=https://www.suaempresa.com.br
MKAUTH_CLIENT_ID=seu_client_id_aqui
MKAUTH_CLIENT_SECRET=seu_client_secret_aqui

# Evolution API
EVOLUTION_API_URL=http://evolution-api:7070
EVOLUTION_INSTANCE_NAME=minha_instancia
EVOLUTION_APIKEY=sua_chave_da_evolution_aqui

