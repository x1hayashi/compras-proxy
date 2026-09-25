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
          try {
            const dados = JSON.parse(chunks);
            // Algumas consultas do GSB retornam um objeto solto (não uma lista) quando só há 1 resultado —
            // normaliza sempre pra lista, já que todo o resto do código espera .map/.filter/.forEach
            resolve(Array.isArray(dados) ? dados : (dados ? [dados] : []));
          } catch (e) {
            reject(new Error(`Falha ao interpretar resposta do GSB em ${gsbPath} (status ${res.statusCode}, ${chunks.length} bytes): ${e.message}`));
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`Falha de rede ao chamar ${gsbPath}: ${e.message}`)));
    req.setTimeout(25000, () => req.destroy(new Error(`Timeout ao chamar ${gsbPath}`)));
    req.end();
  });
}
// Busca segura: se o endpoint falhar (timeout, resposta vazia etc.), não derruba o resto — retorna [] e loga o aviso
async function gsbGetSeguro(promise, nomeParaLog) {
  try {
    return await promise;
  } catch (e) {
    console.warn(`Aviso: falha ao buscar "${nomeParaLog}" — seguindo sem esses dados. Detalhe: ${e.message}`);
    return [];
  }
}
function formatarDataGSB(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}${mm}${d.getFullYear()}`;
}
function formatarDataISO(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function parseDataGSB(s) {
  // aceita "DDMMYYYY" (formato da API) ou "YYYY-MM-DD" (formato de <input type=date>)
  if (/^\d{8}$/.test(s)) {
    return new Date(Number(s.slice(4, 8)), Number(s.slice(2, 4)) - 1, Number(s.slice(0, 2)));
  }
  return new Date(s + "T00:00:00");
}
function somarDias(d, dias) {
  const novo = new Date(d);
  novo.setDate(novo.getDate() + dias);
  return novo;
}
// Converte qualquer valor pra string minúscula com segurança — o GSB às vezes devolve um campo de
// status como algo que não é string (número, objeto), e (x||"").toLowerCase() quebra nesses casos
function strLower(v) {
  if (typeof v === "string") return v.toLowerCase();
  if (v == null) return "";
  try { return String(v).toLowerCase(); } catch { return ""; }
}
// Converte valor monetário no formato brasileiro ("1.234,56") para número, sem quebrar com milhar
function parseValorBR(v) {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  let normalizado;
  if (s.includes(",")) {
    // formato BR: ponto = milhar, vírgula = decimal (ex: "1.234,56")
    normalizado = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(".")) {
    // sem vírgula nenhuma: o GSB às vezes manda esse campo em formato americano
    // (ex: "101790.52"), com o ponto já sendo o separador decimal — não remover
    const partes = s.split(".");
    normalizado = (partes.length === 2 && partes[1].length <= 2) ? s : s.replace(/\./g, "");
  } else {
    normalizado = s;
  }
  const n = Number(normalizado);
  return isNaN(n) ? 0 : n;
}

// ── CACHE "QUENTE" DOS CADASTROS ──────────────────────────
// Carrega uma vez no início e atualiza em segundo plano — as buscas do usuário
// nunca esperam o GSB responder, só leem o que já está em memória.
let CACHE = {
  produtos: [],       // [{idProduto, nome: "NOMEPRODUTO-VARIEDADE", unidade, idUnidade}]
  filiais: [],        // já filtradas para HGO/HBA
  filiaisTodas: [],   // todas as filiais, sem filtro — usado pela tela de Pagamentos
  setores: [],
  unidades: [],       // [{idUnidade, nomeUnidade, siglaUnidade}] — cadastro de unidades do GSB
  funcionarios: [],
  fichas: [],
  unidadesFaturamentos: [],
  tiposMovimento: [],
  atualizadoEm: null,
  atualizando: false,
};

async function atualizarCache() {
  if (CACHE.atualizando) return;
  CACHE.atualizando = true;
  try {
    const [produtos, nomes, variedades, unidades, filiais, setores, funcionarios, fichas, unidadesFaturamentos, tiposMovimento] = await Promise.all([
      gsbGet("produtos"),
      gsbGet("produtosnomes"),
      gsbGet("produtosvariedades"),
      gsbGet("unidades"),
      gsbGet("filiais"),
      gsbGet("setores"),
      gsbGetSeguro(gsbGet("funcionarios"), "funcionarios"),
      gsbGetSeguro(gsbGet("fichas"), "fichas"),
      gsbGetSeguro(gsbGet("unidadesfaturamentos"), "unidadesfaturamentos"),
      gsbGetSeguro(gsbGet("tiposmovimentos"), "tiposmovimentos"),
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
    CACHE.filiaisTodas = filiais || [];
    CACHE.setores = setores || [];
    CACHE.funcionarios = funcionarios || [];
    CACHE.fichas = fichas || [];
    CACHE.unidadesFaturamentos = unidadesFaturamentos || [];
    CACHE.tiposMovimento = tiposMovimento || [];
    CACHE.unidades = (unidades || []).slice().sort((a, b) => (a.siglaUnidade || "").localeCompare(b.siglaUnidade || ""));
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
  await atualizarPagamentos();
})();
setInterval(atualizarCache, 6 * 60 * 60 * 1000);       // atualiza a cada 6 horas
setInterval(atualizarHistorico, 30 * 60 * 1000);       // atualiza a cada 30 min
setInterval(atualizarPagamentos, 30 * 60 * 1000);      // atualiza a cada 30 min

// ── HISTÓRICO DE SOLICITAÇÕES (direto do GSB) ──
let HIST_CACHE = { data: [], atualizadoEm: null, atualizando: false };

async function buscarHistorico(dataInicio, dataFim) {
  // pagamentos costuma ter data de documento bem diferente da data do pedido (parcelas, prazos etc.),
  // então busca numa janela bem mais larga que a do resto, pra não perder pagamento já quitado fora do período pedido
  const dataInicioPg = formatarDataGSB(somarDias(parseDataGSB(dataInicio), -365));
  const dataFimPg = formatarDataGSB(somarDias(parseDataGSB(dataFim), 60));

  let [headers, itens, cotacoes, cotacoesListas, pedidos, pedidosItens, cotacoesFornecedores, cotacoesProdutos, pagamentos, notasComprasItens] = await Promise.all([
    gsbGetSeguro(gsbGetRange("solicitacoescompras", dataInicio, dataFim), "solicitacoescompras"),
    gsbGetSeguro(gsbGetRange("solicitacoescomprasitens", dataInicio, dataFim), "solicitacoescomprasitens"),
    gsbGetSeguro(gsbGetRange("cotacoes", dataInicio, dataFim), "cotacoes"),
    gsbGetSeguro(gsbGetRange("cotacoeslistas", dataInicio, dataFim), "cotacoeslistas"),
    gsbGetSeguro(gsbGetRange("pedidoscompras", dataInicio, dataFim), "pedidoscompras"),
    gsbGetSeguro(gsbGetRange("pedidoscomprasitens", dataInicio, dataFim), "pedidoscomprasitens"),
    gsbGetSeguro(gsbGetRange("cotacoesfornecedores", dataInicio, dataFim), "cotacoesfornecedores"),
    gsbGetSeguro(gsbGetRange("cotacoesprodutos", dataInicio, dataFim), "cotacoesprodutos"),
    gsbGetSeguro(gsbGetRange("pagamentos", dataInicioPg, dataFimPg), "pagamentos"),
    gsbGetSeguro(gsbGetRange("notascomprasitens", dataInicioPg, dataFimPg), "notascomprasitens"),
  ]);
  // listas sem filtro de data (cadastros) já vêm prontas do cache compartilhado, atualizado a cada 6h —
  // evita rebuscar tudo isso do zero a cada detalhe/histórico consultado
  const funcionarios = CACHE.funcionarios;
  const filiais = CACHE.filiaisTodas;
  const unidadesFaturamentos = CACHE.unidadesFaturamentos;
  const fichas = CACHE.fichas;

  // Um pedido/cotação recente pode apontar pra uma solicitação bem mais antiga (prazo de entrega
  // longo, item que ficou meses cotando etc.) que não veio nessa janela de 90 dias. Só nesse caso
  // (raro) refaz a busca de toda a cadeia (solicitação → cotação → pedido) numa janela mais larga —
  // isso evita tanto perder o processo quanto ele aparecer "parado" numa etapa anterior por a
  // cotação/pedido dele também não terem sido buscados na janela maior.
  const idsConhecidos = new Set((itens || []).map((it) => String(it.idSolicitacaoCompraItem)));
  const temOrfao =
    (pedidosItens || []).some((pi) => pi.idSolicitacaoCompraItem && !idsConhecidos.has(String(pi.idSolicitacaoCompraItem))) ||
    (cotacoesListas || []).some((cl) => cl.idSolicitacaoCompraItem && !idsConhecidos.has(String(cl.idSolicitacaoCompraItem)));

  if (temOrfao) {
    const dataInicioAmpliada = formatarDataGSB(somarDias(parseDataGSB(dataInicio), -365));
    [headers, itens, cotacoes, cotacoesListas, cotacoesFornecedores, cotacoesProdutos, pedidos, pedidosItens] = await Promise.all([
      gsbGetSeguro(gsbGetRange("solicitacoescompras", dataInicioAmpliada, dataFim), "solicitacoescompras (busca ampliada)"),
      gsbGetSeguro(gsbGetRange("solicitacoescomprasitens", dataInicioAmpliada, dataFim), "solicitacoescomprasitens (busca ampliada)"),
      gsbGetSeguro(gsbGetRange("cotacoes", dataInicioAmpliada, dataFim), "cotacoes (busca ampliada)"),
      gsbGetSeguro(gsbGetRange("cotacoeslistas", dataInicioAmpliada, dataFim), "cotacoeslistas (busca ampliada)"),
      gsbGetSeguro(gsbGetRange("cotacoesfornecedores", dataInicioAmpliada, dataFim), "cotacoesfornecedores (busca ampliada)"),
      gsbGetSeguro(gsbGetRange("cotacoesprodutos", dataInicioAmpliada, dataFim), "cotacoesprodutos (busca ampliada)"),
      gsbGetSeguro(gsbGetRange("pedidoscompras", dataInicioAmpliada, dataFim), "pedidoscompras (busca ampliada)"),
      gsbGetSeguro(gsbGetRange("pedidoscomprasitens", dataInicioAmpliada, dataFim), "pedidoscomprasitens (busca ampliada)"),
    ]);
    console.log(`Vínculo órfão detectado — refeita a busca inteira de ${dataInicioAmpliada} até ${dataFim} (${(headers||[]).length} solicitações)`);
  }

  const funcMap = new Map((funcionarios || []).map((f) => [String(f.idFuncionario), f.nome]));
  const filialMap = new Map((filiais || []).map((f) => [String(f.idFilial), f.siglaFilial]));
  const produtoMap = new Map(CACHE.produtos.map((p) => [String(p.idProduto), p]));
  const cotacaoStatusMap = new Map((cotacoes || []).map((c) => [String(c.idCotacao), c.status]));
  const cotacaoInfoMap = new Map((cotacoes || []).map((c) => [String(c.idCotacao), {
    numero: c.numeroCotacao,
    data: c.dataCotacao,
    cotador: funcMap.get(String(c.idFuncionarioCotador)) || null,
    responsavel: funcMap.get(String(c.idFuncionarioResponsavel)) || null,
  }]));
  const pedidoStatusMap = new Map((pedidos || []).map((p) => [String(p.idPedidoCompra), p.statusPedido]));

  // idUnidadeFaturamento -> idFicha (fornecedor)
  const unidadeFaturamentoParaFicha = new Map((unidadesFaturamentos || []).map((u) => [String(u.idUnidadeFaturamento), u.idFicha]));
  const fichaNomeMap = new Map((fichas || []).map((f) => [String(f.idFicha), f.razao]));

  // idCotacaoFornecedor -> {idCotacao, idFicha}
  const cotacaoFornecedorMap = new Map((cotacoesFornecedores || []).map((cf) => [String(cf.idCotacaoFornecedor), { idCotacao: cf.idCotacao, idFicha: cf.idFicha, observacao: cf.observacao || null }]));
  // "{idCotacao}_{idProduto}" -> {valorUnitario, valorTotal, idFicha} do item aprovado (fornecedor vencedor)
  const itemCotacaoPreco = new Map();
  // "{idCotacao}_{idProduto}" -> [{idFicha, fornecedor, valorUnitario, valorTotal, aprovado}] — todas as propostas (vencedoras e não vencedoras)
  const itemCotacaoTodasPropostas = new Map();
  (cotacoesProdutos || []).forEach((cp) => {
    const cf = cotacaoFornecedorMap.get(String(cp.idCotacaoFornecedor));
    if (!cf) return;
    const key = `${cf.idCotacao}_${cp.idProduto}`;
    const aprovado = strLower(cp.statusAprovado).startsWith("aprovad");
    const proposta = {
      idFicha: cf.idFicha,
      fornecedor: fichaNomeMap.get(String(cf.idFicha)) || null,
      valorUnitario: cp.valorUnitario,
      valorTotal: cp.valorProduto,
      aprovado,
      observacao: cf.observacao || null,
      marcaObservacao: cp.marcaObservacao || null,
    };
    const lista = (itemCotacaoTodasPropostas.get(key) || []);
    lista.push(proposta);
    itemCotacaoTodasPropostas.set(key, lista);
    if (aprovado) {
      itemCotacaoPreco.set(key, { valorUnitario: cp.valorUnitario, valorTotal: cp.valorProduto, idFicha: cf.idFicha });
    }
  });
  function fornecedorDoPedido(p) {
    if (!p.idUnidadeFaturamento) return null;
    const idFicha = unidadeFaturamentoParaFicha.get(String(p.idUnidadeFaturamento));
    return idFicha ? fichaNomeMap.get(String(idFicha)) || null : null;
  }

  // idPedidoCompra -> {pago, valorAberto, valorTotal, temRegistro}
  // idPedidoCompraItem -> idPedidoCompra (pra resolver pagamento vinculado só pela nota fiscal)
  const pedidoCompraItemParaPedido = new Map((pedidosItens || []).map((pi) => [String(pi.idPedidoCompraItem), pi.idPedidoCompra]));
  // idNotaCompra -> Set de idPedidoCompra cobertos por essa nota (via itens da nota)
  const notaParaPedidos = new Map();
  (notasComprasItens || []).forEach((ni) => {
    if (!ni.idPedidoCompraItem) return;
    const idPedido = pedidoCompraItemParaPedido.get(String(ni.idPedidoCompraItem));
    if (!idPedido) return;
    const chave = String(ni.idNotaCompra);
    const lista = notaParaPedidos.get(chave) || new Set();
    lista.add(String(idPedido));
    notaParaPedidos.set(chave, lista);
  });

  const pagamentoPorPedido = new Map();
  (pagamentos || []).forEach((pg) => {
    // um pagamento pode estar vinculado direto ao pedido, ou só à nota fiscal de compra
    // (que por sua vez está vinculada ao pedido através dos itens dela)
    const pedidosAtingidos = new Set();
    if (pg.idPedidoCompra) pedidosAtingidos.add(String(pg.idPedidoCompra));
    if (pg.idNotaCompra) {
      const viaNota = notaParaPedidos.get(String(pg.idNotaCompra));
      if (viaNota) viaNota.forEach((idPed) => pedidosAtingidos.add(idPed));
    }
    pedidosAtingidos.forEach((chave) => {
      const atual = pagamentoPorPedido.get(chave) || { valorAberto: 0, valorTotal: 0, temRegistro: false };
      atual.valorAberto += parseValorBR(pg.valorAberto);
      atual.valorTotal += parseValorBR(pg.valor);
      atual.temRegistro = true;
      pagamentoPorPedido.set(chave, atual);
    });
  });
  function statusPagamentoDoPedido(idPedidoCompra) {
    const info = pagamentoPorPedido.get(String(idPedidoCompra));
    if (!info || !info.temRegistro) return { pago: false, valorAberto: null, valorTotal: null };
    return { pago: info.valorAberto <= 0.01, valorAberto: info.valorAberto, valorTotal: info.valorTotal };
  }

  const pedidoInfoMap = new Map((pedidos || []).map((p) => {
    const statusPg = statusPagamentoDoPedido(p.idPedidoCompra);
    return [String(p.idPedidoCompra), {
      numero: p.numeroPedido,
      data: p.dataPedido,
      comprador: funcMap.get(String(p.idFuncionarioComprador)) || null,
      responsavel: funcMap.get(String(p.idFuncionarioResponsavel)) || null,
      fornecedor: fornecedorDoPedido(p),
      pagamentoPago: statusPg.pago,
      pagamentoValorAberto: statusPg.valorAberto,
    }];
  }));
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

  // idSolicitacaoCompraItem -> {idPedidoCompra, status, valorUnitario, valorTotal, quantidadePedida, quantidadeEntregue}
  const itemParaPedido = new Map();
  (pedidosItens || []).forEach((pi) => {
    if (!pi.idSolicitacaoCompraItem) return;
    itemParaPedido.set(String(pi.idSolicitacaoCompraItem), {
      idPedidoCompra: pi.idPedidoCompra,
      status: pedidoStatusMap.get(String(pi.idPedidoCompra)) || null,
      valorUnitario: pi.valorUnitario,
      valorTotal: pi.valorProduto,
      quantidadePedida: pi.quantidade,
      quantidadeEntregue: pi.quantidadeEntregue,
    });
  });

  const itensPorSolic = {};
  (itens || []).forEach((it) => {
    const st = strLower(it.status);
    const aprovado = st.startsWith("aprovad");
    const aguardando = st.includes("aguardando");
    const cot = itemParaCotacao.get(String(it.idSolicitacaoCompraItem)) || null;
    const ped = itemParaPedido.get(String(it.idSolicitacaoCompraItem)) || null;
    // só ignora o item se ele realmente não tem status relevante NEM progrediu pra cotação/pedido —
    // um texto de status diferente do esperado não pode fazer um pedido já existente sumir do app
    if (!aprovado && !aguardando && !cot && !ped) return;
    const prod = produtoMap.get(String(it.idProduto));
    const precoCot = cot ? itemCotacaoPreco.get(`${cot.idCotacao}_${it.idProduto}`) : null;
    const propostasCot = cot ? (itemCotacaoTodasPropostas.get(`${cot.idCotacao}_${it.idProduto}`) || []) : [];
    const lista = (itensPorSolic[it.idSolicitacaoCompra] = itensPorSolic[it.idSolicitacaoCompra] || []);
    lista.push({
      produto: (prod && prod.nome) || it.descricaoProduto,
      unidade: (prod && prod.unidade) || "",
      quantidade: aprovado ? (it.quantidadeAprovada || it.quantidade) : it.quantidade,
      status: it.status,
      idCotacao: cot ? cot.idCotacao : null,
      cotacaoStatus: cot ? cot.status : null,
      cotacaoValorUnitario: precoCot ? precoCot.valorUnitario : null,
      cotacaoValorTotal: precoCot ? precoCot.valorTotal : null,
      cotacaoIdFicha: precoCot ? precoCot.idFicha : null,
      propostasCotacao: propostasCot,
      idPedidoCompra: ped ? ped.idPedidoCompra : null,
      pedidoStatus: ped ? ped.status : null,
      valorUnitario: ped ? ped.valorUnitario : null,
      valorTotal: ped ? ped.valorTotal : null,
      pedidoQuantidadePedida: ped ? ped.quantidadePedida : null,
      pedidoQuantidadeEntregue: ped ? ped.quantidadeEntregue : null,
    });
  });

  function classificar(itensDaSolic) {
    const itensAprovados = itensDaSolic.filter((it) => strLower(it.pedidoStatus).startsWith("aprovad"));
    if (itensAprovados.length) {
      const todosEntregues = itensAprovados.every((it) => {
        const pedida = Number(it.pedidoQuantidadePedida || 0);
        const entregue = Number(it.pedidoQuantidadeEntregue || 0);
        return pedida > 0 && entregue >= pedida;
      });
      if (!todosEntregues) return "pedido_aprovado_aberto";
      const idPedido = itensAprovados.map((it) => it.idPedidoCompra).find(Boolean);
      const statusPg = statusPagamentoDoPedido(idPedido);
      return statusPg.pago ? "pedido_aprovado_concluido" : "pedido_aguardando_pagamento";
    }
    const temPedido = itensDaSolic.some((it) => it.idPedidoCompra);
    if (temPedido) return "pedido_aberto";
    const temCotacaoAprovada = itensDaSolic.some((it) => strLower(it.cotacaoStatus).startsWith("aprovad"));
    if (temCotacaoAprovada) return "cotacao_aprovada";
    const temCotacao = itensDaSolic.some((it) => it.idCotacao);
    if (temCotacao) return "em_cotacao";
    // sem cotação nem pedido ainda: separa quem já foi aprovado de quem ainda aguarda aprovação
    const todosAprovados = itensDaSolic.every((it) => strLower(it.status).startsWith("aprovad"));
    return todosAprovados ? "aprovada_sem_cotacao" : "aberto";
  }
  function corDoGrupo(grupo) {
    if (["pedido_aprovado_concluido", "pedido_aprovado_aberto", "cotacao_aprovada", "aprovada_sem_cotacao"].includes(grupo)) return "verde";
    return "amarelo";
  }

  const listaSolicitacoes = [];
  (headers || []).forEach((h) => {
    const itensDaSolic = itensPorSolic[h.idSolicitacaoCompra];
    if (!itensDaSolic) return;

    // Uma mesma solicitação pode virar mais de um pedido (itens aprovados para fornecedores
    // diferentes). Agrupa os itens pelo pedido a que pertencem, pra cada pedido virar seu
    // próprio card — sem sumir com nenhum deles.
    const porPedido = {};
    itensDaSolic.forEach((it) => {
      const chave = it.idPedidoCompra ? `p${it.idPedidoCompra}` : "__sem_pedido__";
      (porPedido[chave] = porPedido[chave] || []).push(it);
    });

    Object.entries(porPedido).forEach(([chave, itensGrupo]) => {
      const grupo = classificar(itensGrupo);
      const idCotacaoAchado = itensGrupo.map((it) => it.idCotacao).find(Boolean) || null;
      const idPedidoAchado = chave === "__sem_pedido__" ? null : chave.slice(1);
      const cotInfo = idCotacaoAchado ? cotacaoInfoMap.get(String(idCotacaoAchado)) : null;
      const pedInfo = idPedidoAchado ? pedidoInfoMap.get(String(idPedidoAchado)) : null;
      const idFichaCotacao = itensGrupo.map((it) => it.cotacaoIdFicha).find(Boolean) || null;
      let corSolic = corDoGrupo(grupo);
      if (grupo === "pedido_aprovado_aberto" && pedInfo && pedInfo.pagamentoPago) corSolic = "vermelho";
      listaSolicitacoes.push({
        idSolicitacaoCompra: idPedidoAchado ? `${h.idSolicitacaoCompra}-p${idPedidoAchado}` : h.idSolicitacaoCompra,
        numeroSolicitacao: h.numeroSolicitacao,
        dataSolicitacao: h.dataSolicitacao,
        solicitante: funcMap.get(String(h.idSolicitante)) || `Func. ${h.idSolicitante}`,
        filialSigla: filialMap.get(String(h.idFilial)) || null,
        itens: itensGrupo,
        grupo,
        cor: corSolic,
        numeroCotacao: cotInfo ? cotInfo.numero : null,
        dataCotacao: cotInfo ? cotInfo.data : null,
        cotador: cotInfo ? cotInfo.cotador : null,
        responsavelCotacao: cotInfo ? cotInfo.responsavel : null,
        idFichaCotacao,
        fornecedorCotacao: idFichaCotacao ? fichaNomeMap.get(String(idFichaCotacao)) || null : null,
        numeroPedido: pedInfo ? pedInfo.numero : null,
        dataPedido: pedInfo ? pedInfo.data : null,
        compradorPedido: pedInfo ? pedInfo.comprador : null,
        responsavelPedido: pedInfo ? pedInfo.responsavel : null,
        fornecedorPedido: pedInfo ? pedInfo.fornecedor : null,
        pagamentoPago: pedInfo ? pedInfo.pagamentoPago : null,
        pagamentoValorAberto: pedInfo ? pedInfo.pagamentoValorAberto : null,
        avulso: false,
      });
    });
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
          quantidadeEntregue: pi.quantidadeEntregue,
        };
      });
      const statusAprovado = strLower(p.statusPedido).startsWith("aprovad");
      const todosEntregues = statusAprovado && itensDoPedido.every((pi) => {
        const pedida = Number(pi.quantidade || 0);
        const entregue = Number(pi.quantidadeEntregue || 0);
        return pedida > 0 && entregue >= pedida;
      });
      const statusPg = statusPagamentoDoPedido(p.idPedidoCompra);
      let grupo;
      if (!statusAprovado) grupo = "pedido_aberto";
      else if (!todosEntregues) grupo = "pedido_aprovado_aberto";
      else grupo = statusPg.pago ? "pedido_aprovado_concluido" : "pedido_aguardando_pagamento";
      let corPedido;
      if (grupo === "pedido_aberto" || grupo === "pedido_aguardando_pagamento") corPedido = "amarelo";
      else if (grupo === "pedido_aprovado_aberto") corPedido = statusPg.pago ? "vermelho" : "verde";
      else corPedido = "verde";
      // se algum item veio de uma cotação (mesmo sem solicitação), resgata os dados da cotação também
      const idCotacaoOrigem = itensDoPedido.map((pi) => pi.idCotacaoLista && clParaCotacao.get(String(pi.idCotacaoLista))).find(Boolean) || null;
      const cotInfo = idCotacaoOrigem ? cotacaoInfoMap.get(String(idCotacaoOrigem)) : null;
      const idFichaCotacao = idCotacaoOrigem
        ? (itensDoPedido.map((pi) => {
            const preco = itemCotacaoPreco.get(`${idCotacaoOrigem}_${pi.idProduto}`);
            return preco ? preco.idFicha : null;
          }).find(Boolean) || null)
        : null;
      return {
        idSolicitacaoCompra: `pedido-${p.idPedidoCompra}`,
        numeroSolicitacao: null,
        dataSolicitacao: null,
        solicitante: null,
        filialSigla: filialMap.get(String(p.idFilial)) || null,
        itens: itensFormatados,
        grupo,
        cor: corPedido,
        numeroCotacao: cotInfo ? cotInfo.numero : null,
        dataCotacao: cotInfo ? cotInfo.data : null,
        cotador: cotInfo ? cotInfo.cotador : null,
        responsavelCotacao: cotInfo ? cotInfo.responsavel : null,
        idFichaCotacao,
        fornecedorCotacao: idFichaCotacao ? fichaNomeMap.get(String(idFichaCotacao)) || null : null,
        numeroPedido: p.numeroPedido,
        dataPedido: p.dataPedido,
        compradorPedido: funcMap.get(String(p.idFuncionarioComprador)) || null,
        responsavelPedido: funcMap.get(String(p.idFuncionarioResponsavel)) || null,
        fornecedorPedido: fornecedorDoPedido(p),
        pagamentoPago: statusPg.pago,
        pagamentoValorAberto: statusPg.valorAberto,
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
      idProduto: cl.idProduto,
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
      const statusAprovado = strLower(c.status).startsWith("aprovad");
      const itensComPreco = itensRestantes.map((it) => {
        const preco = itemCotacaoPreco.get(`${c.idCotacao}_${it.idProduto}`);
        return {
          ...it,
          cotacaoValorUnitario: preco ? preco.valorUnitario : null,
          cotacaoValorTotal: preco ? preco.valorTotal : null,
          cotacaoIdFicha: preco ? preco.idFicha : null,
          propostasCotacao: itemCotacaoTodasPropostas.get(`${c.idCotacao}_${it.idProduto}`) || [],
        };
      });
      const idFichaCotacao = itensComPreco.map((it) => it.cotacaoIdFicha).find(Boolean) || null;
      return {
        idSolicitacaoCompra: `cotacao-${c.idCotacao}`,
        numeroSolicitacao: null,
        dataSolicitacao: null,
        solicitante: null,
        filialSigla: filialMap.get(String(c.idFilial)) || null,
        itens: itensComPreco,
        grupo: statusAprovado ? "cotacao_aprovada" : "em_cotacao",
        cor: statusAprovado ? "verde" : "amarelo",
        numeroCotacao: c.numeroCotacao,
        dataCotacao: c.dataCotacao,
        cotador: funcMap.get(String(c.idFuncionarioCotador)) || null,
        responsavelCotacao: funcMap.get(String(c.idFuncionarioResponsavel)) || null,
        idFichaCotacao,
        fornecedorCotacao: idFichaCotacao ? fichaNomeMap.get(String(idFichaCotacao)) || null : null,
        numeroPedido: null,
        dataPedido: null,
        compradorPedido: null,
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

// ── PAGAMENTOS EM ABERTO (semana atual) ─────────────────────
let PAGAMENTOS_CACHE = { data: [], atualizadoEm: null, atualizando: false };

function parseDataBR(s) {
  if (!s) return null;
  const parte = s.split(" ")[0];
  const partes = parte.split("/").map(Number);
  if (partes.length !== 3 || !partes[0] || !partes[1] || !partes[2]) return null;
  return new Date(partes[2], partes[1] - 1, partes[0]);
}
function inicioFimSemanaAtual() {
  const hoje = new Date();
  const diaSemana = hoje.getDay(); // 0=domingo
  const diffSegunda = diaSemana === 0 ? -6 : 1 - diaSemana;
  const segunda = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + diffSegunda);
  const domingo = new Date(segunda.getFullYear(), segunda.getMonth(), segunda.getDate() + 6, 23, 59, 59, 999);
  return { inicio: segunda, fim: domingo };
}
// Período padrão da tela de Pagamentos: hoje até 6 dias à frente (7 dias, incluindo hoje).
function intervaloPadraoPagamentos() {
  const hoje = new Date();
  const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const fim = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + 6, 23, 59, 59, 999);
  return { inicio, fim };
}

let PAGAMENTOS_PROMISE_ATUAL = null;

function atualizarPagamentos() {
  if (PAGAMENTOS_CACHE.atualizando) return PAGAMENTOS_PROMISE_ATUAL;
  PAGAMENTOS_CACHE.atualizando = true;
  PAGAMENTOS_PROMISE_ATUAL = (async () => {
  try {
    const inicio = new Date();
    inicio.setDate(inicio.getDate() - 1095); // ~3 anos pra trás — cobre vencimento renegociado de título antigo
    const fimBusca = new Date();
    fimBusca.setDate(fimBusca.getDate() + 120);
    const dIni = formatarDataGSB(inicio);
    const dFim = formatarDataGSB(fimBusca);

    const [pagamentos, filiais, fichas, tiposMovimento, pedidos, cotacoes] = await Promise.all([
      gsbGetSeguro(gsbGetRange("pagamentos", dIni, dFim), "pagamentos"),
      gsbGetSeguro(gsbGet("filiais"), "filiais"),
      gsbGetSeguro(gsbGet("fichas"), "fichas"),
      gsbGetSeguro(gsbGet("tiposmovimentos"), "tiposmovimentos"),
      gsbGetSeguro(gsbGetRange("pedidoscompras", dIni, dFim), "pedidoscompras"),
      gsbGetSeguro(gsbGetRange("cotacoes", dIni, dFim), "cotacoes"),
    ]);

    // gsbGetSeguro nunca lança erro (devolve [] em falha) — mas um [] em "pagamentos" quase
    // certamente é uma falha temporária de rede/timeout, não "zero pagamentos em 3 anos" de verdade.
    // Se acontecer, mantém o cache anterior em vez de substituir por um resultado vazio.
    if (!pagamentos || pagamentos.length === 0) {
      throw new Error("busca de pagamentos veio vazia (provável falha temporária do GSB) — mantendo cache anterior");
    }
    if (!filiais || filiais.length === 0) {
      throw new Error("busca de filiais veio vazia (provável falha temporária do GSB) — mantendo cache anterior");
    }

    const filialMap = new Map((filiais || []).map((f) => [String(f.idFilial), f.siglaFilial]));
    const fichaMap = new Map((fichas || []).map((f) => [String(f.idFicha), f.razao]));
    const movMap = new Map((tiposMovimento || []).map((m) => [String(m.idTipoMovimento), m.descricaoMovimento]));
    const pedidoMap = new Map((pedidos || []).map((pd) => [String(pd.idPedidoCompra), pd]));
    const cotacaoNumeroMap = new Map((cotacoes || []).map((c) => [String(c.idCotacao), c.numeroCotacao]));

    // Cache guarda TODOS os pagamentos em aberto (sem filtrar por período) — o filtro de data é
    // aplicado na hora da requisição, pra permitir trocar o intervalo visualizado sem refazer a
    // busca no GSB. Pagamentos mostra TODAS as filiais da empresa (diferente do resto do app, que
    // só trata HGO/HBA).
    PAGAMENTOS_CACHE.data = (pagamentos || [])
      .filter((pg) => parseValorBR(pg.valorAberto) > 0)
      .filter((pg) => !!parseDataBR(pg.novoVencimento || pg.dataVencimento))
      .map((pg) => {
        const pedido = pg.idPedidoCompra ? pedidoMap.get(String(pg.idPedidoCompra)) : null;
        return {
          idPagamento: pg.idPagamento,
          siglaFilial: filialMap.get(String(pg.idFilial)) || null,
          fornecedor: fichaMap.get(String(pg.idFicha)) || null,
          sacado: fichaMap.get(String(pg.idFichaSacado)) || null,
          valorAberto: parseValorBR(pg.valorAberto),
          valorAbertoBruto: pg.valorAberto,
          tipoMovimento: movMap.get(String(pg.idTipoMovimento)) || null,
          observacao: pg.observacao || null,
          novoVencimento: pg.novoVencimento || pg.dataVencimento || null,
          idPedidoCompra: pg.idPedidoCompra || null,
          numeroPedido: pedido ? pedido.numeroPedido : null,
          idCotacao: pedido ? pedido.idCotacao : null,
          numeroCotacao: pedido && pedido.idCotacao ? cotacaoNumeroMap.get(String(pedido.idCotacao)) : null,
          dataPedido: pedido ? pedido.dataPedido : null,
        };
      })
      .sort((a, b) => parseDataBR(a.novoVencimento) - parseDataBR(b.novoVencimento));

    PAGAMENTOS_CACHE.atualizadoEm = new Date().toISOString();
    console.log(`Pagamentos em aberto atualizados: ${PAGAMENTOS_CACHE.data.length} no total (todos os vencimentos em aberto, filtro de período aplicado na consulta)`);
  } catch (e) {
    console.error("Erro ao atualizar pagamentos:", e.message);
  } finally {
    PAGAMENTOS_CACHE.atualizando = false;
  }
  })();
  return PAGAMENTOS_PROMISE_ATUAL;
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
    if (req.method === "GET" && p === "/gsb/unidades") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      return json(res, 200, CACHE.unidades);
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
      const podeVerFinanceiro = !!(user.admin || user.acesso_financeiro);
      function removerDadosFinanceiros(lista) {
        if (podeVerFinanceiro) return lista;
        return (lista || []).map((s) => {
          const copia = { ...s };
          delete copia.pagamentoPago;
          delete copia.pagamentoValorAberto;
          return copia;
        });
      }
      const { inicio, fim } = parsed.query;
      if (inicio || fim) {
        // período customizado: busca ao vivo, não usa o cache padrão de 90 dias
        const dInicio = inicio ? formatarDataGSB(new Date(inicio + "T00:00:00")) : formatarDataGSB(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
        const dFim = fim ? formatarDataGSB(new Date(fim + "T00:00:00")) : formatarDataGSB(new Date());
        try {
          const dados = await buscarHistorico(dInicio, dFim);
          return json(res, 200, removerDadosFinanceiros(dados));
        } catch (e) {
          return json(res, 500, { error: "Erro ao buscar histórico: " + e.message });
        }
      }
      if (Date.now() - new Date(HIST_CACHE.atualizadoEm || 0).getTime() > 30 * 60 * 1000) atualizarHistorico();
      return json(res, 200, removerDadosFinanceiros(HIST_CACHE.data));
    }

    // ── PAGAMENTOS EM ABERTO (semana atual) — só quem tem acesso financeiro ──
    // ── DIAGNÓSTICO: por que a lista de pagamentos está vindo vazia ──
    if (req.method === "GET" && p === "/admin/debug-pagamentos") {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      try {
        const inicio = new Date();
        inicio.setDate(inicio.getDate() - 1095);
        const fimBusca = new Date();
        fimBusca.setDate(fimBusca.getDate() + 120);
        const dIni = formatarDataGSB(inicio);
        const dFim = formatarDataGSB(fimBusca);

        const [pagamentos, filiais, fichas] = await Promise.all([
          gsbGetSeguro(gsbGetRange("pagamentos", dIni, dFim), "pagamentos"),
          gsbGetSeguro(gsbGet("filiais"), "filiais"),
          gsbGetSeguro(gsbGet("fichas"), "fichas"),
        ]);
        const filialMap = new Map((filiais || []).map((f) => [String(f.idFilial), f.siglaFilial]));
        const fichaMap = new Map((fichas || []).map((f) => [String(f.idFicha), f.razao]));
        const { inicio: segunda, fim: domingo } = inicioFimSemanaAtual();

        const totalBruto = (pagamentos || []).length;
        const comValorAberto = (pagamentos || []).filter((pg) => parseValorBR(pg.valorAberto) > 0);
        const comVencimentoNaSemana = comValorAberto.filter((pg) => {
          const venc = parseDataBR(pg.novoVencimento || pg.dataVencimento);
          return venc && venc >= segunda && venc <= domingo;
        });
        const comFilialPermitida = comVencimentoNaSemana; // Pagamentos não filtra mais por filial — mostra tudo
        const soHgoHba = comVencimentoNaSemana.filter((pg) =>
          FILIAIS_PERMITIDAS.includes((filialMap.get(String(pg.idFilial)) || "").toUpperCase())
        );

        const maioresValores = [...comFilialPermitida]
          .sort((a, b) => parseValorBR(b.valorAberto) - parseValorBR(a.valorAberto))
          .slice(0, 8)
          .map((pg) => ({
            idPagamento: pg.idPagamento,
            fornecedor: fichaMap.get(String(pg.idFicha)) || null,
            valorAbertoBruto: pg.valorAberto,
            valorAbertoInterpretado: parseValorBR(pg.valorAberto),
            valorBruto: pg.valor,
            novoValorBruto: pg.novoValor,
          }));

        return json(res, 200, {
          janelaBuscada: `${dIni} até ${dFim}`,
          semanaAtual: `${formatarDataGSB(segunda)} até ${formatarDataGSB(domingo)}`,
          cacheAtual: { atualizadoEm: PAGAMENTOS_CACHE.atualizadoEm, quantidadeNoCache: PAGAMENTOS_CACHE.data.length },
          funil: {
            totalPagamentosBrutos: totalBruto,
            comValorAbertoMaiorQueZero: comValorAberto.length,
            comVencimentoNaSemanaAtual: comVencimentoNaSemana.length,
            totalTodasFiliais: comFilialPermitida.length,
            dosQuaisSoHgoHba: soHgoHba.length,
          },
          amostraSemFiltro: (pagamentos || []).slice(0, 3).map((pg) => ({
            idPagamento: pg.idPagamento, idFilial: pg.idFilial, valorAberto: pg.valorAberto,
            novoVencimento: pg.novoVencimento, dataVencimento: pg.dataVencimento,
          })),
          maioresValoresDaSemana: maioresValores,
        });
      } catch (e) {
        return json(res, 500, { error: "Erro: " + e.message });
      }
    }

    if (req.method === "GET" && p === "/gsb/pagamentos-abertos") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      if (!user.admin && !user.acesso_financeiro) return json(res, 403, { error: "Sem acesso financeiro" });
      if (!PAGAMENTOS_CACHE.atualizadoEm) {
        // primeira vez desde que o servidor subiu — espera terminar em vez de responder vazio
        await atualizarPagamentos();
      } else if (Date.now() - new Date(PAGAMENTOS_CACHE.atualizadoEm).getTime() > 30 * 60 * 1000) {
        atualizarPagamentos(); // já tem algo em cache; atualiza em segundo plano sem travar a resposta
      }

      const { inicio, fim } = parsed.query;
      let dataInicio, dataFim;
      if (inicio || fim) {
        dataInicio = inicio ? new Date(inicio + "T00:00:00") : intervaloPadraoPagamentos().inicio;
        dataFim = fim ? new Date(fim + "T23:59:59.999") : intervaloPadraoPagamentos().fim;
      } else {
        ({ inicio: dataInicio, fim: dataFim } = intervaloPadraoPagamentos());
      }

      const filtrados = PAGAMENTOS_CACHE.data.filter((pg) => {
        const venc = parseDataBR(pg.novoVencimento);
        return venc && venc >= dataInicio && venc <= dataFim;
      });

      return json(res, 200, {
        periodoInicio: formatarDataISO(dataInicio),
        periodoFim: formatarDataISO(dataFim),
        dados: filtrados,
      });
    }

    // ── DETALHE DE UM PEDIDO ESPECÍFICO (aberto a partir da tela de Pagamentos) ──
    if (req.method === "GET" && p === "/gsb/detalhe-pedido") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      if (!user.admin && !user.acesso_financeiro) return json(res, 403, { error: "Sem acesso financeiro" });
      const idPedidoCompra = (parsed.query.id || "").toString();
      if (!idPedidoCompra) return json(res, 400, { error: "Informe ?id=" });
      const dataRef = (parsed.query.data || "").toString();
      try {
        let dIni, dFim;
        let dataValida = null;
        if (dataRef) {
          // já sabemos a data exata do pedido (veio da tela de Pagamentos) — busca só perto dela,
          // bem mais rápido. Se a solicitação de origem for muito mais antiga, a própria busca
          // ampliada (órfão) do buscarHistorico já resolve isso sozinha.
          const dataParte = dataRef.split(" ")[0].split("T")[0]; // remove hora, se vier junto (ex: "2026-09-02 00:00:00")
          const d = new Date(dataParte + "T00:00:00");
          if (!isNaN(d.getTime())) dataValida = d;
        }
        if (dataValida) {
          dIni = formatarDataGSB(somarDias(dataValida, -90));
          dFim = formatarDataGSB(somarDias(dataValida, 15));
        } else {
          const fim = new Date();
          const inicio = new Date();
          inicio.setDate(inicio.getDate() - 730);
          dIni = formatarDataGSB(inicio);
          dFim = formatarDataGSB(fim);
        }
        const dados = await buscarHistorico(dIni, dFim);
        const encontrado = dados.find(
          (s) => s.itens.some((it) => String(it.idPedidoCompra) === idPedidoCompra) || s.idSolicitacaoCompra === `pedido-${idPedidoCompra}`
        );
        if (!encontrado) return json(res, 404, { error: "Detalhe não encontrado nessa janela de datas" });
        return json(res, 200, encontrado);
      } catch (e) {
        return json(res, 500, { error: "Erro ao buscar detalhe: " + e.message });
      }
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
      if (!body.data_necessidade) return json(res, 400, { error: "Escolha a data que precisa dos itens" });

      const cab = await sbInsert("solicitacoescompras", {
        id_filial: body.id_filial || null,
        filial_nome: body.filial_nome || null,
        filial_sigla: body.filial_sigla || null,
        id_setor: body.id_setor || null,
        setor_nome: body.setor_nome || null,
        obs: body.obs || null,
        data_necessidade: body.data_necessidade,
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
        link_produto: it.linkProduto || null,
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
    // ── DIAGNÓSTICO: por que um pedido específico não aparece no app ──
    if (req.method === "GET" && p === "/admin/debug-pedido") {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      const numero = (parsed.query.numero || "").toString().trim();
      if (!numero) return json(res, 400, { error: "Informe ?numero=" });

      const fim = new Date();
      const inicio = new Date();
      inicio.setDate(inicio.getDate() - 730); // 2 anos, bem largo, só pra achar o registro
      const dIni = formatarDataGSB(inicio);
      const dFim = formatarDataGSB(fim);

      try {
        const [pedidos, pedidosItens, itensSolic, headers, filiais] = await Promise.all([
          gsbGetRange("pedidoscompras", dIni, dFim),
          gsbGetRange("pedidoscomprasitens", dIni, dFim),
          gsbGetRange("solicitacoescomprasitens", dIni, dFim),
          gsbGetRange("solicitacoescompras", dIni, dFim),
          gsbGet("filiais"),
        ]);

        const filialMap = new Map((filiais || []).map((f) => [String(f.idFilial), f.siglaFilial]));
        const pedidosAchados = (pedidos || []).filter((p2) => String(p2.numeroPedido) === numero);

        const detalhe = pedidosAchados.map((p2) => {
          const itensDoPedido = (pedidosItens || []).filter((pi) => String(pi.idPedidoCompra) === String(p2.idPedidoCompra));
          const itensComOrigem = itensDoPedido.map((pi) => {
            const itemSolic = pi.idSolicitacaoCompraItem
              ? (itensSolic || []).find((is) => String(is.idSolicitacaoCompraItem) === String(pi.idSolicitacaoCompraItem))
              : null;
            const solicHeader = itemSolic
              ? (headers || []).find((h) => String(h.idSolicitacaoCompra) === String(itemSolic.idSolicitacaoCompra))
              : null;
            return {
              idProduto: pi.idProduto,
              quantidade: pi.quantidade,
              quantidadeEntregue: pi.quantidadeEntregue,
              idSolicitacaoCompraItem: pi.idSolicitacaoCompraItem || null,
              statusDoItemNaSolicitacao: itemSolic ? itemSolic.status : (pi.idSolicitacaoCompraItem ? "⚠️ item não encontrado na janela de 2 anos" : "sem vínculo (avulso)"),
              solicitacao: solicHeader ? { numero: solicHeader.numeroSolicitacao, data: solicHeader.dataSolicitacao, idFilial: solicHeader.idFilial } : null,
            };
          });
          return {
            idPedidoCompra: p2.idPedidoCompra,
            numeroPedido: p2.numeroPedido,
            statusPedido: p2.statusPedido,
            dataPedido: p2.dataPedido,
            idFilial: p2.idFilial,
            siglaFilial: filialMap.get(String(p2.idFilial)) || "⚠️ não é HGO/HBA — por isso não aparece no app",
            itens: itensComOrigem,
          };
        });

        return json(res, 200, {
          numeroBuscado: numero,
          janelaBuscada: `${dIni} até ${dFim}`,
          encontrados: detalhe.length,
          pedidos: detalhe,
        });
      } catch (e) {
        return json(res, 500, { error: "Erro ao investigar: " + e.message });
      }
    }

    if (req.method === "GET" && p === "/admin/debug-cotacao") {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      const numero = (parsed.query.numero || "").toString().trim();
      if (!numero) return json(res, 400, { error: "Informe ?numero= (número da cotação)" });

      const fim = new Date();
      const inicio = new Date();
      inicio.setDate(inicio.getDate() - 730);
      const dIni = formatarDataGSB(inicio);
      const dFim = formatarDataGSB(fim);

      try {
        const [cotacoes, cotacoesFornecedores, cotacoesProdutos, fichas] = await Promise.all([
          gsbGetRange("cotacoes", dIni, dFim),
          gsbGetRange("cotacoesfornecedores", dIni, dFim),
          gsbGetRange("cotacoesprodutos", dIni, dFim),
          gsbGet("fichas"),
        ]);

        const fichaNomeMap = new Map((fichas || []).map((f) => [String(f.idFicha), f.razao]));
        const cotAchadas = (cotacoes || []).filter((c) => String(c.numeroCotacao) === numero);

        const detalhe = cotAchadas.map((c) => {
          const fornecedoresDaCot = (cotacoesFornecedores || []).filter((cf) => String(cf.idCotacao) === String(c.idCotacao));
          const fornecedoresComItens = fornecedoresDaCot.map((cf) => {
            const itensDoFornecedor = (cotacoesProdutos || []).filter((cp) => String(cp.idCotacaoFornecedor) === String(cf.idCotacaoFornecedor));
            return {
              idCotacaoFornecedor: cf.idCotacaoFornecedor,
              idFicha: cf.idFicha,
              fornecedor: fichaNomeMap.get(String(cf.idFicha)) || null,
              observacao: cf.observacao || null,
              // todas as chaves cruas de um item de exemplo, pra ver se o nome do campo bate com o esperado
              chavesCrasDoItem: itensDoFornecedor[0] ? Object.keys(itensDoFornecedor[0]) : [],
              itensRaw: itensDoFornecedor.map((cp) => ({
                idProduto: cp.idProduto,
                numeroItem: cp.numeroItem,
                valorUnitario: cp.valorUnitario,
                statusAprovado: cp.statusAprovado,
                marcaObservacao: cp.marcaObservacao,
                // variações de nome que o GSB poderia estar usando, pra comparar
                MarcaObservacao: cp.MarcaObservacao,
                marca_observacao: cp.marca_observacao,
                marcaobservacao: cp.marcaobservacao,
              })),
            };
          });
          return {
            idCotacao: c.idCotacao,
            numeroCotacao: c.numeroCotacao,
            dataCotacao: c.dataCotacao,
            fornecedores: fornecedoresComItens,
          };
        });

        return json(res, 200, {
          numeroBuscado: numero,
          janelaBuscada: `${dIni} até ${dFim}`,
          encontrados: detalhe.length,
          cotacoes: detalhe,
        });
      } catch (e) {
        return json(res, 500, { error: "Erro ao investigar: " + e.message });
      }
    }

    if (req.method === "GET" && p === "/admin/usuarios") {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      const rows = await sbGet("usuarios", `select=id,nome,whatsapp,filial,status,admin,acesso_financeiro&order=nome.asc`);
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
      if (typeof body.acesso_financeiro === "boolean") upd.acesso_financeiro = body.acesso_financeiro;
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
