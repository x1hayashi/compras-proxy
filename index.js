const http   = require("http");
const https  = require("https");
const url    = require("url");
const crypto = require("crypto");

// ── CONFIG ────────────────────────────────────────────────
const GSB_HOST  = "api-normalizada.gsbsoftware.com.br";
const GSB_AUTH  = "Basic " + Buffer.from(
  (process.env.GSB_USER || "hayashi") + ":" + (process.env.GSB_PASS || "cpjlk54*#spl89")
).toString("base64");
const GSB_CLI   = process.env.GSB_CLIENTE || "cf051147574882010032";
const GSB_TOK   = process.env.GSB_TOKEN   || "$2a$10$BueYcMU8EZboMx3Fy12S8";
const PORT      = process.env.PORT || 3000;

const SB_URL_RAW = process.env.SUPABASE_URL;
const SB_KEY      = process.env.SUPABASE_KEY;
if (!SB_URL_RAW || !SB_KEY) {
  console.warn("ATENÇÃO: defina SUPABASE_URL e SUPABASE_KEY nas env vars do Render.");
}
const SB_HOSTNAME = SB_URL_RAW ? SB_URL_RAW.replace(/^https?:\/\//, "").split("/")[0] : "";

const FILIAIS_PERMITIDAS = ["HGO", "HBA"];

// ── SUPABASE REST HELPER ─────────────────────────────────────
function sbReq(method, table, body, query) {
  return new Promise((resolve, reject) => {
    let path = `/rest/v1/${table}`;
    if (query) path += `?${query}`;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: SB_HOSTNAME,
      path,
      method,
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: method === "POST" ? "return=representation" : "return=minimal",
      },
    };
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`Supabase ${res.statusCode}: ${chunks}`));
        try { resolve(chunks ? JSON.parse(chunks) : null); } catch { resolve(null); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const sbGet    = (table, query) => sbReq("GET", table, null, query);
const sbInsert = (table, body)  => sbReq("POST", table, body);
const sbPatch  = (table, body, query) => sbReq("PATCH", table, body, query);
const sbDelete = (table, query) => sbReq("DELETE", table, null, query);

// ── AUTH / SESSÃO ─────────────────────────────────────────
function sha256(s) { return crypto.createHash("sha256").update(s + "gsb2026").digest("hex"); }
function limparWhats(w) { return (w || "").replace(/\D/g, ""); }

async function getSession(req) {
  const authH = req.headers["authorization"] || "";
  const token = authH.startsWith("Bearer ") ? authH.slice(7) : null;
  if (!token) return null;
  const rows = await sbGet("sessoes", `token=eq.${token}&select=*,usuarios(*)`);
  if (!rows || !rows[0]) return null;
  const sess = rows[0];
  if (new Date(sess.expira_em) < new Date()) return null;
  return sess.usuarios;
}

// ── GSB (GET only) ─────────────────────────────────────────
function gsbGet(nome) {
  return gsbFetch(`/${nome}/${GSB_CLI}/${encodeURIComponent(GSB_TOK)}`);
}
function gsbGetRange(nome, dataInicio, dataFim) {
  return gsbFetch(`/${nome}/${dataInicio}/${dataFim}/${GSB_CLI}/${encodeURIComponent(GSB_TOK)}`);
}
function gsbFetch(gsbPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: GSB_HOST, path: gsbPath, method: "GET", headers: { Authorization: GSB_AUTH } },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}
function formatarDataGSB(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}${mm}${d.getFullYear()}`;
}

// ── CACHE "QUENTE" DOS CADASTROS ──────────────────────────
// Carrega uma vez no início e atualiza em segundo plano — as buscas do usuário
// nunca esperam o GSB responder, só leem o que já está em memória.
let CACHE = {
  produtos: [],       // [{idProduto, nome: "NOMEPRODUTO-VARIEDADE", unidade, idUnidade}]
  filiais: [],        // já filtradas para HGO/HBA
  setores: [],
  atualizadoEm: null,
  atualizando: false,
};

async function atualizarCache() {
  if (CACHE.atualizando) return;
  CACHE.atualizando = true;
  try {
    const [produtos, nomes, variedades, unidades, filiais, setores] = await Promise.all([
      gsbGet("produtos"),
      gsbGet("produtosnomes"),
      gsbGet("produtosvariedades"),
      gsbGet("unidades"),
      gsbGet("filiais"),
      gsbGet("setores"),
    ]);

    const nomeMap = new Map((nomes || []).map((n) => [String(n.idNomeProduto), n.nomeProduto]));
    const varMap = new Map((variedades || []).map((v) => [String(v.idVariedade), v.nomeVariedade]));
    const unidMap = new Map((unidades || []).map((u) => [String(u.idUnidade), u.siglaUnidade || u.nomeUnidade]));

    CACHE.produtos = (produtos || []).map((p) => {
      const nomeBase = nomeMap.get(String(p.idNomeProduto)) || `Produto ${p.idProduto}`;
      const variedade = p.idVariedade ? varMap.get(String(p.idVariedade)) : null;
      const nomeCompleto = variedade ? `${nomeBase}-${variedade}` : nomeBase;
      return {
        idProduto: p.idProduto,
        nome: nomeCompleto,
        idUnidade: p.idUnidade,
        unidade: unidMap.get(String(p.idUnidade)) || "",
      };
    });

    CACHE.filiais = (filiais || []).filter((f) => FILIAIS_PERMITIDAS.includes((f.siglaFilial || "").toUpperCase()));
    CACHE.setores = setores || [];
    CACHE.atualizadoEm = new Date().toISOString();
    console.log(`Cache atualizado: ${CACHE.produtos.length} produtos, ${CACHE.filiais.length} filiais, ${CACHE.setores.length} setores`);
  } catch (e) {
    console.error("Erro ao atualizar cache do GSB:", e.message);
  } finally {
    CACHE.atualizando = false;
  }
}

(async () => {
  await atualizarCache();       // produtos/filiais/setores primeiro
  await atualizarHistorico();   // depois o histórico, já usando os produtos em cache
})();
setInterval(atualizarCache, 6 * 60 * 60 * 1000);       // atualiza a cada 6 horas
setInterval(atualizarHistorico, 30 * 60 * 1000);       // atualiza a cada 30 min

// ── HISTÓRICO DE SOLICITAÇÕES (direto do GSB) ──
let HIST_CACHE = { data: [], atualizadoEm: null, atualizando: false };

async function buscarHistorico(dataInicio, dataFim) {
  const [headers, itens, funcionarios, filiais, cotacoes, cotacoesListas, pedidos, pedidosItens, unidadesFaturamentos, fichas] = await Promise.all([
    gsbGetRange("solicitacoescompras", dataInicio, dataFim),
    gsbGetRange("solicitacoescomprasitens", dataInicio, dataFim),
    gsbGet("funcionarios"),
    gsbGet("filiais"),
    gsbGetRange("cotacoes", dataInicio, dataFim),
    gsbGetRange("cotacoeslistas", dataInicio, dataFim),
    gsbGetRange("pedidoscompras", dataInicio, dataFim),
    gsbGetRange("pedidoscomprasitens", dataInicio, dataFim),
    gsbGet("unidadesfaturamentos"),
    gsbGet("fichas"),
  ]);

  const funcMap = new Map((funcionarios || []).map((f) => [String(f.idFuncionario), f.nome]));
  const filialMap = new Map((filiais || []).map((f) => [String(f.idFilial), f.siglaFilial]));
  const produtoMap = new Map(CACHE.produtos.map((p) => [String(p.idProduto), p]));
  const cotacaoStatusMap = new Map((cotacoes || []).map((c) => [String(c.idCotacao), c.status]));
  const cotacaoInfoMap = new Map((cotacoes || []).map((c) => [String(c.idCotacao), {
    numero: c.numeroCotacao,
    data: c.dataCotacao,
    pessoa: funcMap.get(String(c.idFuncionarioCotador)) || funcMap.get(String(c.idFuncionarioResponsavel)) || null,
  }]));
  const pedidoStatusMap = new Map((pedidos || []).map((p) => [String(p.idPedidoCompra), p.statusPedido]));

  // idUnidadeFaturamento -> idFicha (fornecedor)
  const unidadeFaturamentoParaFicha = new Map((unidadesFaturamentos || []).map((u) => [String(u.idUnidadeFaturamento), u.idFicha]));
  const fichaNomeMap = new Map((fichas || []).map((f) => [String(f.idFicha), f.razao]));
  function fornecedorDoPedido(p) {
    if (!p.idUnidadeFaturamento) return null;
    const idFicha = unidadeFaturamentoParaFicha.get(String(p.idUnidadeFaturamento));
    return idFicha ? fichaNomeMap.get(String(idFicha)) || null : null;
  }

  const pedidoInfoMap = new Map((pedidos || []).map((p) => [String(p.idPedidoCompra), {
    numero: p.numeroPedido,
    data: p.dataPedido,
    pessoa: funcMap.get(String(p.idFuncionarioResponsavel)) || funcMap.get(String(p.idFuncionarioComprador)) || null,
    fornecedor: fornecedorDoPedido(p),
  }]));
  const clParaCotacao = new Map((cotacoesListas || []).map((cl) => [String(cl.idCotacaoLista), cl.idCotacao]));

  // idSolicitacaoCompraItem -> {idCotacao, status}
  const itemParaCotacao = new Map();
  (cotacoesListas || []).forEach((cl) => {
    if (!cl.idSolicitacaoCompraItem) return;
    itemParaCotacao.set(String(cl.idSolicitacaoCompraItem), {
      idCotacao: cl.idCotacao,
      status: cotacaoStatusMap.get(String(cl.idCotacao)) || null,
    });
  });

  // idSolicitacaoCompraItem -> {idPedidoCompra, status, valorUnitario, valorTotal}
  const itemParaPedido = new Map();
  (pedidosItens || []).forEach((pi) => {
    if (!pi.idSolicitacaoCompraItem) return;
    itemParaPedido.set(String(pi.idSolicitacaoCompraItem), {
      idPedidoCompra: pi.idPedidoCompra,
      status: pedidoStatusMap.get(String(pi.idPedidoCompra)) || null,
      valorUnitario: pi.valorUnitario,
      valorTotal: pi.valorProduto,
    });
  });

  const itensPorSolic = {};
  (itens || []).forEach((it) => {
    const st = (it.status || "").toLowerCase();
    const aprovado = st.startsWith("aprovad");
    const aguardando = st.includes("aguardando");
    if (!aprovado && !aguardando) return;
    const prod = produtoMap.get(String(it.idProduto));
    const cot = itemParaCotacao.get(String(it.idSolicitacaoCompraItem)) || null;
    const ped = itemParaPedido.get(String(it.idSolicitacaoCompraItem)) || null;
    const lista = (itensPorSolic[it.idSolicitacaoCompra] = itensPorSolic[it.idSolicitacaoCompra] || []);
    lista.push({
      produto: (prod && prod.nome) || it.descricaoProduto,
      unidade: (prod && prod.unidade) || "",
      quantidade: aprovado ? (it.quantidadeAprovada || it.quantidade) : it.quantidade,
      status: it.status,
      idCotacao: cot ? cot.idCotacao : null,
      cotacaoStatus: cot ? cot.status : null,
      idPedidoCompra: ped ? ped.idPedidoCompra : null,
      pedidoStatus: ped ? ped.status : null,
      valorUnitario: ped ? ped.valorUnitario : null,
      valorTotal: ped ? ped.valorTotal : null,
    });
  });

  function classificar(itensDaSolic) {
    const temPedidoAprovado = itensDaSolic.some((it) => it.pedidoStatus && it.pedidoStatus.toLowerCase().startsWith("aprovad"));
    if (temPedidoAprovado) return "pedido_aprovado";
    const temPedido = itensDaSolic.some((it) => it.idPedidoCompra);
    if (temPedido) return "pedido_aberto";
    const temCotacaoAprovada = itensDaSolic.some((it) => it.cotacaoStatus && it.cotacaoStatus.toLowerCase().startsWith("aprovad"));
    if (temCotacaoAprovada) return "cotacao_aprovada";
    const temCotacao = itensDaSolic.some((it) => it.idCotacao);
    if (temCotacao) return "em_cotacao";
    // sem cotação nem pedido ainda: separa quem já foi aprovado de quem ainda aguarda aprovação
    const todosAprovados = itensDaSolic.every((it) => (it.status || "").toLowerCase().startsWith("aprovad"));
    return todosAprovados ? "aprovada_sem_cotacao" : "aberto";
  }
  function corDoGrupo(grupo) {
    if (["pedido_aprovado", "cotacao_aprovada", "aprovada_sem_cotacao"].includes(grupo)) return "verde";
    return "amarelo";
  }

  const listaSolicitacoes = (headers || [])
    .filter((h) => itensPorSolic[h.idSolicitacaoCompra])
    .map((h) => {
      const itensDaSolic = itensPorSolic[h.idSolicitacaoCompra];
      const grupo = classificar(itensDaSolic);
      const idCotacaoAchado = itensDaSolic.map((it) => it.idCotacao).find(Boolean) || null;
      const idPedidoAchado = itensDaSolic.map((it) => it.idPedidoCompra).find(Boolean) || null;
      const cotInfo = idCotacaoAchado ? cotacaoInfoMap.get(String(idCotacaoAchado)) : null;
      const pedInfo = idPedidoAchado ? pedidoInfoMap.get(String(idPedidoAchado)) : null;
      return {
        idSolicitacaoCompra: h.idSolicitacaoCompra,
        numeroSolicitacao: h.numeroSolicitacao,
        dataSolicitacao: h.dataSolicitacao,
        solicitante: funcMap.get(String(h.idSolicitante)) || `Func. ${h.idSolicitante}`,
        filialSigla: filialMap.get(String(h.idFilial)) || null,
        itens: itensDaSolic,
        grupo,
        cor: corDoGrupo(grupo),
        numeroCotacao: cotInfo ? cotInfo.numero : null,
        dataCotacao: cotInfo ? cotInfo.data : null,
        comprador: cotInfo ? cotInfo.pessoa : null,
        numeroPedido: pedInfo ? pedInfo.numero : null,
        dataPedido: pedInfo ? pedInfo.data : null,
        responsavelPedido: pedInfo ? pedInfo.pessoa : null,
        fornecedorPedido: pedInfo ? pedInfo.fornecedor : null,
        avulso: false,
      };
    });

  // ── Pedidos lançados direto no GSB, sem passar por solicitação/cotação ──
  const itensPorPedido = {};
  (pedidosItens || []).forEach((pi) => {
    (itensPorPedido[pi.idPedidoCompra] = itensPorPedido[pi.idPedidoCompra] || []).push(pi);
  });

  const pedidosAvulsos = (pedidos || [])
    .filter((p) => {
      const itensDoPedido = itensPorPedido[p.idPedidoCompra] || [];
      return itensDoPedido.length > 0 && itensDoPedido.every((pi) => !pi.idSolicitacaoCompraItem);
    })
    .map((p) => {
      const itensDoPedido = itensPorPedido[p.idPedidoCompra];
      const itensFormatados = itensDoPedido.map((pi) => {
        const prod = produtoMap.get(String(pi.idProduto));
        return {
          produto: (prod && prod.nome) || `Produto ${pi.idProduto}`,
          unidade: (prod && prod.unidade) || "",
          quantidade: pi.quantidade,
          valorUnitario: pi.valorUnitario,
          valorTotal: pi.valorProduto,
        };
      });
      const statusAprovado = (p.statusPedido || "").toLowerCase().startsWith("aprovad");
      // se algum item veio de uma cotação (mesmo sem solicitação), resgata os dados da cotação também
      const idCotacaoOrigem = itensDoPedido.map((pi) => pi.idCotacaoLista && clParaCotacao.get(String(pi.idCotacaoLista))).find(Boolean) || null;
      const cotInfo = idCotacaoOrigem ? cotacaoInfoMap.get(String(idCotacaoOrigem)) : null;
      return {
        idSolicitacaoCompra: `pedido-${p.idPedidoCompra}`,
        numeroSolicitacao: null,
        dataSolicitacao: null,
        solicitante: null,
        filialSigla: filialMap.get(String(p.idFilial)) || null,
        itens: itensFormatados,
        grupo: statusAprovado ? "pedido_aprovado" : "pedido_aberto",
        cor: statusAprovado ? "verde" : "amarelo",
        numeroCotacao: cotInfo ? cotInfo.numero : null,
        dataCotacao: cotInfo ? cotInfo.data : null,
        comprador: cotInfo ? cotInfo.pessoa : null,
        numeroPedido: p.numeroPedido,
        dataPedido: p.dataPedido,
        responsavelPedido: funcMap.get(String(p.idFuncionarioResponsavel)) || funcMap.get(String(p.idFuncionarioComprador)) || null,
        fornecedorPedido: fornecedorDoPedido(p),
        avulso: true,
      };
    });

  // ── Cotações criadas direto no GSB, sem vir de uma solicitação ──
  const itensPorCotacaoAvulsa = {};
  (cotacoesListas || []).forEach((cl) => {
    if (cl.idSolicitacaoCompraItem) return; // já tratado dentro da solicitação
    const prod = produtoMap.get(String(cl.idProduto));
    const lista = (itensPorCotacaoAvulsa[cl.idCotacao] = itensPorCotacaoAvulsa[cl.idCotacao] || []);
    lista.push({
      produto: (prod && prod.nome) || `Produto ${cl.idProduto}`,
      unidade: (prod && prod.unidade) || "",
      quantidade: cl.quantidade,
      idCotacaoLista: cl.idCotacaoLista,
    });
  });

  // idCotacaoLista que já virou item de pedido avulso — evita duplicar o mesmo item em dois cards
  const cotacaoListaJaVirouPedidoAvulso = new Set();
  (pedidosItens || []).forEach((pi) => {
    if (!pi.idSolicitacaoCompraItem && pi.idCotacaoLista) cotacaoListaJaVirouPedidoAvulso.add(String(pi.idCotacaoLista));
  });

  const cotacoesAvulsas = (cotacoes || [])
    .map((c) => {
      const itensBrutos = itensPorCotacaoAvulsa[c.idCotacao] || [];
      const itensRestantes = itensBrutos.filter((it) => !cotacaoListaJaVirouPedidoAvulso.has(String(it.idCotacaoLista)));
      return { c, itensRestantes };
    })
    .filter(({ itensRestantes }) => itensRestantes.length > 0)
    .map(({ c, itensRestantes }) => {
      const statusAprovado = (c.status || "").toLowerCase().startsWith("aprovad");
      return {
        idSolicitacaoCompra: `cotacao-${c.idCotacao}`,
        numeroSolicitacao: null,
        dataSolicitacao: null,
        solicitante: null,
        filialSigla: filialMap.get(String(c.idFilial)) || null,
        itens: itensRestantes,
        grupo: statusAprovado ? "cotacao_aprovada" : "em_cotacao",
        cor: statusAprovado ? "verde" : "amarelo",
        numeroCotacao: c.numeroCotacao,
        dataCotacao: c.dataCotacao,
        comprador: funcMap.get(String(c.idFuncionarioCotador)) || funcMap.get(String(c.idFuncionarioResponsavel)) || null,
        numeroPedido: null,
        dataPedido: null,
        responsavelPedido: null,
        avulso: true,
      };
    });

  return listaSolicitacoes
    .concat(pedidosAvulsos)
    .concat(cotacoesAvulsas)
    .sort((a, b) => {
      const da = new Date(a.dataSolicitacao || a.dataCotacao || a.dataPedido || 0);
      const db = new Date(b.dataSolicitacao || b.dataCotacao || b.dataPedido || 0);
      return db - da;
    });
}

async function atualizarHistorico() {
  if (HIST_CACHE.atualizando) return;
  HIST_CACHE.atualizando = true;
  try {
    const fim = new Date();
    const inicio = new Date();
    inicio.setDate(inicio.getDate() - 90);
    HIST_CACHE.data = await buscarHistorico(formatarDataGSB(inicio), formatarDataGSB(fim));
    HIST_CACHE.atualizadoEm = new Date().toISOString();
    console.log(`Histórico atualizado: ${HIST_CACHE.data.length} solicitações (90 dias)`);
  } catch (e) {
    console.error("Erro ao atualizar histórico do GSB:", e.message);
  } finally {
    HIST_CACHE.atualizando = false;
  }
}

// (chamadas de inicialização feitas no bloco async no topo do arquivo)

// ── HELPERS HTTP ───────────────────────────────────────────
function json(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

// ── SERVER ─────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if (req.method === "OPTIONS") return json(res, 200, {});

  try {
    if (req.method === "POST" && p === "/registrar") {
      const body = await readBody(req);
      const whatsClean = limparWhats(body.whatsapp);
      const nome = (body.nome || "").trim();
      const senha = body.senha || "";
      const filial = (body.filial || "").toString().toUpperCase();
      if (!nome || !whatsClean || !senha) return json(res, 400, { error: "Preencha nome, WhatsApp e senha" });
      if (senha.length < 4) return json(res, 400, { error: "Senha muito curta" });
      if (!FILIAIS_PERMITIDAS.includes(filial)) return json(res, 400, { error: "Selecione a filial" });

      const existente = await sbGet("usuarios", `whatsapp=eq.${encodeURIComponent(whatsClean)}`);
      if (existente && existente[0]) return json(res, 409, { error: "Já existe um usuário com esse WhatsApp" });

      await sbInsert("usuarios", {
        nome,
        whatsapp: whatsClean,
        senha_hash: sha256(senha),
        filial,
        status: "pendente",
        admin: false,
      });
      return json(res, 200, { ok: true });
    }

    // ── LOGIN ─────────────────────────────────────────────
    if (req.method === "POST" && p === "/login") {
      const { whatsapp, senha } = await readBody(req);
      const whatsClean = limparWhats(whatsapp);
      const rows = await sbGet("usuarios", `whatsapp=eq.${encodeURIComponent(whatsClean)}`);
      const user = rows && rows[0];
      if (!user || user.senha_hash !== sha256(senha)) return json(res, 401, { error: "WhatsApp ou senha inválidos" });
      if (user.status !== "aprovado") return json(res, 403, { error: "Usuário ainda não aprovado" });
      const token = crypto.randomBytes(24).toString("hex");
      await sbInsert("sessoes", { token, user_id: user.id });
      delete user.senha_hash;
      return json(res, 200, { token, user });
    }

    if (req.method === "GET" && p === "/me") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      delete user.senha_hash;
      return json(res, 200, user);
    }

    // ── CADASTROS (em cache, resposta instantânea) ─────────
    if (req.method === "GET" && p === "/gsb/filiais") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      return json(res, 200, CACHE.filiais);
    }
    if (req.method === "GET" && p === "/gsb/setores") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const idFilial = parsed.query.idFilial;
      const lista = idFilial ? CACHE.setores.filter((s) => String(s.idFilial) === String(idFilial)) : CACHE.setores;
      return json(res, 200, lista);
    }
    if (req.method === "GET" && p === "/gsb/produtos-busca") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const q = (parsed.query.q || "").toString().trim().toLowerCase();
      if (q.length < 2) return json(res, 200, []);
      const resultados = CACHE.produtos.filter((p2) => p2.nome.toLowerCase().includes(q)).slice(0, 30);
      return json(res, 200, resultados);
    }
    if (req.method === "POST" && p === "/gsb/atualizar-cache") {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      atualizarCache();
      return json(res, 200, { ok: true, iniciado: true });
    }

    // ── HISTÓRICO (90 dias por padrão, ou período customizado) ──
    if (req.method === "GET" && p === "/gsb/historico-solicitacoes") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const { inicio, fim } = parsed.query;
      if (inicio || fim) {
        // período customizado: busca ao vivo, não usa o cache padrão de 90 dias
        const dInicio = inicio ? formatarDataGSB(new Date(inicio + "T00:00:00")) : formatarDataGSB(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
        const dFim = fim ? formatarDataGSB(new Date(fim + "T00:00:00")) : formatarDataGSB(new Date());
        try {
          const dados = await buscarHistorico(dInicio, dFim);
          return json(res, 200, dados);
        } catch (e) {
          return json(res, 500, { error: "Erro ao buscar histórico: " + e.message });
        }
      }
      if (Date.now() - new Date(HIST_CACHE.atualizadoEm || 0).getTime() > 30 * 60 * 1000) atualizarHistorico();
      return json(res, 200, HIST_CACHE.data);
    }

    // ── SOLICITAÇÕES DE COMPRA ────────────────────────────
    if (req.method === "GET" && p === "/solicitacoes") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const filtro = user.admin ? "" : `&user_id=eq.${user.id}`;
      const cabecalhos = await sbGet("solicitacoescompras", `select=*${filtro}&order=criado_em.desc`);
      const ids = (cabecalhos || []).map((c) => c.id);
      let itens = [];
      if (ids.length) itens = await sbGet("solicitacoescompras_itens", `solicitacao_id=in.(${ids.join(",")})`);
      const porSolic = {};
      (itens || []).forEach((it) => (porSolic[it.solicitacao_id] = porSolic[it.solicitacao_id] || []).push(it));
      const out = (cabecalhos || []).map((c) => ({ ...c, itens: porSolic[c.id] || [] }));
      return json(res, 200, out);
    }

    if (req.method === "POST" && p === "/solicitacoes") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const body = await readBody(req);
      if (!body.itens || !body.itens.length) return json(res, 400, { error: "Inclua ao menos um item" });

      const cab = await sbInsert("solicitacoescompras", {
        id_filial: body.id_filial || null,
        filial_nome: body.filial_nome || null,
        filial_sigla: body.filial_sigla || null,
        id_setor: body.id_setor || null,
        setor_nome: body.setor_nome || null,
        obs: body.obs || null,
        user_id: user.id,
        solicitante_nome: user.nome,
        status: "pendente",
      });
      const solicitacaoId = cab[0].id;

      const itensPayload = body.itens.map((it) => ({
        solicitacao_id: solicitacaoId,
        id_produto: it.idProduto || null,
        descricao_produto: it.descricaoProduto,
        quantidade: it.quantidade,
        unidade: it.unidade || null,
        id_urgencia: it.idUrgencia || "2",
        urgencia_nome: it.urgenciaNome || "Normal",
      }));
      await sbInsert("solicitacoescompras_itens", itensPayload);

      return json(res, 200, { ok: true, id: solicitacaoId });
    }

    if (req.method === "PUT" && p.startsWith("/solicitacoes/")) {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const id = p.split("/")[2];
      const body = await readBody(req);
      const upd = {};
      if (body.status) upd.status = body.status;
      if (body.id_comprador) { upd.id_comprador = body.id_comprador; upd.comprador_nome = user.nome; }
      if (body.numero_solicitacao_gsb) upd.numero_solicitacao_gsb = body.numero_solicitacao_gsb;
      if (body.id_solicitacao_compra_gsb) upd.id_solicitacao_compra_gsb = body.id_solicitacao_compra_gsb;
      await sbPatch("solicitacoescompras", upd, `id=eq.${id}`);
      return json(res, 200, { ok: true });
    }

    if (req.method === "DELETE" && p.startsWith("/solicitacoes/")) {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const id = p.split("/")[2];
      const filtro = user.admin ? `id=eq.${id}` : `id=eq.${id}&user_id=eq.${user.id}&status=eq.pendente`;
      await sbDelete("solicitacoescompras", filtro);
      return json(res, 200, { ok: true });
    }

    // ── CONFIG (responsável por unidade que recebe as solicitações via WhatsApp) ──
    // Qualquer usuário logado pode LER quem é o responsável da unidade (precisa do nome/whatsapp p/ enviar).
    if (req.method === "GET" && p === "/config/responsavel") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const filial = (parsed.query.filial || "").toString().toUpperCase();
      if (!FILIAIS_PERMITIDAS.includes(filial)) return json(res, 400, { error: "Filial inválida" });
      const chave = `responsavelComprasId_${filial}`;
      const cfgRows = await sbGet("config", `chave=eq.${chave}`);
      const id = cfgRows && cfgRows[0] && cfgRows[0].valor;
      if (!id) return json(res, 200, null);
      const uRows = await sbGet("usuarios", `id=eq.${id}&select=id,nome,whatsapp`);
      return json(res, 200, (uRows && uRows[0]) || null);
    }

    // Só admin pode TROCAR quem é o responsável de cada unidade
    if (req.method === "PUT" && p === "/config/responsavel") {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      const body = await readBody(req);
      const filial = (body.filial || "").toString().toUpperCase();
      if (!FILIAIS_PERMITIDAS.includes(filial)) return json(res, 400, { error: "Filial inválida" });
      const chave = `responsavelComprasId_${filial}`;
      const existe = await sbGet("config", `chave=eq.${chave}`);
      if (existe && existe[0]) {
        await sbPatch("config", { valor: String(body.user_id) }, `chave=eq.${chave}`);
      } else {
        await sbInsert("config", { chave, valor: String(body.user_id) });
      }
      return json(res, 200, { ok: true });
    }

    // ── ADMIN: gestão de usuários (mesma tabela da oficina) ──
    if (req.method === "GET" && p === "/admin/usuarios") {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      const rows = await sbGet("usuarios", `select=id,nome,whatsapp,filial,status,admin&order=nome.asc`);
      return json(res, 200, rows || []);
    }

    if (req.method === "PUT" && p.startsWith("/admin/usuarios/")) {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      const id = p.split("/")[3];
      const body = await readBody(req);
      const upd = {};
      if (body.status) upd.status = body.status;
      if (typeof body.admin === "boolean") upd.admin = body.admin;
      await sbPatch("usuarios", upd, `id=eq.${id}`);
      return json(res, 200, { ok: true });
    }

    if (req.method === "DELETE" && p.startsWith("/admin/usuarios/")) {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      const id = p.split("/")[3];
      await sbDelete("usuarios", `id=eq.${id}`);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Compras proxy rodando na porta ${PORT}`));
