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
  return new Promise((resolve, reject) => {
    const gsbPath = `/${nome}/${GSB_CLI}/${encodeURIComponent(GSB_TOK)}`;
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

atualizarCache(); // carrega já na subida do servidor
setInterval(atualizarCache, 6 * 60 * 60 * 1000); // atualiza a cada 6 horas

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

    // ── CONFIG (responsável que recebe as solicitações via WhatsApp) ──
    // Qualquer usuário logado pode LER quem é o responsável (precisa do nome/whatsapp p/ enviar).
    if (req.method === "GET" && p === "/config/responsavel") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const cfgRows = await sbGet("config", `chave=eq.responsavelComprasId`);
      const id = cfgRows && cfgRows[0] && cfgRows[0].valor;
      if (!id) return json(res, 200, null);
      const uRows = await sbGet("usuarios", `id=eq.${id}&select=id,nome,whatsapp`);
      return json(res, 200, (uRows && uRows[0]) || null);
    }

    // Só admin pode TROCAR quem é o responsável
    if (req.method === "PUT" && p === "/config/responsavel") {
      const user = await getSession(req);
      if (!user || !user.admin) return json(res, 403, { error: "Somente admin" });
      const body = await readBody(req);
      const existe = await sbGet("config", `chave=eq.responsavelComprasId`);
      if (existe && existe[0]) {
        await sbPatch("config", { valor: String(body.user_id) }, `chave=eq.responsavelComprasId`);
      } else {
        await sbInsert("config", { chave: "responsavelComprasId", valor: String(body.user_id) });
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
