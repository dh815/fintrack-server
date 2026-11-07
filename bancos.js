// Conexão bancária (uso pessoal) via Meu Pluggy.
// Variáveis de ambiente (Railway): PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET,
// PLUGGY_ITEM_IDS (ids dos itens conectados, separados por vírgula).
// Somente conta admin autenticada (token do Firebase) pode usar a rota.
const axios = require('axios');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const { getUser } = require('./firebase');

const BASE = 'https://api.pluggy.ai';
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

const limiteBancos = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas buscas. Tente novamente em alguns minutos.' },
});

async function obterApiKey() {
  const r = await axios.post(BASE + '/auth', {
    clientId: process.env.PLUGGY_CLIENT_ID,
    clientSecret: process.env.PLUGGY_CLIENT_SECRET,
  });
  return r.data.apiKey;
}

async function buscarMovimentacoes(de, ate, tipoConta) {
  const itens = (process.env.PLUGGY_ITEM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = { 'X-API-KEY': await obterApiKey() };
  const out = [];
  let contas = 0;
  for (const itemId of itens) {
    const ac = await axios.get(BASE + '/accounts', { headers, params: { itemId } });
    console.log('Pluggy contas do item:', (ac.data.results || []).map((a) => a.type + '/' + (a.subtype || '')).join(', '));
    const lista = (ac.data.results || []).filter((a) => a.type === tipoConta);
    for (const conta of lista) {
      contas++;
      let after = null, voltas = 0;
      do {
        const params = { accountId: conta.id, dateFrom: de, dateTo: ate };
        if (after) params.after = after;
        const tr = await axios.get(BASE + '/v2/transactions', { headers, params });
        const prox = tr.data.next ? new URLSearchParams(String(tr.data.next).replace(/^.*\?/, '')).get('after') : null;
        after = prox || null;
        voltas++;
        console.log('Pluggy transações:', conta.type, conta.subtype || '', 'de', de, 'ate', ate, 'recebidas', (tr.data.results || []).length, 'next', tr.data.next ? 'sim' : 'nao', 'chaves', Object.keys(tr.data).join(','));
        for (const t of tr.data.results || []) {
          const valor = Math.abs(parseFloat(t.amount || 0));
          if (!valor) continue;
          // Conta: valor positivo = entrada. Cartão: sem o campo type, valor positivo = compra.
          const positivo = parseFloat(t.amount) > 0;
          const credito = t.type ? t.type === 'CREDIT' : (tipoConta === 'CREDIT' ? !positivo : positivo);
          out.push({
            fid: 'pluggy:' + t.id,
            date: String(t.date || '').slice(0, 10),
            desc: String(t.description || t.descriptionRaw || 'Movimentação').trim(),
            val: credito ? valor : -valor,
          });
        }
        if (!after) break;
      } while (voltas < 20);
    }
  }
  return { movimentacoes: out, contas, itens: itens.length };
}

function tipoInvestimento(t) {
  const nome = String(t.name || '').toLowerCase();
  if (/poupan/.test(nome)) return 'Poupança';
  if (/tesouro/.test(nome) || /TREASURE/.test(String(t.subtype || ''))) return 'Tesouro Direto';
  if (/criptomoeda|bitcoin/.test(nome) || t.type === 'CRYPTO') return 'Criptomoedas';
  switch (t.type) {
    case 'FIXED_INCOME': return 'Renda Fixa';
    case 'EQUITY': return /11$/.test(String(t.code || t.name || '').trim()) ? 'FIIs' : 'Ações';
    case 'ETF':
    case 'MUTUAL_FUND':
    case 'SECURITY': return 'Renda Variável';
    default: return 'Outros';
  }
}

async function buscarInvestimentos() {
  const itens = (process.env.PLUGGY_ITEM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = { 'X-API-KEY': await obterApiKey() };
  const out = [];
  for (const itemId of itens) {
    let page = 1, total = 1;
    while (page <= total && page <= 10) {
      const r = await axios.get(BASE + '/investments', { headers, params: { itemId, pageSize: 500, page } });
      total = r.data.totalPages || 1;
      console.log('Pluggy investimentos:', 'pagina', page, 'recebidos', (r.data.results || []).length);
      for (const t of r.data.results || []) {
        const saldo = parseFloat(t.balance != null ? t.balance : (t.value != null ? t.value : t.amount));
        const original = parseFloat(t.amountOriginal);
        const lucro = t.amountProfit != null && !isNaN(parseFloat(t.amountProfit))
          ? parseFloat(t.amountProfit)
          : (!isNaN(saldo) && !isNaN(original) ? saldo - original : 0);
        out.push({
          fid: 'pluggy:inv:' + t.id,
          name: String(t.name || 'Investimento').trim(),
          type: tipoInvestimento(t),
          inst: String(t.issuer || (t.institution && t.institution.name) || '').trim(),
          val: isNaN(saldo) ? 0 : Math.round(saldo * 100) / 100,
          yld: Math.round((lucro || 0) * 100) / 100,
          date: String(t.purchaseDate || t.issueDate || t.date || '').slice(0, 10),
          ativo: !t.status || t.status === 'ACTIVE',
        });
      }
      page++;
    }
  }
  return out;
}

module.exports = function montarBancos(app) {
  app.post('/bancos/movimentacoes', limiteBancos, async (req, res) => {
    try {
      if (!process.env.PLUGGY_CLIENT_ID || !process.env.PLUGGY_CLIENT_SECRET || !process.env.PLUGGY_ITEM_IDS) {
        return res.status(503).json({ error: 'Conexão bancária ainda não configurada no servidor.' });
      }
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Não autorizado.' });
      let dec;
      try { dec = await admin.auth().verifyIdToken(token); }
      catch (e) { return res.status(401).json({ error: 'Sessão inválida. Entre de novo.' }); }
      const user = await getUser(dec.uid);
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Recurso disponível só para a conta administradora.' });
      }
      const { de, ate, tipo } = req.body || {};
      if (!DATA_RE.test(de || '') || !DATA_RE.test(ate || '')) {
        return res.status(400).json({ error: 'Período inválido.' });
      }
      const r = await buscarMovimentacoes(de, ate, tipo === 'cartao' ? 'CREDIT' : 'BANK');
      res.json({ success: true, ...r });
    } catch (err) {
      const st = err.response && err.response.status;
      console.error('Erro ao buscar movimentações do banco:', st || '', err.message, (err.config && String(err.config.url || '').replace(/itemId=[^&]*/, 'itemId=…')) || '', JSON.stringify((err.response && err.response.data) || {}).slice(0, 300));
      res.status(502).json({ error: 'Não consegui falar com o serviço do banco agora. Tente de novo em instantes.' });
    }
  });
  app.post('/bancos/investimentos', limiteBancos, async (req, res) => {
    try {
      if (!process.env.PLUGGY_CLIENT_ID || !process.env.PLUGGY_CLIENT_SECRET || !process.env.PLUGGY_ITEM_IDS) {
        return res.status(503).json({ error: 'Conexão bancária ainda não configurada no servidor.' });
      }
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Não autorizado.' });
      let dec;
      try { dec = await admin.auth().verifyIdToken(token); }
      catch (e) { return res.status(401).json({ error: 'Sessão inválida. Entre de novo.' }); }
      const user = await getUser(dec.uid);
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Recurso disponível só para a conta administradora.' });
      }
      const investimentos = await buscarInvestimentos();
      res.json({ success: true, investimentos });
    } catch (err) {
      const st = err.response && err.response.status;
      console.error('Erro ao buscar investimentos do banco:', st || '', err.message, (err.config && String(err.config.url || '').replace(/itemId=[^&]*/, 'itemId=…')) || '', JSON.stringify((err.response && err.response.data) || {}).slice(0, 300));
      res.status(502).json({ error: 'Não consegui falar com o serviço do banco agora. Tente de novo em instantes.' });
    }
  });
};
