require('./instrument.js');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const {
  criarPagamentoPro, getPayment,
  criarAssinaturaPro, getAssinatura, cancelarAssinatura, getCobrancaAssinatura,
} = require('./mercadopago');
const {
  upgradeUserToPro, getUser,
  salvarAssinaturaPendente, ativarAssinaturaPro, registrarRenovacaoPro,
  downgradeUserToFree, getUserByPreapprovalId,
} = require('./firebase');
const { processarMensagem } = require('./whatsapp');
const { verificarVencimentos } = require('./lembretes');
const { analisarImagem } = require('./scanner');
const { interpretarComando } = require('./assistente');
const { gerarToken, hashSenha, enviarEmailReset, enviarEmailAssinaturaCancelada } = require('./reset');
const { senhaConfere, criarTokenLogin } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// O Railway (e a maioria dos serviços de hospedagem) coloca o servidor atrás
// de um proxy reverso. Isso diz ao Express pra confiar no cabeçalho
// X-Forwarded-For desse proxy, necessário pro rate limiting identificar o
// IP real de cada visitante corretamente.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ============================================================
// RATE LIMITING — protege contra abuso e gasto indevido de API
// ============================================================
// Limite geral: cobre qualquer rota não listada abaixo
const limiteGeral = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
});
app.use(limiteGeral);

// Scanner gasta crédito da API da Anthropic a cada chamada — limite apertado
const limiteScanner = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de escaneamentos atingido. Tente novamente em alguns minutos.' },
});

// Assistente Íris também gasta crédito da API da Anthropic a cada mensagem
const limiteAssistente = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas mensagens para a Íris. Tente novamente em alguns minutos.' },
});

// Recuperação de senha — evita spam de e-mail pro mesmo destinatário
const limiteSenha = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});

// Pagamento/assinatura — moderado, protege contra chamadas repetidas ao Mercado Pago
const limitePagamento = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Fintrack Server',
    version: '1.0.0',
    endpoints: [
      'GET  /health',
      'POST /auth/login',
      'POST /auth/registrar',
      'POST /assinatura/criar',
      'POST /assinatura/cancelar',
      'POST /pagamento/criar',
      'POST /scanner/analisar',
      'POST /assistente/comando',
      'POST /senha/solicitar',
      'POST /senha/redefinir',
      'POST /conta/excluir',
      'POST /webhook/mercadopago',
      'POST /webhook/whatsapp',
      'POST /admin/checar-vencimentos',
    ],
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// DIAGNÓSTICO TEMPORÁRIO — testa só a chave da Anthropic, sem
// nenhuma outra camada envolvida. Remover depois de resolver.
// ============================================================
app.get('/diagnostico/anthropic', async (req, res) => {
  const axios = require('axios');
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'diga apenas "ok"' }],
      },
      {
        headers: {
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );
    res.json({ sucesso: true, resposta: resp.data.content[0].text });
  } catch (err) {
    res.status(err.response ? err.response.status : 500).json({
      sucesso: false,
      status: err.response ? err.response.status : null,
      erroCompleto: err.response ? err.response.data : err.message,
      chaveComecaCom: (process.env.CLAUDE_API_KEY || '').slice(0, 15),
      chaveTerminaCom: (process.env.CLAUDE_API_KEY || '').slice(-6),
      tamanhoChave: (process.env.CLAUDE_API_KEY || '').length,
    });
  }
});

