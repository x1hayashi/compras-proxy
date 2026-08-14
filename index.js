const http   = require("http");
const https  = require("https");
const url    = require("url");
const crypto = require("crypto");

// ── CONFIG (mesmos valores usados no proxy da oficina) ──────
const GSB_HOST  = "api-normalizada.gsbsoftware.com.br";
const GSB_AUTH  = "Basic " + Buffer.from(
  (process.env.GSB_USER || "hayashi") + ":" + (process.env.GSB_PASS || "cpjlk54*#spl89")
).toString("base64");
const GSB_CLI   = process.env.GSB_CLIENTE || "cf051147574882010032";
const GSB_TOK   = process.env.GSB_TOKEN   || "$2a$10$BueYcMU8EZboMx3Fy12S8";
const PORT      = process.env.PORT || 3000;

const SB_URL    = process.env.SUPABASE_URL;
const SB_KEY    = process.env.SUPABASE_KEY;

if (!SB_URL || !SB_KEY) {
  console.warn("ATENÇÃO: defina SUPABASE_URL e SUPABASE_KEY (mesmas do app da oficina) nas env vars do Render.");
}

// ── SUPABASE REST HELPER ─────────────────────────────────────
function sbReq(method, table, body, query) {
  return new Promise((resolve, reject) => {
    let path = `/rest/v1/${table}`;
    if (query) path += `?${query}`;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: SB_URL.replace(/^https?:\/\//, ""),
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

// ── AUTH / SESSÃO (mesmo esquema do app da oficina) ──────────
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

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

// ── GSB PROXY (GET only, com cache em memória) ────────────────
const cache = new Map(); // path -> {data, ts}
const CACHE_MS = 5 * 60 * 1000; // 5 min

function gsbGet(gsbPath) {
  if (cache.has(gsbPath)) {
    const c = cache.get(gsbPath);
    if (Date.now() - c.ts < CACHE_MS) return Promise.resolve(c.data);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: GSB_HOST, path: gsbPath, method: "GET", headers: { Authorization: GSB_AUTH } },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(chunks);
            cache.set(gsbPath, { data, ts: Date.now() });
            resolve(data);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// intervalo amplo, cadastros mudam pouco
function cadastroPath(nome) { return `/${nome}/${GSB_CLI}/${encodeURIComponent(GSB_TOK)}`; }

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
    // ── LOGIN (reaproveita usuarios da oficina) ──────────────
    if (req.method === "POST" && p === "/login") {
      const { whatsapp, senha } = await readBody(req);
      const rows = await sbGet("usuarios", `whatsapp=eq.${encodeURIComponent(whatsapp)}`);
      const user = rows && rows[0];
      if (!user || user.senha_hash !== sha256(senha)) return json(res, 401, { error: "WhatsApp ou senha inválidos" });
      if (user.status !== "aprovado") return json(res, 403, { error: "Usuário ainda não aprovado" });
      const token = crypto.randomBytes(24).toString("hex");
      await sbInsert("sessoes", { token, user_id: user.id });
      delete user.senha_hash;
      return json(res, 200, { token, user });
    }

    // ── SESSÃO ATUAL ─────────────────────────────────────────
    if (req.method === "GET" && p === "/me") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      delete user.senha_hash;
      return json(res, 200, user);
    }

    // ── CADASTROS DO GSB (cache, só leitura) ─────────────────
    if (req.method === "GET" && p === "/gsb/filiais") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      return json(res, 200, await gsbGet(cadastroPath("filiais")));
    }
    if (req.method === "GET" && p === "/gsb/setores") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      return json(res, 200, await gsbGet(cadastroPath("setores")));
    }
    if (req.method === "GET" && p === "/gsb/funcionarios") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      return json(res, 200, await gsbGet(cadastroPath("funcionarios")));
    }

    // ── BUSCA DE PRODUTO (autocomplete: junta produtos + produtosnomes) ──
    if (req.method === "GET" && p === "/gsb/produtos-busca") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });
      const q = (parsed.query.q || "").toString().trim().toLowerCase();
      if (q.length < 2) return json(res, 200, []);

      const [produtos, nomes] = await Promise.all([
        gsbGet(cadastroPath("produtos")),
        gsbGet(cadastroPath("produtosnomes")),
      ]);
      const nomeMap = new Map((nomes || []).map((n) => [String(n.idNomeProduto), n.nomeProduto]));
      const resultados = (produtos || [])
        .map((prod) => ({
          idProduto: prod.idProduto,
          nome: nomeMap.get(String(prod.idNomeProduto)) || `Produto ${prod.idProduto}`,
          idUnidade: prod.idUnidade,
        }))
        .filter((p2) => p2.nome.toLowerCase().includes(q))
        .slice(0, 30);
      return json(res, 200, resultados);
    }

    // ── SOLICITAÇÕES DE COMPRA (Supabase) ────────────────────
    if (req.method === "GET" && p === "/solicitacoes") {
      const user = await getSession(req);
      if (!user) return json(res, 401, { error: "Não autenticado" });

      const filtro = user.admin ? "" : `&user_id=eq.${user.id}`;
      const cabecalhos = await sbGet("solicitacoescompras", `select=*${filtro}&order=criado_em.desc`);
      const ids = (cabecalhos || []).map((c) => c.id);
      let itens = [];
      if (ids.length) {
        itens = await sbGet("solicitacoescompras_itens", `solicitacao_id=in.(${ids.join(",")})`);
      }
      const porSolic = {};
      (itens || []).forEach((it) => {
        (porSolic[it.solicitacao_id] = porSolic[it.solicitacao_id] || []).push(it);
      });
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
      // só permite apagar a própria solicitação pendente (ou admin apaga qualquer uma)
      const filtro = user.admin ? `id=eq.${id}` : `id=eq.${id}&user_id=eq.${user.id}&status=eq.pendente`;
      await sbDelete("solicitacoescompras", filtro);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Compras proxy rodando na porta ${PORT}`));
