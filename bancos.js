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
};
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
    const lista = (ac.data.results || []).filter((a) => a.type === tipoConta);
    for (const conta of lista) {
      contas++;
      let page = 1, total = 1;
      while (page <= total && page <= 20) {
        const tr = await axios.get(BASE + '/transactions', {
          headers,
          params: { accountId: conta.id, from: de, to: ate, pageSize: 500, page },
        });
        total = tr.data.totalPages || 1;
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
        page++;
      }
    }
  }
  return { movimentacoes: out, contas, itens: itens.length };
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
};
