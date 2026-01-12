import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// === MK-AUTH (env) ===

// URL pública raiz (sem /api) - OBRIGATÓRIA via env
const MKAUTH_PUBLIC_URL = process.env.MKAUTH_PUBLIC_URL;
if (!MKAUTH_PUBLIC_URL) {
  throw new Error(
    "MKAUTH_PUBLIC_URL nao configurada. Defina a URL publica do seu MK-AUTH."
  );
}
// base da API sempre é /api em cima da pública
const MKAUTH_API_BASE = MKAUTH_PUBLIC_URL.replace(/\/+$/, "") + "/api";
const MKAUTH_CLIENT_ID = process.env.MKAUTH_CLIENT_ID;
const MKAUTH_CLIENT_SECRET = process.env.MKAUTH_CLIENT_SECRET;

// === EVOLUTION API (env) ===
const EVOLUTION_API_URL =
  process.env.EVOLUTION_API_URL || "http://evolution-api:7070";
const EVOLUTION_INSTANCE_NAME =
  process.env.EVOLUTION_INSTANCE_NAME || "minha_instancia";
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY || "";

// estado de sessão antigo (não usado mais)
const sessionState = {};

// estado de fluxo simples por numero: { step, attempts, startedAt }
const pendingFlow = new Map();

// normaliza o número do WhatsApp (só dígitos) - USADO APENAS PARA LÓGICA INTERNA
function normalizeFrom(valor) {
  return String(valor || "").replace(/[^0-9]/g, "");
}

// limpar CPF/CNPJ (ainda usado se quiser manter fluxo antigo em outro comando)
function limparCpfCnpj(text) {
  return String(text || "").replace(/[^0-9]/g, "");
}

// aceita CPF (11) ou CNPJ (14)
function pareceCpfCnpj(num) {
  return /^[0-9]{11}$/.test(num) || /^[0-9]{14}$/.test(num);
}

// extrai titulos do JSON {Total, titulos} ou similares
function extrairTitulos(resData) {
  if (!resData || typeof resData !== "object") return [];

  if (Array.isArray(resData.titulos)) {
    return resData.titulos;
  }

  if (Array.isArray(resData)) {
    return resData;
  }

  return [];
}