// ============================================================
// CRIAR LINK DE PAGAMENTO MERCADO PAGO
// ============================================================
app.post('/pagamento/criar', limitePagamento, async (req, res) => {
  try {
    const { username, email } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'username obrigatório' });
    }

    // Verifica se usuário existe
    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.role === 'pro') {
      return res.status(400).json({ error: 'Usuário já é Pro' });
    }

    // Cria preferência no Mercado Pago
    const preference = await criarPagamentoPro(username, email);

    res.json({
      success: true,
      preference_id: preference.id,
      init_point: preference.init_point,       // URL de pagamento
      sandbox_init_point: preference.sandbox_init_point, // URL de teste
    });

  } catch (err) {
    console.error('Erro ao criar pagamento:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CRIAR ASSINATURA RECORRENTE (renovação automática mensal)
// ============================================================
app.post('/assinatura/criar', limitePagamento, async (req, res) => {
  try {
    const { username, email } = req.body;

    if (!username || !email) {
      return res.status(400).json({ error: 'username e email são obrigatórios' });
    }

    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.role === 'pro' || user.role === 'admin') {
      return res.status(400).json({ error: 'Usuário já é Pro' });
    }

    // Cria a assinatura no Mercado Pago (usuário autoriza uma vez, cobrança é automática depois)
    const assinatura = await criarAssinaturaPro(username, email);
    await salvarAssinaturaPendente(username, email, assinatura.id);

    res.json({
      success: true,
      preapproval_id: assinatura.id,
      init_point: assinatura.init_point,
    });

  } catch (err) {
    console.error(`Erro ao criar assinatura (username=${req.body.username}, email=${req.body.email}):`, err.message || err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CANCELAR ASSINATURA RECORRENTE — para de cobrar automaticamente
// ============================================================
app.post('/assinatura/cancelar', limitePagamento, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'username obrigatório' });
    }

    const user = await getUser(username);
    if (!user || !user.preapprovalId) {
      return res.status(400).json({ error: 'Este usuário não tem assinatura ativa' });
    }

    await cancelarAssinatura(user.preapprovalId);
    await downgradeUserToFree(username, 'cancelled_by_user');

    res.json({ success: true });

  } catch (err) {
    console.error('Erro ao cancelar assinatura:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WEBHOOK MERCADO PAGO — recebe notificação de pagamento
// ============================================================
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    // MP às vezes manda "type", às vezes "topic" (formato legado) — cobrimos os dois
    const type = req.body.type || req.body.topic;
    const data = req.body.data || { id: req.query['data.id'] || req.query.id };
    console.log('Webhook MP recebido:', type, data?.id);

    // Confirma recebimento imediatamente (MP exige resposta rápida)
    res.status(200).json({ received: true });

    // ---- ASSINATURA CRIADA / ATUALIZADA (autorizada, pausada ou cancelada) ----
    if (type === 'subscription_preapproval' || type === 'preapproval') {
      const assinatura = await getAssinatura(data.id);
      const username = assinatura.external_reference;
      if (!username) {
        console.error('Assinatura sem external_reference:', data.id);
        return;
      }

      if (assinatura.status === 'authorized') {
        await ativarAssinaturaPro(username, data.id);
        console.log(`🎉 ${username} agora é Pro com renovação automática! Assinatura: ${data.id}`);
      } else if (assinatura.status === 'cancelled' || assinatura.status === 'paused') {
        await downgradeUserToFree(username, assinatura.status);
        console.log(`⏸️ Assinatura de ${username} está ${assinatura.status}`);
        try {
          const user = await getUser(username);
          if (user && user.email) {
            await enviarEmailAssinaturaCancelada(user.email, username);
            console.log(`✉️ E-mail de cancelamento enviado para ${username}`);
          }
        } catch (err) {
          console.error(`Erro ao enviar e-mail de cancelamento para ${username}:`, err.message);
        }
      }
      return;
    }

    // ---- COBRANÇA MENSAL RECORRENTE PROCESSADA ----
    if (type === 'subscription_authorized_payment') {
      const cobranca = await getCobrancaAssinatura(data.id);
      console.log('Cobrança recorrente:', cobranca.status, '| preapproval:', cobranca.preapproval_id);

      // Descobre o username a partir da assinatura vinculada
      let username = null;
      const assinatura = await getAssinatura(cobranca.preapproval_id).catch(() => null);
      if (assinatura?.external_reference) {
        username = assinatura.external_reference;
      } else {
        const user = await getUserByPreapprovalId(cobranca.preapproval_id);
        username = user?.username || null;
      }
      if (!username) {
        console.error('Cobrança sem usuário identificável:', data.id);
        return;
      }

      if (cobranca.status === 'approved' || cobranca.status === 'processed') {
        await registrarRenovacaoPro(username, data.id);
        console.log(`🔁 Renovação mensal de ${username} confirmada.`);
      } else if (cobranca.status === 'rejected') {
        // O MP tenta novamente automaticamente por alguns dias antes de cancelar a assinatura.
        // Quando ele desistir de vez, chega um webhook subscription_preapproval com status cancelled.
        console.warn(`⚠️ Cobrança recusada para ${username}. MP tentará novamente automaticamente.`);
      }
      return;
    }

    // ---- FLUXO ANTIGO: PAGAMENTO ÚNICO (mantido para compatibilidade) ----
    if (type === 'payment') {
      const payment = await getPayment(data.id);
      console.log('Payment status:', payment.status, '| ref:', payment.external_reference);

      if (payment.status !== 'approved') return;

      const username = payment.external_reference;
      if (!username) {
        console.error('Pagamento sem external_reference:', data.id);
        return;
      }

      await upgradeUserToPro(username, data.id);
      console.log(`🎉 ${username} agora é Pro! Pagamento: ${data.id}`);
    }

  } catch (err) {
    console.error('Erro no webhook MP:', err.message);
  }
});

// ============================================================
// WEBHOOK WHATSAPP (Z-API)
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    res.status(200).json({ received: true });

    const body = req.body;
    console.log('WhatsApp webhook:', JSON.stringify(body).slice(0, 300));

    // Formato do Whapi.cloud: as mensagens chegam num array, pode vir mais de uma por chamada
    const mensagens = body.messages || [];

    for (const msg of mensagens) {
      if (msg.from_me) continue; // ignora mensagens enviadas por nós mesmos
      if (msg.type !== 'text') continue; // por enquanto só tratamos texto

      const phone = msg.from;
      const mensagem = msg.text && msg.text.body;
      if (!phone || !mensagem) continue;

      await processarMensagem(phone, mensagem);
    }

  } catch (err) {
    console.error('Erro no webhook WhatsApp:', err.message);
  }
});

