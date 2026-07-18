const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Cria link de pagamento para assinatura Pro
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
          unit_price: 29.0,
        },
      ],
      payer: {
        email: email || undefined,
      },
      external_reference: username, // username do Fintrack para identificar o usuário
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

// Busca dados de um pagamento pelo ID
async function getPayment(paymentId) {
  const payment = new Payment(client);
  return await payment.get({ id: paymentId });
}

module.exports = { criarPagamentoPro, getPayment };