// ======== util para ultimos 9 digitos ========
function ultimos9(text) {
  if (!text) return null;
  const digits = String(text).replace(/[^0-9]/g, "");
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

// ============ função montar URL do boleto =========
function montarUrlBoletoPublico(titulo) {
  const base = MKAUTH_PUBLIC_URL; // sem /api
  const numTitulo = titulo.titulo; // numero do titulo
  const login = titulo.login; // contrato/login do cliente

  if (!base || !numTitulo || !login) return "";

  return (
    base.replace(/\/+$/, "") +
    `/boleto/boleto.hhvm?titulo=${encodeURIComponent(
      numTitulo
    )}&contrato=${encodeURIComponent(login)}`
  );
}

// ======== ENVIO DE MENSAGEM PELA EVOLUTION ========
async function enviarMensagemEvolution(remoteJid, texto) {
  if (!EVOLUTION_APIKEY) {
    console.error("EVOLUTION_APIKEY nao configurada");
    return;
  }

  // remoteJid vem algo como: "5511999999999@c.us" ou "5511999999999@s.whatsapp.net"
  const digits = String(remoteJid || "").replace(/[^0-9]/g, "");
  if (!digits) {
    console.error("Nao foi possivel extrair numero do remoteJid:", remoteJid);
    return;
  }

  // "number": "5511999999999@c.us"
  const number = `${digits}@c.us`;
  const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE_NAME}`;

  console.log("POST SEND TEXT:", url, "->", number);

  try {
    await axios.post(
      url,
      {
        number,
        text: texto,
        delay: 1200
      },
      {
        headers: {
          "Content-Type": "application/json",
          apikey: EVOLUTION_APIKEY
        },
        timeout: 8000
      }
    );
  } catch (err) {
    console.error(
      "Erro ao enviar mensagem na Evolution:",
      err.response?.data || err.message
    );
  }
}

// ======== gera JWT NOVO na hora usando Basic Auth (sem cache) ========
async function gerarJwtNovo() {
  if (!MKAUTH_PUBLIC_URL || !MKAUTH_CLIENT_ID || !MKAUTH_CLIENT_SECRET) {
    throw new Error("Variáveis de ambiente da API MK-AUTH não configuradas");
  }

  const basicRaw = `${MKAUTH_CLIENT_ID}:${MKAUTH_CLIENT_SECRET}`;
  const basicAuth = "Basic " + Buffer.from(basicRaw).toString("base64");

  const resp = await axios.get(MKAUTH_API_BASE + "/", {
    headers: {
      Authorization: basicAuth
    },
    timeout: 8000
  });

  const jwtBody = typeof resp.data === "string" ? resp.data.trim() : "";
  if (!jwtBody) {
    throw new Error("JWT vazio ao gerar token na raiz da API");
  }

  return jwtBody;
}

// ======== buscar clientes no MK-AUTH e achar por ultimos 9 ========
async function buscarClientePorTelefoneUltimos9(jwt, ult9) {
  const url = `${MKAUTH_API_BASE}/cliente/listar`;
    console.log("GET CLIENTE LISTAR:", url);

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    timeout: 8000
  });

  const data = resp.data || {};
  const clientes = Array.isArray(data.clientes) ? data.clientes : [];

  console.log("TOTAL CLIENTES RECEBIDOS:", clientes.length);

  if (!clientes.length) return null;

  const encontrado =
    clientes.find((cli) => {
      const c1 = ultimos9(cli.celular);
      const c2 = ultimos9(cli.celular2);
      const f1 = ultimos9(cli.fone);
      return c1 === ult9 || c2 === ult9 || f1 === ult9;
    }) || null;

  return encontrado;
}

// ======== consulta titulos por CPF/CNPJ usando JWT ========
async function consultarTitulosPorCpfCnpj(jwt, cpfCnpj) {
  let abertos = [];
  let vencidos = [];

  try {
    const urlAberto = `${MKAUTH_API_BASE}/titulo/aberto/${encodeURIComponent(
	    cpfCnpj
    )}`;
    console.log("GET ABERTO (auto):", urlAberto);

    const respAberto = await axios.get(urlAberto, {
      headers: { Authorization: `Bearer ${jwt}` },
      timeout: 8000
    });

    abertos = extrairTitulos(respAberto.data);
    console.log("ABERTOS EXTRAIDOS (auto):", abertos.length);
  } catch (e) {
    console.error("Erro ao buscar titulos abertos (auto):", e.message);
  }

  try {
    const urlVencido = `${MKAUTH_API_BASE}/titulo/vencido/${encodeURIComponent(
      cpfCnpj
    )}`;
    console.log("GET VENCIDO (auto):", urlVencido);

    const respVencido = await axios.get(urlVencido, {
      headers: { Authorization: `Bearer ${jwt}` },
      timeout: 8000
    });

    vencidos = extrairTitulos(respVencido.data);
    console.log("VENCIDOS EXTRAIDOS (auto):", vencidos.length);
  } catch (e) {
    console.error("Erro ao buscar titulos vencidos (auto):", e.message);
  }

  return { abertos, vencidos };
}

function montarMensagemTitulos(abertos, vencidos) {
  const totalAbertos = abertos.length;
  const totalVencidos = vencidos.length;
  const totalGeral = totalAbertos + totalVencidos;

  if (totalGeral === 0) {
    return (
      "Nao encontrei boletos em aberto ou vencidos para esse CPF/CNPJ.\n" +
      "Se achar que e um erro, confirme seus dados com o atendimento."
    );
  }

  const destaque = totalAbertos > 0 ? abertos[0] : vencidos[0];

  const valor = Number(destaque.valor || 0).toFixed(2);
  const venc = destaque.datavenc || "sem data";
  const pixLink = destaque.pix || destaque.pix_link || "";

  const urlBoleto = montarUrlBoletoPublico(destaque);

  let texto =
    `Encontrei ${totalGeral} titulo(s) para seu CPF/CNPJ.\n` +
    `Em aberto: ${totalAbertos}\n` +
    `Vencidos: ${totalVencidos}\n\n` +
    `Titulo em destaque:\n` +
    `Status: ${destaque.status || "indefinido"}\n` +
    `Valor: R$ ${valor}\n` +
    `Vencimento: ${venc}\n`;

  if (pixLink) texto += `Link PIX: ${pixLink}\n`;
  if (urlBoleto) texto += `Boleto: ${urlBoleto}\n`;

  return texto;
}

// webhook Evolution
app.post("/webhook/evolution", async (req, res) => {
  try {
    const body = req.body;

    const rawText =
      body?.data?.message?.text ||
      body?.data?.message?.conversation ||
      "";
    const rawFrom =
      body?.data?.from ||
      body?.data?.key?.remoteJidAlt ||
      body?.data?.key?.remoteJid ||
      "";

    // se nao tem texto ou origem, ignora educadamente (audio, status, etc.)
    if (!rawText || !rawFrom) {
      return res.json({ ok: true, ignored: true });
    }

    // IGNORAR GRUPOS
    const remoteJidKey = body?.data?.key?.remoteJid || "";
    if (rawFrom.endsWith("@g.us") || remoteJidKey.endsWith("@g.us")) {
      return res.json({ ok: true, ignored: "group" });
    }

    const from = normalizeFrom(rawFrom);
    const text = rawText.trim();

    const msgBase = text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    // ===== FLUXO: RESPOSTA DE CPF/CNPJ PARA BOLETO (2 tentativas, 5 min) =====
    const digitsOnly = text.replace(/[^0-9]/g, "");
    const state = pendingFlow.get(from);

    // ========== FLUXO CPF/CNPJ (resposta ao fluxo pendente) ==========
    if (state?.step === "cpf_boleto") {
      const now = Date.now();
      const maxAgeMs = 5 * 60 * 1000; // 5 minutos

      // expira fluxo se passou do tempo
      if (!state.startedAt || now - state.startedAt > maxAgeMs) {
        pendingFlow.delete(from);
        await enviarMensagemEvolution(
          rawFrom,
          "Seu atendimento para consulta por documento expirou.\n" +
            "Se quiser tentar novamente, envie *boleto*."
        );
        return res.json({ ok: true, flow: "cpf_expired" });
      }

      // DOC INVÁLIDO: não é 11 nem 14 dígitos
      if (
        !digitsOnly ||
        (digitsOnly.length !== 11 && digitsOnly.length !== 14)
      ) {
        const attempts = (state.attempts || 0) + 1;

        if (attempts === 1) {
          pendingFlow.set(from, {
            ...state,
            attempts
          });

          await enviarMensagemEvolution(
            rawFrom,
            "Nao entendi. Por favor, envie o *CPF ou CNPJ do titular* com 11 ou 14 digitos, apenas numeros."
          );
          return res.json({ ok: true, flow: "doc_invalid_first" });
        }

        // segunda tentativa errada -> encerra fluxo
        pendingFlow.delete(from);
        await enviarMensagemEvolution(
          rawFrom,
          "Ainda nao recebi um CPF ou CNPJ valido.\n" +
            "Vou encerrar esta tentativa. Se quiser, envie *boleto* novamente para recomeçar."
        );
        return res.json({ ok: true, flow: "doc_invalid_end" });
      }

      // DOC válido (11 ou 14) => segue consulta
      const doc = digitsOnly;

      let jwt;
      try {
        jwt = await gerarJwtNovo();
        console.log(
          "JWT GERADO NA HORA (boleto via doc) tamanho:",
          jwt.length
        );
      } catch (e) {
        console.error("Erro ao gerar JWT (boleto via doc):", e.message);
        await enviarMensagemEvolution(
          rawFrom,
          "Nao consegui gerar o token de acesso aos boletos. Tente novamente em alguns minutos."
        );
        pendingFlow.delete(from);
        return res.json({ ok: true });
      }

      console.log(
        "===== BOLETO VIA DOC: CONSULTA TITULOS PARA DOC:",
        doc,
        "====="
      );

      const { abertos, vencidos } = await consultarTitulosPorCpfCnpj(jwt, doc);

      if (!abertos.length && !vencidos.length) {
        await enviarMensagemEvolution(
          rawFrom,
          "Nao encontrei boletos em aberto ou vencidos para esse CPF/CNPJ.\n" +
            "Se achar que e um erro, confirme seus dados com o atendimento."
        );
        pendingFlow.delete(from);
        return res.json({ ok: true });
      }

      const destaque = abertos.length > 0 ? abertos[0] : vencidos[0];
      const msgTitulos = montarMensagemTitulos(abertos, vencidos);

      // 1) mensagem principal (resumo + pix + link boleto + setinha)
      const textoResumo =
        `Documento informado: ${doc}\n` +
        msgTitulos +
        "\n\nAbaixo segue a linha digitavel para copia:\n⬇️⬇️⬇️";

      await enviarMensagemEvolution(rawFrom, textoResumo);

      // 2) mensagem só com a linha digitavel (limpa)
      const linhaLimpa = String(
        destaque.linhadig || destaque.linha_digitavel || ""
      ).replace(/\s+/g, "");

      if (linhaLimpa) {
        await enviarMensagemEvolution(rawFrom, linhaLimpa);
      }

      pendingFlow.delete(from);
      return res.json({ ok: true, flow: "doc_done" });
    }

    // ===================================================================

    // ========== FLUXO CLIENTE POR TELEFONE (TESTE) ==========
    if (msgBase.includes("cliente") || msgBase.includes("meu plano")) {
      const ult9 = ultimos9(rawFrom);

      if (!ult9) {
        await enviarMensagemEvolution(
          rawFrom,
          "Nao consegui extrair os ultimos 9 digitos do seu numero. Tente novamente mais tarde."
        );
        return res.json({ ok: true });
      }

      let jwtCliente;
      try {
        jwtCliente = await gerarJwtNovo();
        console.log("JWT GERADO NA HORA (cliente) tamanho:", jwtCliente.length);
      } catch (e) {
        console.error("Erro ao gerar JWT na hora (cliente):", e.message);
        await enviarMensagemEvolution(
          rawFrom,
          "Nao consegui gerar o token de acesso aos seus dados. Tente novamente em alguns minutos."
        );
        return res.json({ ok: true });
      }

      console.log("===== CONSULTA CLIENTE POR ULTIMOS 9 =====", ult9, "=====");

      let cliente = null;
      try {
        cliente = await buscarClientePorTelefoneUltimos9(jwtCliente, ult9);
      } catch (e) {
        console.error("Erro ao buscar cliente por telefone:", e.message);
      }

      if (!cliente) {
        await enviarMensagemEvolution(
          rawFrom,
          `Nao encontrei seu cadastro pelo seu numero de WhatsApp: ${ult9}.\n` +
            `Se achar que e um erro, fale com o atendimento ou envie *boleto* para consultar pelos seus boletos informando o CPF ou CNPJ.`
        );
        return res.json({ ok: true });
      }

      const nome = cliente.nome || "Sem nome";
      const cel = cliente.celular || cliente.fone || "Sem telefone cadastrado";
      const plano = cliente.plano || "Sem plano";
      const loginCli = cliente.login || "Sem login";

      let textoCliente =
        `Encontrei seu cadastro pelo seu numero de WhatsApp.\n\n` +
        `Nome: ${nome}\n` +
        `Login: ${loginCli}\n` +
        `Plano: ${plano}\n` +
        `Telefone cadastrado: ${cel}\n\n` +
        `Se quiser solicitar pix ou boletos, envie *boleto* ou *pix*.`;

      await enviarMensagemEvolution(rawFrom, textoCliente);
      return res.json({ ok: true });
    }

// ========== FLUXO BOLETO/PIX/FATURA: AUTOMATICO PELO NUMERO ==========
if (
  msgBase.includes("boleto") ||
  msgBase.includes("pix") ||
  msgBase.includes("fatura")
) {
      const ult9 = ultimos9(rawFrom);

      if (!ult9) {
        await enviarMensagemEvolution(
          rawFrom,
          "Nao consegui extrair os ultimos 9 digitos do seu numero. Tente novamente mais tarde."
        );
        return res.json({ ok: true });
      }

      let jwt;
      try {
        jwt = await gerarJwtNovo();
        console.log("JWT GERADO NA HORA (boleto auto) tamanho:", jwt.length);
      } catch (e) {
        console.error("Erro ao gerar JWT na hora (boleto auto):", e.message);
        await enviarMensagemEvolution(
          rawFrom,
          "Nao consegui gerar o token de acesso aos boletos. Tente novamente em alguns minutos."
        );
        return res.json({ ok: true });
      }

      console.log(
        "===== BOLETO AUTO: CONSULTA CLIENTE POR ULTIMOS 9 =====",
        ult9,
        "====="
      );

      let cliente = null;
      try {
        cliente = await buscarClientePorTelefoneUltimos9(jwt, ult9);
      } catch (e) {
        console.error(
          "Erro ao buscar cliente por telefone (boleto auto):",
          e.message
        );
      }

      if (!cliente) {
        // aqui entra o novo fluxo de CPF/CNPJ
        pendingFlow.set(from, {
          step: "cpf_boleto",
          attempts: 0,
          startedAt: Date.now()
        });

        await enviarMensagemEvolution(
          rawFrom,
          `Nao encontrei seu cadastro pelo numero de WhatsApp: ${ult9}.\n` +
            `Se quiser, posso tentar localizar pelos seus boletos usando o *CPF ou CNPJ do titular*.\n` +
            `Por favor, responda com o CPF ou CNPJ contendo 11 ou 14 digitos, apenas numeros.`
        );

        return res.json({ ok: true, flow: "ask_cpf" });
      }

      const nome = cliente.nome || "Sem nome";
      const cpfCnpj = (cliente.cpf_cnpj || "").replace(/[^0-9]/g, "");

      if (!cpfCnpj) {
        const textoSemCpf =
          `Encontrei seu cadastro pelo numero de WhatsApp.\n\n` +
          `Nome: ${nome}\n` +
          `Porem nao identifiquei CPF/CNPJ no seu cadastro.\n` +
          `Fale com o atendimento para atualizar seus dados.`;

        await enviarMensagemEvolution(rawFrom, textoSemCpf);
        return res.json({ ok: true });
      }

      console.log(
        "===== BOLETO AUTO: CONSULTA TITULOS PARA CPF/CNPJ:",
        cpfCnpj,
        "====="
      );

      const { abertos, vencidos } = await consultarTitulosPorCpfCnpj(
        jwt,
        cpfCnpj
      );

      if (!abertos.length && !vencidos.length) {
        await enviarMensagemEvolution(
          rawFrom,
          "Nao encontrei boletos em aberto ou vencidos para esse CPF/CNPJ.\n" +
            "Se achar que e um erro, confirme seus dados com o atendimento."
        );
        return res.json({ ok: true });
      }

      const destaque = abertos.length > 0 ? abertos[0] : vencidos[0];
      const msgTitulos = montarMensagemTitulos(abertos, vencidos);

      // 1) mensagem principal (resumo + pix + link boleto + setinha)
      const textoResumo =
        `Nome: ${nome}\n` +
        msgTitulos +
        "\n\nAbaixo segue a linha digitavel para copia:\n⬇️⬇️⬇️";

      await enviarMensagemEvolution(rawFrom, textoResumo);

      // 2) mensagem só com a linha digitavel (limpa)
      const linhaLimpa = String(
        destaque.linhadig || destaque.linha_digitavel || ""
      ).replace(/\s+/g, "");

      if (linhaLimpa) {
        await enviarMensagemEvolution(rawFrom, linhaLimpa);
      }

      return res.json({ ok: true });
    }

    // sem mensagem padrão automática: apenas registra e encerra
    console.log("Mensagem ignorada (sem fluxo):", rawFrom, "->", text);
    return res.json({ ok: true, ignored: "no_flow" });
  } catch (err) {
    console.error("Erro no webhook:", err.message);

    const rawFrom = req.body?.data?.from;
    if (rawFrom) {
      await enviarMensagemEvolution(
        rawFrom,
        "Tive um problema ao processar sua solicitacao. Tente novamente mais tarde."
      );
    }

    return res.json({ ok: false });
  }
});

// health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    imagetag: "joseluisfreire/mk-bot-boleto:v2.3.0",
    developer: "https://hub.docker.com/u/joseluisfreire",
	message: "config evolution webhook http://ip-do-bot:3000/webhook/evolution",
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Bot ouvindo na porta ${PORT}`);
});