// ============================================================
// ROTA ADMIN — listar usuários (protegida)
// ============================================================
app.get('/admin/usuarios', async (req, res) => {
  const token = req.headers.authorization;
  if (token !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const { db } = require('./firebase');
  const snap = await db.ref('accounts').once('value');
  const accounts = snap.val() || {};

  const lista = Object.entries(accounts).map(([username, data]) => ({
    username,
    nome: data.n,
    role: data.role || 'free',
    whatsapp: data.whatsapp || null,
    proSince: data.proSince ? new Date(data.proSince).toLocaleDateString('pt-BR') : null,
    subscriptionStatus: data.subscriptionStatus || null,
    lastRenewedAt: data.lastRenewedAt ? new Date(data.lastRenewedAt).toLocaleDateString('pt-BR') : null,
  }));

  res.json({ total: lista.length, usuarios: lista });
});

// ============================================================
// SCANNER (cupom/boleto) — chama a Claude API com a chave do servidor,
// nunca exposta ao navegador. Exclusivo do plano Pro.
// ============================================================
app.post('/scanner/analisar', limiteScanner, async (req, res) => {
  try {
    const { username, base64, mediaType, tipo } = req.body;

    if (!username || !base64 || !tipo) {
      return res.status(400).json({ error: 'username, base64 e tipo são obrigatórios' });
    }

    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    if (user.role !== 'pro' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Scanner é exclusivo do plano Pro' });
    }

    const resultado = await analisarImagem(base64, mediaType || 'image/jpeg', tipo);
    res.json({ success: true, resultado });

  } catch (err) {
    console.error(`Erro no scanner (username=${req.body.username}, tipo=${req.body.tipo}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ASSISTENTE ÍRIS — interpreta comandos em linguagem natural do chat
// dentro do app (registrar lançamentos, consultar saldo/gastos/etc).
// Exclusivo do plano Pro. O servidor só interpreta o comando; quem
// executa a ação (salvar lançamento, calcular saldo) é o app, que já
// tem os dados do usuário carregados.
// ============================================================
app.post('/assistente/comando', limiteAssistente, async (req, res) => {
  try {
    const { username, mensagem, categorias, hoje } = req.body;

    if (!username || !mensagem || typeof mensagem !== 'string' || !mensagem.trim()) {
      return res.status(400).json({ error: 'username e mensagem são obrigatórios' });
    }

    const user = await getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    if (user.role !== 'pro' && user.role !== 'admin') {
      return res.status(403).json({ error: 'A Íris é exclusiva do plano Pro' });
    }

    const dataRef = hoje || new Date().toISOString().slice(0, 10);
    const resultado = await interpretarComando(mensagem.trim(), categorias || {}, dataRef);
    res.json({ resultado });

  } catch (err) {
    console.error(`Erro no assistente Íris (username=${req.body.username}):`, err.message);
    res.status(500).json({ error: 'Não consegui entender agora. Tente novamente.' });
  }
});

// ============================================================
// RECUPERAÇÃO DE SENHA — solicitar e confirmar via e-mail
// ============================================================
app.post('/senha/solicitar', limiteSenha, async (req, res) => {
  // Sempre responde sucesso, mesmo se o usuário não existir ou não tiver
  // e-mail — evita que alguém descubra quais usernames existem no sistema.
  res.json({ success: true });

  try {
    const { username } = req.body;
    if (!username) return;

    // Firebase não aceita ".", "#", "$", "[", "]" em caminhos — se vier assim
    // (por exemplo, alguém digitou o e-mail em vez do usuário), só ignora.
    if (/[.#$\[\]]/.test(username)) {
      console.log(`Solicitação de reset com username inválido (parece e-mail?): ${username}`);
      return;
    }

    const user = await getUser(username);
    if (!user || !user.email) {
      console.log(`Solicitação de reset para conta sem e-mail ou inexistente: ${username}`);
      return;
    }

    const token = gerarToken();
    const { db } = require('./firebase');
    await db.ref(`accounts/${username}`).update({
      resetToken: token,
      resetTokenExp: Date.now() + 60 * 60 * 1000, // 1 hora
    });

    await enviarEmailReset(user.email, username, token);
    console.log(`✅ E-mail de recuperação enviado para ${username}`);
  } catch (err) {
    console.error('Erro ao processar solicitação de reset:', err.message);
  }
});

app.post('/senha/redefinir', limiteSenha, async (req, res) => {
  try {
    const { username, token, novaSenha } = req.body;
    if (!username || !token || !novaSenha) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }
    if (novaSenha.length < 4) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 4 caracteres' });
    }
    if (/[.#$\[\]]/.test(username)) {
      return res.status(400).json({ error: 'Link inválido ou expirado' });
    }

    const user = await getUser(username);
    if (!user || !user.resetToken || user.resetToken !== token) {
      return res.status(400).json({ error: 'Link inválido ou expirado' });
    }
    if (!user.resetTokenExp || Date.now() > user.resetTokenExp) {
      return res.status(400).json({ error: 'Link expirado. Solicite um novo.' });
    }

    const { db } = require('./firebase');
    await db.ref(`accounts/${username}`).update({
      p: hashSenha(novaSenha),
      resetToken: null,
      resetTokenExp: null,
    });

    console.log(`✅ Senha redefinida para ${username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao redefinir senha:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EXCLUIR CONTA — apaga a conta e todos os dados financeiros.
// Exige a senha atual como confirmação. Cancela assinatura ativa
// no Mercado Pago antes de apagar, para não continuar cobrando
// alguém que não tem mais conta.
// ============================================================
// ============================================================
// LOGIN E CADASTRO — verificação real de senha no servidor,
// gerando um token de autenticação do Firebase vinculado ao
// username (uid = username). Substitui o login anônimo.
// ============================================================
app.post('/auth/login', limiteSenha, async (req, res) => {
  try {
    const { username, senha } = req.body;
    if (!username || !senha) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    if (/[.#$\[\]]/.test(username)) {
      return res.status(400).json({ error: 'Usuário ou senha incorretos' });
    }

    const user = await getUser(username);
    if (!user || !senhaConfere(senha, user.p)) {
      return res.status(400).json({ error: 'Usuário ou senha incorretos' });
    }

    const { db } = require('./firebase');
    // Migra silenciosamente senhas antigas em base64 para SHA-256
    if (user.p !== hashSenha(senha)) {
      await db.ref(`accounts/${username}`).update({ p: hashSenha(senha) });
    }

    const token = await criarTokenLogin(username);
    res.json({
      success: true,
      token,
      nome: user.n,
      role: user.role || 'free',
      firstAccess: !!user.firstAccess,
    });
  } catch (err) {
    console.error('Erro no login:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/registrar', limiteSenha, async (req, res) => {
  try {
    const { username, senha, nome } = req.body;
    if (!username || !senha || !nome) {
      return res.status(400).json({ error: 'Preencha todos os campos.' });
    }
    if (/[.#$\[\]]/.test(username)) {
      return res.status(400).json({ error: 'Usuário não pode conter ". # $ [ ]"' });
    }
    if (senha.length < 4) {
      return res.status(400).json({ error: 'Senha muito curta.' });
    }

    const existente = await getUser(username);
    if (existente) {
      return res.status(400).json({ error: 'Usuário já existe.' });
    }

    const { db } = require('./firebase');
    await db.ref(`accounts/${username}`).set({
      n: nome,
      p: hashSenha(senha),
      role: 'free',
      createdAt: Date.now(),
      termsAcceptedAt: Date.now(),
    });

    const token = await criarTokenLogin(username);
    res.json({ success: true, token });
  } catch (err) {
    console.error('Erro no registro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ADMIN CRIAR ACESSO — permite que uma conta admin crie login
// para outra pessoa. Precisa passar pelo servidor porque, com
// as novas regras, ninguém mais escreve na conta de outro
// usuário diretamente do navegador.
// ============================================================
app.post('/admin/criar-acesso', limiteSenha, async (req, res) => {
  try {
    const { adminUsername, nome, username, senha, whatsapp } = req.body;
    if (!adminUsername || !nome || !username || !senha) {
      return res.status(400).json({ error: 'Preencha todos os campos.' });
    }
    if (/[.#$\[\]]/.test(username) || /[.#$\[\]]/.test(adminUsername)) {
      return res.status(400).json({ error: 'Usuário inválido.' });
    }

    const admin = await getUser(adminUsername);
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ error: 'Não autorizado.' });
    }

    const existente = await getUser(username);
    if (existente) {
      return res.status(400).json({ error: 'Usuário já existe.' });
    }

    const { db } = require('./firebase');
    const conta = {
      n: nome,
      p: hashSenha(senha),
      role: 'user',
      firstAccess: true,
      createdBy: adminUsername,
      createdAt: Date.now(),
    };
    if (whatsapp) conta.whatsapp = whatsapp;
    await db.ref(`accounts/${username}`).set(conta);

    console.log(`✅ Acesso criado por ${adminUsername} para ${username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao criar acesso:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/conta/excluir', limiteSenha, async (req, res) => {
  try {
    const { username, senha } = req.body;
    if (!username || !senha) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    if (/[.#$\[\]]/.test(username)) {
      return res.status(400).json({ error: 'Usuário ou senha incorretos' });
    }

    const user = await getUser(username);
    if (!user || user.p !== hashSenha(senha)) {
      return res.status(400).json({ error: 'Usuário ou senha incorretos' });
    }

    // Cancela a assinatura recorrente, se houver, antes de apagar a conta
    if (user.preapprovalId && user.subscriptionStatus === 'authorized') {
      try {
        await cancelarAssinatura(user.preapprovalId);
        console.log(`Assinatura de ${username} cancelada antes da exclusão`);
      } catch (err) {
        console.error(`Erro ao cancelar assinatura de ${username} durante exclusão:`, err.message);
        // segue com a exclusão mesmo assim — não deixa o usuário preso
      }
    }

    const { db } = require('./firebase');
    await db.ref(`accounts/${username}`).remove();
    await db.ref(`users/${username}`).remove();

    console.log(`🗑️ Conta excluída: ${username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao excluir conta:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LEMBRETE DE VENCIMENTO — checagem manual (protegida), útil para testar
// sem esperar o horário agendado
// ============================================================
app.post('/admin/checar-vencimentos', async (req, res) => {
  const token = req.headers.authorization;
  if (token !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  try {
    const total = await verificarVencimentos();
    res.json({ success: true, lembretesEnviados: total });
  } catch (err) {
    console.error('Erro ao checar vencimentos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SENTRY — captura erros não tratados nas rotas
// ============================================================
const Sentry = require('./instrument.js');
Sentry.setupExpressErrorHandler(app);

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 Fintrack Server rodando na porta ${PORT}`);
  console.log(`   MP_ACCESS_TOKEN: ${process.env.MP_ACCESS_TOKEN ? '✅ configurado' : '❌ FALTANDO'}`);
  console.log(`   FIREBASE: ${process.env.FIREBASE_PROJECT_ID ? '✅ configurado' : '❌ FALTANDO'}`);
});

// Roda todo dia às 9h (horário de Brasília) — verifica parcelas vencendo
// em 3 dias ou no próprio dia, e avisa por WhatsApp os usuários Pro.
cron.schedule('0 9 * * *', () => {
  verificarVencimentos().catch((err) => console.error('Erro no cron de vencimentos:', err.message));
}, { timezone: 'America/Sao_Paulo' });
