const axios = require('axios');
const { MercadoPagoConfig, Preference, Payment, PreApproval } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const PRO_PRECO = 29.0;

// ============================================================
// ASSINATURA RECORRENTE (Preapproval) — cobrança automática mensal
// ============================================================

// Cria uma assinatura recorrente. O usuário é redirecionado ao init_point,
// autoriza o pagamento uma única vez e o Mercado Pago cobra sozinho todo mês.
async function criarAssinaturaPro(username, email) {
  const preapproval = new PreApproval(client);

  const result = await preapproval.create({
    body: {
      reason: 'Fintrack Pro — Assinatura Mensal',
      external_reference: username, // usado pra identificar o usuário nos webhooks
      payer_email: email,
      back_url: process.env.FINTRACK_URL,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: PRO_PRECO,
        currency_id: 'BRL',
      },
    },
  });

  return result; // contém id, init_point, status ('pending' até o usuário autorizar)
}

// Busca uma assinatura (preapproval) pelo ID — usado no webhook pra saber o status atual
async function getAssinatura(id) {
  const preapproval = new PreApproval(client);
  return await preapproval.get({ id });
}

// Cancela a assinatura recorrente no Mercado Pago (para de cobrar o cliente)
async function cancelarAssinatura(id) {
  const preapproval = new PreApproval(client);
  return await preapproval.update({ id, body: { status: 'cancelled' } });
}

// Busca uma cobrança individual gerada por uma assinatura recorrente
// (não existe classe dedicada no SDK ainda, então chamamos a API direto)
async function getCobrancaAssinatura(id) {
  const resp = await axios.get(`https://api.mercadopago.com/authorized_payments/${id}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
  });
  return resp.data;
}

// ============================================================
// PAGAMENTO ÚNICO (legado — mantido apenas para compatibilidade)
// ============================================================
async function criarPagamentoPro(username, email) {
  const preference = new Preference(client);

  const result = await preference.create({
    body: {
      items: [
        {
          id: 'fintrack-pro-mensal',
          title: 'Fintrack Pro — Acesso Mensal',
          description: 'Controle financeiro inteligente com IA',
          quantity: 1,
          currency_id: 'BRL',
          unit_price: PRO_PRECO,
        },
      ],
      payer: {
        email: email || undefined,
      },
      external_reference: username,
      back_urls: {
        success: `${process.env.FINTRACK_URL}?pagamento=sucesso`,
        failure: `${process.env.FINTRACK_URL}?pagamento=falha`,
        pending: `${process.env.FINTRACK_URL}?pagamento=pendente`,
      },
      auto_return: 'approved',
      notification_url: `${process.env.APP_URL}/webhook/mercadopago`,
      statement_descriptor: 'FINTRACK PRO',
    },
  });

  return result;
}

async function getPayment(paymentId) {
  const payment = new Payment(client);
  return await payment.get({ id: paymentId });
}

module.exports = {
  criarAssinaturaPro,
  getAssinatura,
  cancelarAssinatura,
  getCobrancaAssinatura,
  criarPagamentoPro,
  getPayment,
};
